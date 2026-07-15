import { randomUUID } from 'node:crypto';
import type {
  KubernetesLogScope,
  KubernetesLogState,
  KubernetesPortForwardState,
  KubernetesTerminalState,
  KubernetesTerminalOutput,
} from '../../shared/types';
import type {
  KubernetesClient,
  KubernetesPodDeploymentLogTargets,
  KubernetesPodExecHandle,
  KubernetesPodLogHandle,
  KubernetesPortForwardHandle,
} from './kubernetesClient';

const INITIAL_LOG_TAIL_LINES = 500;
const MAXIMUM_LOG_LINES = 2_000;
const MAXIMUM_DEPLOYMENT_LOG_PODS = 50;
const MAXIMUM_PORT_FORWARDS = 10;
const MAXIMUM_TERMINAL_OUTPUT_CHUNK_LENGTH = 16_384;
const SHELL_FALLBACKS = ['/bin/sh', 'ash', 'bash'] as const;
const LOG_TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?:\s|$)/;

export interface KubernetesPodInteractionTarget {
  namespace: string;
  podName: string;
  container: string;
}

export interface KubernetesPortForwardInput {
  targetKind: 'pod' | 'service';
  namespace: string;
  targetName: string;
  remotePort: number;
  localPort?: number;
}

export interface PodInteractionManagerOptions {
  client: () => KubernetesClient;
  createId?: () => string;
}

interface LogStream {
  generation: number;
  scopeGeneration: number;
  podName: string;
  handle?: KubernetesPodLogHandle;
  closeRequested: boolean;
  handleClosed: boolean;
  resumeSkipLine?: string;
}

interface OlderLogLoad {
  generation: number;
  scopeGeneration: number;
  handle?: KubernetesPodLogHandle;
  closeRequested: boolean;
  handleClosed: boolean;
}

interface LogSession {
  state: KubernetesLogState;
  input: KubernetesPodInteractionTarget;
  pageGeneration: number;
  allGeneration: number;
  closed: boolean;
  nextGeneration: number;
  scopeGeneration: number;
  streams: Map<string, LogStream>;
  lastRawLines: Map<string, string>;
  aggregateLines: AggregateLogLine[];
  aggregateSequence: number;
  deploymentTargets?: KubernetesPodDeploymentLogTargets;
  olderLoads: Set<OlderLogLoad>;
  olderLoad?: Promise<KubernetesLogState>;
}

interface AggregateLogLine {
  display: string;
  podName: string;
  timestamp?: number;
  sequence: number;
}

interface LogScopeSnapshot {
  state: KubernetesLogState;
  lastRawLines: Map<string, string>;
  aggregateLines: AggregateLogLine[];
  aggregateSequence: number;
  deploymentTargets?: KubernetesPodDeploymentLogTargets;
}

interface TerminalAttempt {
  generation: number;
  shellIndex: number;
  handle?: KubernetesPodExecHandle;
  handleClosed: boolean;
  closeRequested: boolean;
  statusFailure?: Error;
  retrying: boolean;
  normalClose: boolean;
}

interface TerminalSession {
  state: KubernetesTerminalState;
  pageGeneration: number;
  allGeneration: number;
  closed: boolean;
  finalStateEmitted: boolean;
  nextGeneration: number;
  handle?: KubernetesPodExecHandle;
  attempt?: TerminalAttempt;
}

interface PortForwardSession {
  state: KubernetesPortForwardState;
  allGeneration: number;
  closed: boolean;
  handle?: KubernetesPortForwardHandle;
  handleClosed: boolean;
}

function copyLogState(state: KubernetesLogState): KubernetesLogState {
  return {
    ...state,
    lines: [...state.lines],
    ...(state.deployment ? { deployment: { ...state.deployment } } : {}),
  };
}

function copyDeploymentTargets(
  targets: KubernetesPodDeploymentLogTargets | undefined
): KubernetesPodDeploymentLogTargets | undefined {
  return targets
    ? { name: targets.name, pods: targets.pods.map((pod) => ({ ...pod })) }
    : undefined;
}

function copyTerminalState(state: KubernetesTerminalState): KubernetesTerminalState {
  return { ...state };
}

function copyPortForwardState(state: KubernetesPortForwardState): KubernetesPortForwardState {
  return { ...state };
}

function splitCompleteLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function timestampFromLogLine(value: string): string | undefined {
  const match = LOG_TIMESTAMP_PREFIX.exec(value);
  if (!match) {
    return undefined;
  }
  const timestamp = new Date(match[1]);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function aggregateDisplayLine(podName: string, value: string): string {
  const timestamp = LOG_TIMESTAMP_PREFIX.exec(value);
  if (!timestamp) {
    return `[${podName}] ${value}`;
  }
  return `${timestamp[1]} [${podName}] ${value.slice(timestamp[0].length)}`;
}

function aggregateTimestamp(value: string): number | undefined {
  const timestamp = timestampFromLogLine(value);
  if (!timestamp) return undefined;
  const milliseconds = new Date(timestamp).getTime();
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

function compareAggregateLogLines(left: AggregateLogLine, right: AggregateLogLine): number {
  if (left.timestamp !== undefined && right.timestamp !== undefined && left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  if (left.timestamp !== undefined && right.timestamp === undefined) return -1;
  if (left.timestamp === undefined && right.timestamp !== undefined) return 1;
  return left.podName.localeCompare(right.podName) || left.sequence - right.sequence;
}

/**
 * Finds the newest, longest contiguous prefix of `retained` in a bounded log
 * snapshot. A single log line is not a safe anchor: identical messages can
 * legitimately occur many times. Selecting the maximal sequence match makes
 * the prefix before it the only portion safe to prepend.
 */
function findNewestRetainedOverlapStart(received: readonly string[], retained: readonly string[]): number {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < received.length; start += 1) {
    let length = 0;
    while (
      length < retained.length
      && start + length < received.length
      && received[start + length] === retained[length]
    ) {
      length += 1;
    }
    if (length > bestLength || (length === bestLength && length > 0 && start > bestStart)) {
      bestStart = start;
      bestLength = length;
    }
  }
  return bestStart;
}

export function appendBoundedLogLines(
  existing: string[],
  incoming: string[],
  maximum = MAXIMUM_LOG_LINES
): string[] {
  if (!Number.isInteger(maximum) || maximum < 0) {
    throw new Error('Kubernetes log line maximum must be a non-negative integer.');
  }
  const appended = [...existing, ...incoming.flatMap(splitCompleteLines)];
  return maximum === 0 ? [] : appended.slice(-maximum);
}

export function shellFallbacks(): readonly ['/bin/sh', 'ash', 'bash'] {
  return SHELL_FALLBACKS;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`Kubernetes ${label} is required.`);
  }
}

function assertPort(value: number, label: 'remote' | 'local', allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new Error(`Kubernetes ${label} port must be an integer between ${minimum} and 65535.`);
  }
}

function closedBefore(message: string): Error {
  return new Error(`Kubernetes ${message} was closed before it could open.`);
}

/**
 * Owns all page-scoped Pod streams and Context-scoped port forwards. A
 * generation is captured before every asynchronous open so page/context
 * disposal can invalidate it before a client handle arrives.
 */
export class PodInteractionManager {
  private readonly logs = new Map<string, LogSession>();
  private readonly terminals = new Map<string, TerminalSession>();
  private readonly forwards = new Map<string, PortForwardSession>();
  private readonly createId: () => string;
  private readonly logListeners = new Set<(state: KubernetesLogState) => void>();
  private readonly terminalListeners = new Set<(state: KubernetesTerminalState) => void>();
  private readonly terminalOutputListeners = new Set<(output: KubernetesTerminalOutput) => void>();
  private pageGeneration = 0;
  private allGeneration = 0;

  public constructor(private readonly options: PodInteractionManagerOptions) {
    this.createId = options.createId ?? randomUUID;
  }

  public onLogChanged(listener: (state: KubernetesLogState) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  public onTerminalChanged(listener: (state: KubernetesTerminalState) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  public onTerminalOutput(listener: (output: KubernetesTerminalOutput) => void): () => void {
    this.terminalOutputListeners.add(listener);
    return () => this.terminalOutputListeners.delete(listener);
  }

  public async openLogs(input: KubernetesPodInteractionTarget): Promise<KubernetesLogState> {
    this.validatePodTarget(input);
    const sessionId = this.createId();
    const session: LogSession = {
      state: {
        sessionId,
        podName: input.podName,
        namespace: input.namespace,
        container: input.container,
        lines: [],
        following: true,
        hasOlder: true,
        scope: 'pod',
        revision: 0,
      },
      input: { ...input },
      pageGeneration: this.pageGeneration,
      allGeneration: this.allGeneration,
      closed: false,
      nextGeneration: 0,
      scopeGeneration: 0,
      streams: new Map(),
      lastRawLines: new Map(),
      aggregateLines: [],
      aggregateSequence: 0,
      olderLoads: new Set(),
    };
    this.logs.set(sessionId, session);
    try {
      const pendingDeployment = this.resolveDeploymentTargets(session);
      const deployment = pendingDeployment ? await pendingDeployment : undefined;
      if (deployment) {
        session.deploymentTargets = deployment;
        session.state.scope = 'deployment';
        session.state.deployment = { name: deployment.name, podCount: deployment.pods.length };
        session.state.hasOlder = false;
      }
      await this.openCurrentLogStreams(session, true, session.scopeGeneration);
      this.emitLog(session, false);
      return copyLogState(session.state);
    } catch (error) {
      if (this.logs.get(sessionId) === session) {
        this.logs.delete(sessionId);
        session.closed = true;
      }
      await this.closeLogStreams([...session.streams.values()]).catch(() => undefined);
      throw error;
    }
  }

  public async loadOlderLogs(sessionId: string): Promise<KubernetesLogState> {
    const session = this.requireLog(sessionId);
    if (session.olderLoad) {
      return copyLogState(await session.olderLoad);
    }

    const load = this.loadOlderLogSnapshot(session);
    session.olderLoad = load;
    try {
      return await load;
    } finally {
      if (session.olderLoad === load) {
        session.olderLoad = undefined;
      }
    }
  }

  private async loadOlderLogSnapshot(session: LogSession): Promise<KubernetesLogState> {
    if (session.state.scope !== 'pod') {
      session.state.hasOlder = false;
      return copyLogState(session.state);
    }
    const retainedAtStart = [...session.state.lines];
    if (retainedAtStart.length === 0) {
      session.state.hasOlder = false;
      this.emitLog(session);
      return copyLogState(session.state);
    }

    const tailLines = Math.min(MAXIMUM_LOG_LINES, retainedAtStart.length + INITIAL_LOG_TAIL_LINES);
    const pending: OlderLogLoad = {
      generation: ++session.nextGeneration,
      scopeGeneration: session.scopeGeneration,
      closeRequested: false,
      handleClosed: false,
    };
    session.olderLoads.add(pending);
    const received: string[] = [];
    try {
      const handle = await this.options.client().openPodLog({
        ...session.input,
        tailLines,
        follow: false,
      }, {
        onLine: (line) => {
          if (this.isCurrentOlderLoad(session, pending)) {
            received.push(...splitCompleteLines(line));
          }
        },
      });
      pending.handle = handle;
      if (!this.isCurrentOlderLoad(session, pending)) {
        await this.closeOlderLoad(pending);
        throw new Error('Kubernetes log session was closed before it could load older logs.');
      }
      await handle.completed;
      if (!this.isCurrentOlderLoad(session, pending)) {
        throw new Error('Kubernetes log session was closed before it could load older logs.');
      }

      const overlapStart = findNewestRetainedOverlapStart(received, retainedAtStart);
      const older = overlapStart > 0 ? received.slice(0, overlapStart) : [];
      if (older.length > 0) {
        // The current stream may have appended while this bounded snapshot was
        // loading. Prefix only the lines before the captured anchor, then keep
        // the current buffer intact so newer follow lines are never replaced.
        session.state.lines = appendBoundedLogLines([], [...older, ...session.state.lines]);
      }
      session.state.hasOlder = older.length > 0
        && session.state.lines.length < MAXIMUM_LOG_LINES
        && received.length >= tailLines;
      this.emitLog(session);
      return copyLogState(session.state);
    } finally {
      session.olderLoads.delete(pending);
      await this.closeOlderLoad(pending);
    }
  }

  public async setLogFollowing(sessionId: string, following: boolean): Promise<KubernetesLogState> {
    const session = this.requireLog(sessionId);
    if (!following) {
      if (!session.state.following) {
        return copyLogState(session.state);
      }
      session.scopeGeneration += 1;
      session.state.following = false;
      this.emitLog(session);
      const streams = this.detachLogStreams(session);
      await this.closeLogStreams(streams).catch(() => undefined);
      return copyLogState(session.state);
    }
    if (session.state.following && session.streams.size > 0) {
      return copyLogState(session.state);
    }

    const scopeGeneration = ++session.scopeGeneration;
    session.state.following = true;
    try {
      if (session.state.scope === 'deployment') {
        const pendingDeployment = this.resolveDeploymentTargets(session);
        const deployment = pendingDeployment ? await pendingDeployment : undefined;
        if (!this.isLogTransitionCurrent(session, scopeGeneration, true)) {
          return copyLogState(session.state);
        }
        if (!deployment) {
          session.deploymentTargets = undefined;
          session.state.deployment = undefined;
          session.state.scope = 'pod';
          session.state.hasOlder = true;
        } else {
          session.deploymentTargets = deployment;
          session.state.deployment = { name: deployment.name, podCount: deployment.pods.length };
        }
      }
      await this.openCurrentLogStreams(session, false, scopeGeneration);
      if (!this.isLogTransitionCurrent(session, scopeGeneration, true)) {
        return copyLogState(session.state);
      }
      this.emitLog(session);
      return copyLogState(session.state);
    } catch (error) {
      if (this.isLogTransitionCurrent(session, scopeGeneration)) {
        session.state.following = false;
        this.emitLog(session);
      }
      throw error;
    }
  }

  public async setLogScope(sessionId: string, scope: KubernetesLogScope): Promise<KubernetesLogState> {
    const session = this.requireLog(sessionId);
    if (scope !== 'pod' && scope !== 'deployment') {
      throw new Error('Kubernetes log scope must be pod or deployment.');
    }
    if (session.state.scope === scope) {
      return copyLogState(session.state);
    }
    if (scope === 'deployment' && !session.state.deployment) {
      throw new Error('This Pod is not owned by a Deployment.');
    }

    const previous: LogScopeSnapshot = {
      state: copyLogState(session.state),
      lastRawLines: new Map(session.lastRawLines),
      aggregateLines: session.aggregateLines.map((line) => ({ ...line })),
      aggregateSequence: session.aggregateSequence,
      deploymentTargets: copyDeploymentTargets(session.deploymentTargets),
    };
    const wasFollowing = session.state.following;
    const scopeGeneration = ++session.scopeGeneration;
    const streams = this.detachLogStreams(session);
    session.state.scope = scope;
    session.state.lines = [];
    session.state.hasOlder = scope === 'pod';
    session.lastRawLines.clear();
    session.aggregateLines = [];
    session.aggregateSequence = 0;
    try {
      await this.closeLogStreams(streams).catch(() => undefined);
      if (!this.isLogTransitionCurrent(session, scopeGeneration)) {
        return copyLogState(session.state);
      }

      if (scope === 'deployment') {
        const pendingDeployment = this.resolveDeploymentTargets(session);
        const deployment = pendingDeployment ? await pendingDeployment : undefined;
        if (!this.isLogTransitionCurrent(session, scopeGeneration)) {
          return copyLogState(session.state);
        }
        if (!deployment) {
          throw new Error('Deployment log scope is no longer available for this Pod.');
        }
        session.deploymentTargets = deployment;
        session.state.deployment = { name: deployment.name, podCount: deployment.pods.length };
      }

      if (wasFollowing) {
        await this.openCurrentLogStreams(session, true, scopeGeneration);
        if (!this.isLogTransitionCurrent(session, scopeGeneration, true)) {
          return copyLogState(session.state);
        }
      }
      this.emitLog(session);
      return copyLogState(session.state);
    } catch (error) {
      if (this.isLogTransitionCurrent(session, scopeGeneration)) {
        // A failed switch must never leave the renderer showing its optimistic
        // previous scope while main owns a different live scope. Restore the
        // complete prior buffer/capability, but keep it explicitly paused: all
        // prior streams were already detached, and retrying an unknown failure
        // here could silently create a second stream or repeat the failure.
        const failedStreams = this.detachLogStreams(session);
        const revision = Math.max(previous.state.revision, session.state.revision);
        session.state = { ...copyLogState(previous.state), following: false, revision };
        session.lastRawLines = new Map(previous.lastRawLines);
        session.aggregateLines = previous.aggregateLines.map((line) => ({ ...line }));
        session.aggregateSequence = previous.aggregateSequence;
        session.deploymentTargets = copyDeploymentTargets(previous.deploymentTargets);
        this.emitLog(session);
        await this.closeLogStreams(failedStreams).catch(() => undefined);
      }
      throw error;
    }
  }

  public clearLogs(sessionId: string): KubernetesLogState {
    const session = this.requireLog(sessionId);
    session.state.lines = [];
    session.aggregateLines = [];
    session.aggregateSequence = 0;
    session.state.hasOlder = false;
    this.emitLog(session);
    return copyLogState(session.state);
  }

  public async closeLogs(sessionId: string): Promise<void> {
    const session = this.logs.get(sessionId);
    if (!session) {
      throw new Error('Kubernetes log session is not active.');
    }
    this.logs.delete(sessionId);
    session.closed = true;
    const results = await Promise.allSettled([
      ...this.detachLogStreams(session).map((stream) => this.closeLogStream(stream)),
      ...[...session.olderLoads].map((pending) => this.closeOlderLoad(pending)),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw errorFromFailures(failures, 'Kubernetes log cleanup failed.');
    }
  }

  public async openTerminal(input: KubernetesPodInteractionTarget): Promise<KubernetesTerminalState> {
    this.validatePodTarget(input);
    const id = this.createId();
    const session: TerminalSession = {
      state: {
        id,
        podName: input.podName,
        namespace: input.namespace,
        container: input.container,
        shell: SHELL_FALLBACKS[0],
        state: 'connecting',
      },
      pageGeneration: this.pageGeneration,
      allGeneration: this.allGeneration,
      closed: false,
      finalStateEmitted: false,
      nextGeneration: 0,
    };
    this.terminals.set(id, session);
    try {
      await this.openTerminalAttempt(session, input, 0);
      return copyTerminalState(session.state);
    } catch (error) {
      if (this.terminals.get(id) === session) {
        this.terminals.delete(id);
        session.closed = true;
      }
      await this.closeTerminalAttempt(session.attempt);
      throw error;
    }
  }

  public writeTerminal(id: string, data: string): void {
    if (typeof data !== 'string') {
      throw new Error('Kubernetes terminal input must be text.');
    }
    this.requireTerminal(id).handle?.write(data);
  }

  public resizeTerminal(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
      throw new Error('Kubernetes terminal dimensions must be positive integers.');
    }
    this.requireTerminal(id).handle?.resize(cols, rows);
  }

  public async closeTerminal(id: string): Promise<void> {
    const session = this.terminals.get(id);
    if (!session) {
      throw new Error('Kubernetes terminal session is not active.');
    }
    await this.finalizeTerminal(session, 'closed');
  }

  public async startPortForward(input: KubernetesPortForwardInput): Promise<KubernetesPortForwardState> {
    this.validatePortForwardInput(input);
    if (this.forwards.size >= MAXIMUM_PORT_FORWARDS) {
      throw new Error(`Kubernetes supports at most ${MAXIMUM_PORT_FORWARDS} active port forwards.`);
    }

    const id = this.createId();
    const session: PortForwardSession = {
      state: {
        id,
        targetKind: input.targetKind,
        targetName: input.targetName,
        namespace: input.namespace,
        remotePort: input.remotePort,
        localPort: input.localPort ?? 0,
        state: 'starting',
      },
      allGeneration: this.allGeneration,
      closed: false,
      handleClosed: false,
    };
    // Reserve capacity before awaiting the client so concurrent callers cannot
    // race past the ten-forward limit.
    this.forwards.set(id, session);
    try {
      const handle = await this.options.client().openPortForward(input);
      session.handle = handle;
      if (!this.isPortForwardActive(session)) {
        await this.closePortForwardSession(session);
        throw new Error('Kubernetes port forward was closed before it could start.');
      }
      session.state.localPort = handle.localPort;
      session.state.state = 'running';
      return copyPortForwardState(session.state);
    } catch (error) {
      if (this.forwards.get(id) === session) {
        this.forwards.delete(id);
        session.closed = true;
      }
      throw error;
    }
  }

  public async stopPortForward(id: string): Promise<void> {
    const session = this.forwards.get(id);
    if (!session) {
      throw new Error('Kubernetes port forward is not active.');
    }
    await this.closePortForwardSession(session);
  }

  /** Returns only display-safe forward metadata; local sockets stay private. */
  public listPortForwards(): KubernetesPortForwardState[] {
    return [...this.forwards.values()].map((session) => copyPortForwardState(session.state));
  }

  public async disposePageScoped(): Promise<void> {
    this.pageGeneration += 1;
    const results = await Promise.allSettled([
      ...[...this.logs.keys()].map((sessionId) => this.closeLogs(sessionId)),
      ...[...this.terminals.keys()].map((id) => this.closeTerminal(id)),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw errorFromFailures(failures, 'Kubernetes page-scoped stream cleanup failed.');
    }
  }

  public async disposeAll(): Promise<void> {
    this.allGeneration += 1;
    this.pageGeneration += 1;
    const failures: unknown[] = [];
    const pageResults = await Promise.allSettled([
      ...[...this.logs.keys()].map((sessionId) => this.closeLogs(sessionId)),
      ...[...this.terminals.keys()].map((id) => this.closeTerminal(id)),
    ]);
    failures.push(...pageResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason));
    const forwardResults = await Promise.allSettled(
      [...this.forwards.values()].map((session) => this.closePortForwardSession(session))
    );
    failures.push(...forwardResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason));
    if (failures.length > 0) {
      throw errorFromFailures(failures, 'Kubernetes interaction cleanup failed.');
    }
  }

  private resolveDeploymentTargets(
    session: LogSession
  ): Promise<KubernetesPodDeploymentLogTargets | undefined> | undefined {
    const client = this.options.client();
    const resolveTargets = client.resolvePodDeploymentLogTargets;
    if (!resolveTargets) return undefined;
    return resolveTargets.call(client, { ...session.input }).then((resolved) => {
      if (!resolved || resolved.pods.length === 0 || resolved.pods.length > MAXIMUM_DEPLOYMENT_LOG_PODS) {
        return undefined;
      }
      return {
        name: resolved.name,
        pods: resolved.pods.map((pod) => ({ ...pod })),
      };
    });
  }

  private async openCurrentLogStreams(
    session: LogSession,
    initial: boolean,
    scopeGeneration: number
  ): Promise<void> {
    if (!this.isLogTransitionCurrent(session, scopeGeneration, true)) {
      throw closedBefore('log session');
    }
    const targets = session.state.scope === 'deployment'
      ? session.deploymentTargets?.pods ?? []
      : [{ uid: session.input.podName, podName: session.input.podName }];
    if (targets.length === 0) {
      throw new Error('No Deployment Pods currently expose this container.');
    }
    const boundedTailLines = session.state.scope === 'deployment'
      ? Math.max(1, Math.ceil(INITIAL_LOG_TAIL_LINES / targets.length))
      : INITIAL_LOG_TAIL_LINES;
    try {
      await Promise.all(targets.map((target) => {
        const resumeSkipLine = initial ? undefined : session.lastRawLines.get(target.podName);
        // The stream is genuinely closed while paused. On Resume, ask for a
        // small bounded backlog after the last timestamp instead of requesting
        // only the newest line and silently dropping everything in between.
        // A non-timestamped legacy/fake anchor cannot be queried safely, so it
        // keeps the former one-line behavior to avoid replaying old content.
        const tailLines = initial || !resumeSkipLine || timestampFromLogLine(resumeSkipLine)
          ? boundedTailLines
          : 1;
        return this.openFollowingLogStream(
          session,
          target.podName,
          tailLines,
          scopeGeneration,
          resumeSkipLine
        );
      }));
      if (initial && session.state.scope === 'deployment' && session.aggregateLines.length > INITIAL_LOG_TAIL_LINES) {
        session.aggregateLines = session.aggregateLines.slice(-INITIAL_LOG_TAIL_LINES);
        session.state.lines = session.aggregateLines.map((line) => line.display);
      }
    } catch (error) {
      const streams = [...session.streams.values()].filter((stream) => stream.scopeGeneration === scopeGeneration);
      for (const stream of streams) {
        if (session.streams.get(stream.podName) === stream) session.streams.delete(stream.podName);
      }
      await this.closeLogStreams(streams).catch(() => undefined);
      throw error;
    }
  }

  private async openFollowingLogStream(
    session: LogSession,
    podName: string,
    tailLines: number,
    scopeGeneration: number,
    resumeSkipLine?: string
  ): Promise<void> {
    if (!this.isLogTransitionCurrent(session, scopeGeneration, true)) {
      throw closedBefore('log session');
    }
    const stream: LogStream = {
      generation: ++session.nextGeneration,
      scopeGeneration,
      podName,
      closeRequested: false,
      handleClosed: false,
      ...(resumeSkipLine ? { resumeSkipLine } : {}),
    };
    session.streams.set(podName, stream);
    const sinceTime = resumeSkipLine ? timestampFromLogLine(resumeSkipLine) : undefined;
    const handle = await this.options.client().openPodLog({
      namespace: session.input.namespace,
      podName,
      container: session.input.container,
      tailLines,
      follow: true,
      ...(sinceTime ? { sinceTime } : {}),
    }, {
      onLine: (line) => {
        if (!this.isCurrentLogStream(session, stream)) return;
        let incoming = splitCompleteLines(line);
        if (stream.resumeSkipLine && incoming[0] === stream.resumeSkipLine) {
          incoming = incoming.slice(1);
          stream.resumeSkipLine = undefined;
        } else if (incoming.length > 0) {
          stream.resumeSkipLine = undefined;
        }
        if (incoming.length === 0) return;
        for (const rawLine of incoming) {
          session.lastRawLines.set(podName, rawLine);
          if (session.state.scope === 'deployment') {
            session.aggregateLines.push({
              display: aggregateDisplayLine(podName, rawLine),
              podName,
              timestamp: aggregateTimestamp(rawLine),
              sequence: ++session.aggregateSequence,
            });
          }
        }
        if (session.state.scope === 'deployment') {
          session.aggregateLines.sort(compareAggregateLogLines);
          session.aggregateLines = session.aggregateLines.slice(-MAXIMUM_LOG_LINES);
          session.state.lines = session.aggregateLines.map((entry) => entry.display);
        } else {
          session.state.lines = appendBoundedLogLines(session.state.lines, incoming);
        }
        this.emitLog(session);
      },
    });
    stream.handle = handle;
    if (!this.isCurrentLogStream(session, stream)) {
      await this.closeLogStream(stream);
      throw closedBefore('log session');
    }
  }

  private detachLogStreams(session: LogSession): LogStream[] {
    const streams = [...session.streams.values()];
    session.streams.clear();
    for (const stream of streams) stream.closeRequested = true;
    return streams;
  }

  private async closeLogStreams(streams: LogStream[]): Promise<void> {
    const results = await Promise.allSettled(streams.map((stream) => this.closeLogStream(stream)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw errorFromFailures(failures, 'Kubernetes log cleanup failed.');
  }

  private async closeLogStream(stream: LogStream): Promise<void> {
    stream.closeRequested = true;
    if (stream.handle && !stream.handleClosed) {
      stream.handleClosed = true;
      await stream.handle.close();
    }
  }

  private async closeOlderLoad(pending: OlderLogLoad): Promise<void> {
    pending.closeRequested = true;
    if (pending.handle && !pending.handleClosed) {
      pending.handleClosed = true;
      await pending.handle.close();
    }
  }

  private async openTerminalAttempt(
    session: TerminalSession,
    input: KubernetesPodInteractionTarget,
    shellIndex: number,
    previousError?: unknown
  ): Promise<void> {
    const shell = SHELL_FALLBACKS[shellIndex];
    if (!shell) {
      const detail = previousError instanceof Error ? `: ${previousError.message}` : '';
      session.state.state = 'error';
      session.state.error = `No supported shell is available in this Pod${detail}`;
      throw new Error(session.state.error);
    }
    if (!this.isTerminalSessionActive(session)) {
      throw closedBefore('terminal session');
    }

    const attempt: TerminalAttempt = {
      generation: ++session.nextGeneration,
      shellIndex,
      handleClosed: false,
      closeRequested: false,
      retrying: false,
      normalClose: false,
    };
    session.attempt = attempt;
    session.handle = undefined;
    session.state.shell = shell;
    session.state.state = 'connecting';
    session.state.error = undefined;
    let handle: KubernetesPodExecHandle;
    try {
      handle = await this.options.client().openPodExec({ ...input, shell }, {
        onData: (data) => this.emitTerminalOutput(session, data),
        onClose: () => this.onTerminalAttemptClosed(session, attempt),
        onError: (error) => this.onTerminalAttemptError(session, attempt, error),
        onStatusFailure: (error) => this.onTerminalStatusFailure(session, input, attempt, error),
      });
    } catch (error) {
      if (!this.isTerminalSessionActive(session)) {
        throw closedBefore('terminal session');
      }
      // An `openPodExec` rejection is an immediate API/WebSocket/RBAC
      // failure, not evidence that the requested shell is absent. Preserve it
      // unchanged and leave shell fallback exclusively to command-status
      // failures reported after the exec transport opens.
      throw error;
    }
    attempt.handle = handle;
    if (!this.isTerminalSessionActive(session) || session.attempt !== attempt || attempt.closeRequested) {
      await this.closeTerminalAttempt(attempt);
      if (
        session.finalStateEmitted
        && session.pageGeneration === this.pageGeneration
        && session.allGeneration === this.allGeneration
      ) {
        return;
      }
      throw closedBefore('terminal session');
    }
    if (attempt.statusFailure) {
      await this.closeTerminalAttempt(attempt);
      return this.openTerminalAttempt(session, input, shellIndex + 1, attempt.statusFailure);
    }
    if (attempt.normalClose) {
      await this.finalizeTerminal(session, 'closed');
      return;
    }
    session.handle = handle;
    session.state.state = 'open';
    this.emitTerminal(session);
  }

  private onTerminalStatusFailure(
    session: TerminalSession,
    input: KubernetesPodInteractionTarget,
    attempt: TerminalAttempt,
    error: Error
  ): void {
    if (!this.isTerminalSessionActive(session) || session.attempt !== attempt) {
      return;
    }
    attempt.statusFailure = error;
    if (attempt.handle && !attempt.retrying) {
      attempt.retrying = true;
      void this.retryTerminalAfterStatusFailure(session, input, attempt);
    }
  }

  private async retryTerminalAfterStatusFailure(
    session: TerminalSession,
    input: KubernetesPodInteractionTarget,
    attempt: TerminalAttempt
  ): Promise<void> {
    try {
      await this.closeTerminalAttempt(attempt);
      if (!this.isTerminalSessionActive(session) || session.attempt !== attempt) {
        return;
      }
      await this.openTerminalAttempt(session, input, attempt.shellIndex + 1, attempt.statusFailure);
    } catch (error) {
      if (this.isTerminalSessionActive(session)) {
        await this.finalizeTerminal(
          session,
          'error',
          error instanceof Error ? error.message : 'Kubernetes terminal could not open.'
        );
      }
    }
  }

  private onTerminalAttemptClosed(session: TerminalSession, attempt: TerminalAttempt): void {
    if (!this.isTerminalSessionActive(session) || session.attempt !== attempt || attempt.statusFailure) {
      return;
    }
    attempt.normalClose = true;
    if (attempt.handle) {
      void this.finalizeTerminal(session, 'closed').catch(() => undefined);
    }
  }

  private onTerminalAttemptError(session: TerminalSession, attempt: TerminalAttempt, error: Error): void {
    if (!this.isTerminalSessionActive(session) || session.attempt !== attempt || attempt.statusFailure) {
      return;
    }
    void this.finalizeTerminal(session, 'error', error.message).catch(() => undefined);
  }

  /**
   * Final states are terminal: publish the final display-safe state once,
   * then invalidate the session before closing the underlying exec handle so
   * duplicate WebSocket callbacks cannot revive input or output delivery.
   */
  private async finalizeTerminal(
    session: TerminalSession,
    state: 'closed' | 'error',
    error?: string
  ): Promise<void> {
    if (this.terminals.get(session.state.id) !== session || session.closed || session.finalStateEmitted) {
      return;
    }
    session.finalStateEmitted = true;
    session.state.state = state;
    session.state.error = state === 'error' ? error ?? 'Kubernetes terminal failed.' : undefined;
    try {
      this.emitTerminal(session);
    } finally {
      if (this.terminals.get(session.state.id) === session) {
        this.terminals.delete(session.state.id);
      }
      session.closed = true;
      session.handle = undefined;
    }
    await this.closeTerminalAttempt(session.attempt);
  }

  private async closeTerminalAttempt(attempt: TerminalAttempt | undefined): Promise<void> {
    if (!attempt) {
      return;
    }
    attempt.closeRequested = true;
    if (attempt.handle && !attempt.handleClosed) {
      attempt.handleClosed = true;
      await attempt.handle.close();
    }
  }

  private async closePortForwardSession(session: PortForwardSession): Promise<void> {
    if (this.forwards.get(session.state.id) === session) {
      this.forwards.delete(session.state.id);
    }
    session.closed = true;
    session.state.state = 'stopped';
    if (session.handle && !session.handleClosed) {
      session.handleClosed = true;
      await session.handle.close();
    }
  }

  private requireLog(sessionId: string): LogSession {
    const session = this.logs.get(sessionId);
    if (!session || !this.isLogSessionActive(session)) {
      throw new Error('Kubernetes log session is not active.');
    }
    return session;
  }

  private requireTerminal(id: string): TerminalSession {
    const session = this.terminals.get(id);
    if (!session || !this.isTerminalSessionActive(session)) {
      throw new Error('Kubernetes terminal session is not active.');
    }
    return session;
  }

  private isLogSessionActive(session: LogSession): boolean {
    return this.logs.get(session.state.sessionId) === session
      && !session.closed
      && session.pageGeneration === this.pageGeneration
      && session.allGeneration === this.allGeneration;
  }

  private isCurrentLogStream(session: LogSession, stream: LogStream): boolean {
    return this.isLogSessionActive(session)
      && session.state.following
      && session.scopeGeneration === stream.scopeGeneration
      && session.streams.get(stream.podName) === stream
      && !stream.closeRequested;
  }

  private isLogTransitionCurrent(
    session: LogSession,
    scopeGeneration: number,
    following?: boolean
  ): boolean {
    return this.isLogSessionActive(session)
      && session.scopeGeneration === scopeGeneration
      && (following === undefined || session.state.following === following);
  }

  private isCurrentOlderLoad(session: LogSession, pending: OlderLogLoad): boolean {
    return this.isLogSessionActive(session)
      && session.state.scope === 'pod'
      && session.scopeGeneration === pending.scopeGeneration
      && session.olderLoads.has(pending)
      && !pending.closeRequested;
  }

  private isTerminalSessionActive(session: TerminalSession): boolean {
    return this.terminals.get(session.state.id) === session
      && !session.closed
      && session.pageGeneration === this.pageGeneration
      && session.allGeneration === this.allGeneration;
  }

  private isPortForwardActive(session: PortForwardSession): boolean {
    return this.forwards.get(session.state.id) === session
      && !session.closed
      && session.allGeneration === this.allGeneration;
  }

  private emitLog(session: LogSession, changed = true): void {
    if (!this.isLogSessionActive(session)) {
      return;
    }
    if (changed) {
      session.state.revision += 1;
    }
    const state = copyLogState(session.state);
    for (const listener of this.logListeners) {
      listener(state);
    }
  }

  private emitTerminal(session: TerminalSession): void {
    if (!this.isTerminalSessionActive(session)) {
      return;
    }
    const state = copyTerminalState(session.state);
    for (const listener of this.terminalListeners) {
      listener(state);
    }
  }

  private emitTerminalOutput(session: TerminalSession, data: string): void {
    if (!this.isTerminalSessionActive(session) || typeof data !== 'string' || data.length === 0) {
      return;
    }
    for (let start = 0; start < data.length; start += MAXIMUM_TERMINAL_OUTPUT_CHUNK_LENGTH) {
      if (!this.isTerminalSessionActive(session)) {
        return;
      }
      const output: KubernetesTerminalOutput = {
        id: session.state.id,
        data: data.slice(start, start + MAXIMUM_TERMINAL_OUTPUT_CHUNK_LENGTH),
      };
      for (const listener of this.terminalOutputListeners) {
        listener({ ...output });
      }
    }
  }

  private validatePodTarget(input: KubernetesPodInteractionTarget): void {
    assertNonEmpty(input.namespace, 'Namespace');
    assertNonEmpty(input.podName, 'Pod name');
    assertNonEmpty(input.container, 'container');
  }

  private validatePortForwardInput(input: KubernetesPortForwardInput): void {
    if (input.targetKind !== 'pod' && input.targetKind !== 'service') {
      throw new Error('Kubernetes port forward target must be a Pod or Service.');
    }
    assertNonEmpty(input.namespace, 'Namespace');
    assertNonEmpty(input.targetName, 'port forward target name');
    assertPort(input.remotePort, 'remote');
    if (input.localPort !== undefined) {
      assertPort(input.localPort, 'local', true);
    }
  }
}

function errorFromFailures(failures: unknown[], fallback: string): Error {
  const first = failures[0];
  return first instanceof Error ? first : new Error(fallback);
}
