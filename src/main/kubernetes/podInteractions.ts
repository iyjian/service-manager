import { randomUUID } from 'node:crypto';
import type {
  KubernetesLogScope,
  KubernetesLogState,
  KubernetesLogUpdate,
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
const LOG_UPDATE_BATCH_MS = 32;
const PENDING_LOG_COMPACTION_LINES = MAXIMUM_LOG_LINES * 2;
const MAXIMUM_DEPLOYMENT_LOG_PODS = 50;
const MAXIMUM_PORT_FORWARDS = 10;
const MAXIMUM_TERMINAL_OUTPUT_CHUNK_LENGTH = 16_384;
const DEFAULT_TERMINAL_READY_TIMEOUT_MS = 1_000;
const SHELL_FALLBACKS = ['/bin/sh', 'ash', 'bash', '/bin/sh'] as const;
const LOG_TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?:\s|$)/;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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
  /** Test seam; production live-log updates use one 32 ms bounded batch. */
  logBatchDelayMs?: number;
  /** Bounded fallback for interactive shells that intentionally emit no initial prompt. */
  terminalReadyTimeoutMs?: number;
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

interface TimeLogLoad {
  generation: number;
  scopeGeneration: number;
  podName: string;
  startTime: string;
  handle?: KubernetesPodLogHandle;
  closeRequested: boolean;
  handleClosed: boolean;
}

interface TimeLogSnapshot {
  podName: string;
  lines: string[];
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
  pendingPodLines: string[];
  pendingAggregateLines: AggregateLogLine[];
  pendingLastRawLines: Map<string, string>;
  pendingScopeGeneration?: number;
  logFlushTimer?: ReturnType<typeof setTimeout>;
  logBatchHoldGenerations: Set<number>;
  deploymentTargets?: KubernetesPodDeploymentLogTargets;
  olderLoads: Set<OlderLogLoad>;
  olderLoad?: Promise<KubernetesLogState>;
  timeLoads: Set<TimeLogLoad>;
}

interface AggregateLogLine {
  display: string;
  podName: string;
  timestamp?: number;
  sequence: number;
}

interface AppliedLogBatch {
  appendable: boolean;
  removeLeading: number;
  lines: string[];
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
  openPublished: boolean;
  receivedOutput: boolean;
  readinessSettled: boolean;
  readiness: Promise<void>;
  resolveReadiness: () => void;
  readinessTimer?: ReturnType<typeof setTimeout>;
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

function mergeBoundedAggregateLogLines(
  existing: readonly AggregateLogLine[],
  incoming: readonly AggregateLogLine[],
  maximum: number
): AggregateLogLine[] {
  const merged: AggregateLogLine[] = [];
  let existingIndex = 0;
  let incomingIndex = 0;
  while (existingIndex < existing.length && incomingIndex < incoming.length) {
    if (compareAggregateLogLines(existing[existingIndex], incoming[incomingIndex]) <= 0) {
      merged.push(existing[existingIndex]);
      existingIndex += 1;
    } else {
      merged.push(incoming[incomingIndex]);
      incomingIndex += 1;
    }
  }
  if (existingIndex < existing.length) merged.push(...existing.slice(existingIndex));
  if (incomingIndex < incoming.length) merged.push(...incoming.slice(incomingIndex));
  return merged.length <= maximum ? merged : merged.slice(-maximum);
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

/** Normalizes the renderer-provided lower bound before it reaches Kubernetes. */
export function normalizeKubernetesLogStartTime(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !RFC3339_TIMESTAMP.test(value)) {
    throw new Error('Kubernetes log start time must be an RFC3339 timestamp.');
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('Kubernetes log start time must be an RFC3339 timestamp.');
  }
  return timestamp.toISOString();
}

export function shellFallbacks(): readonly ['/bin/sh', 'ash', 'bash', '/bin/sh'] {
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
  private readonly logListeners = new Set<(update: KubernetesLogUpdate) => void>();
  private readonly terminalListeners = new Set<(state: KubernetesTerminalState) => void>();
  private readonly terminalOutputListeners = new Set<(output: KubernetesTerminalOutput) => void>();
  private readonly terminalReadyTimeoutMs: number;
  private readonly logBatchDelayMs: number;
  private pageGeneration = 0;
  private allGeneration = 0;

  public constructor(private readonly options: PodInteractionManagerOptions) {
    this.createId = options.createId ?? randomUUID;
    const readyTimeout = options.terminalReadyTimeoutMs ?? DEFAULT_TERMINAL_READY_TIMEOUT_MS;
    if (!Number.isFinite(readyTimeout) || readyTimeout < 0) {
      throw new Error('Kubernetes terminal ready timeout must be a non-negative number.');
    }
    this.terminalReadyTimeoutMs = readyTimeout;
    const logBatchDelayMs = options.logBatchDelayMs ?? LOG_UPDATE_BATCH_MS;
    if (!Number.isFinite(logBatchDelayMs)
      || (logBatchDelayMs !== 0 && (logBatchDelayMs < 16 || logBatchDelayMs > 50))) {
      throw new Error('Kubernetes log update batch delay must be 0 for tests or between 16 and 50 milliseconds.');
    }
    this.logBatchDelayMs = logBatchDelayMs;
  }

  public onLogChanged(listener: (update: KubernetesLogUpdate) => void): () => void {
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
      pendingPodLines: [],
      pendingAggregateLines: [],
      pendingLastRawLines: new Map(),
      logBatchHoldGenerations: new Set(),
      olderLoads: new Set(),
      timeLoads: new Set(),
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
      this.emitLogReset(session, false);
      return copyLogState(session.state);
    } catch (error) {
      if (this.logs.get(sessionId) === session) {
        this.logs.delete(sessionId);
        session.closed = true;
      }
      this.clearPendingLogBatch(session);
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
    this.flushPendingLogBatch(session);
    if (session.state.scope !== 'pod') {
      session.state.hasOlder = false;
      return copyLogState(session.state);
    }
    const retainedAtStart = [...session.state.lines];
    if (retainedAtStart.length === 0) {
      session.state.hasOlder = false;
      this.emitLogReset(session);
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
      this.emitLogReset(session);
      return copyLogState(session.state);
    } finally {
      session.olderLoads.delete(pending);
      await this.closeOlderLoad(pending);
    }
  }

  /**
   * Replaces the viewer with one bounded server-side snapshot beginning at an
   * RFC3339 timestamp. Snapshot reads never remain attached as follow streams.
   */
  public async setLogStartTime(sessionId: string, value?: string): Promise<KubernetesLogState> {
    const session = this.requireLog(sessionId);
    this.flushPendingLogBatch(session);
    const startTime = value === undefined ? undefined : normalizeKubernetesLogStartTime(value);
    if (session.state.startTime === startTime && !session.state.following && session.timeLoads.size === 0) {
      return copyLogState(session.state);
    }

    const previous: LogScopeSnapshot = {
      state: copyLogState(session.state),
      lastRawLines: new Map(session.lastRawLines),
      aggregateLines: session.aggregateLines.map((line) => ({ ...line })),
      aggregateSequence: session.aggregateSequence,
      deploymentTargets: copyDeploymentTargets(session.deploymentTargets),
    };
    const scopeGeneration = ++session.scopeGeneration;
    const streams = this.detachLogStreams(session);
    const timeLoads = this.detachTimeLogLoads(session);
    session.state.following = false;
    session.state.startTime = startTime;
    session.state.lines = [];
    session.state.hasOlder = false;
    session.lastRawLines.clear();
    session.aggregateLines = [];
    session.aggregateSequence = 0;
    this.emitLogReset(session);

    try {
      await Promise.all([
        this.closeLogStreams(streams).catch(() => undefined),
        this.closeTimeLogLoads(timeLoads).catch(() => undefined),
      ]);
      if (!this.isLogTimeTransitionCurrent(session, scopeGeneration, startTime)) {
        return copyLogState(session.state);
      }
      if (startTime === undefined) {
        return copyLogState(session.state);
      }
      if (session.state.scope === 'deployment') {
        const pendingDeployment = this.resolveDeploymentTargets(session);
        const deployment = pendingDeployment ? await pendingDeployment : undefined;
        if (!this.isLogTimeTransitionCurrent(session, scopeGeneration, startTime)) {
          return copyLogState(session.state);
        }
        if (!deployment) {
          session.deploymentTargets = undefined;
          session.state.deployment = undefined;
          session.state.scope = 'pod';
        } else {
          session.deploymentTargets = deployment;
          session.state.deployment = { name: deployment.name, podCount: deployment.pods.length };
        }
      }
      await this.loadTimeLogSnapshot(session, startTime, scopeGeneration);
      if (!this.isLogTimeTransitionCurrent(session, scopeGeneration, startTime)) {
        return copyLogState(session.state);
      }
      this.emitLogReset(session);
      return copyLogState(session.state);
    } catch (error) {
      if (this.isLogTransitionCurrent(session, scopeGeneration)) {
        const failedLoads = this.detachTimeLogLoads(session);
        const revision = Math.max(previous.state.revision, session.state.revision);
        session.state = { ...copyLogState(previous.state), following: false, revision };
        session.lastRawLines = new Map(previous.lastRawLines);
        session.aggregateLines = previous.aggregateLines.map((line) => ({ ...line }));
        session.aggregateSequence = previous.aggregateSequence;
        session.deploymentTargets = copyDeploymentTargets(previous.deploymentTargets);
        this.emitLogReset(session);
        await this.closeTimeLogLoads(failedLoads).catch(() => undefined);
      }
      throw error;
    }
  }

  public async setLogFollowing(sessionId: string, following: boolean): Promise<KubernetesLogState> {
    const session = this.requireLog(sessionId);
    this.flushPendingLogBatch(session);
    if (!following) {
      if (!session.state.following) {
        return copyLogState(session.state);
      }
      session.scopeGeneration += 1;
      session.state.following = false;
      this.emitLogReset(session);
      const streams = this.detachLogStreams(session);
      await this.closeLogStreams(streams).catch(() => undefined);
      return copyLogState(session.state);
    }
    if (session.state.following && session.streams.size > 0) {
      return copyLogState(session.state);
    }

    const previousStartTime = session.state.startTime;
    const scopeGeneration = ++session.scopeGeneration;
    const timeLoads = this.detachTimeLogLoads(session);
    await this.closeTimeLogLoads(timeLoads).catch(() => undefined);
    session.state.following = true;
    session.state.startTime = undefined;
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
      this.emitLogReset(session);
      return copyLogState(session.state);
    } catch (error) {
      if (this.isLogTransitionCurrent(session, scopeGeneration)) {
        session.state.following = false;
        session.state.startTime = previousStartTime;
        this.emitLogReset(session);
      }
      throw error;
    }
  }

  public async setLogScope(sessionId: string, scope: KubernetesLogScope): Promise<KubernetesLogState> {
    const session = this.requireLog(sessionId);
    this.flushPendingLogBatch(session);
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
    const timeLoads = this.detachTimeLogLoads(session);
    session.state.scope = scope;
    session.state.lines = [];
    session.state.hasOlder = scope === 'pod';
    session.lastRawLines.clear();
    session.aggregateLines = [];
    session.aggregateSequence = 0;
    try {
      await Promise.all([
        this.closeLogStreams(streams).catch(() => undefined),
        this.closeTimeLogLoads(timeLoads).catch(() => undefined),
      ]);
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
      } else if (session.state.startTime) {
        await this.loadTimeLogSnapshot(session, session.state.startTime, scopeGeneration);
        if (!this.isLogTimeTransitionCurrent(session, scopeGeneration, session.state.startTime)) {
          return copyLogState(session.state);
        }
      }
      this.emitLogReset(session);
      return copyLogState(session.state);
    } catch (error) {
      if (this.isLogTransitionCurrent(session, scopeGeneration)) {
        // A failed switch must never leave the renderer showing its optimistic
        // previous scope while main owns a different live scope. Restore the
        // complete prior buffer/capability, but keep it explicitly paused: all
        // prior streams were already detached, and retrying an unknown failure
        // here could silently create a second stream or repeat the failure.
        const failedStreams = this.detachLogStreams(session);
        const failedTimeLoads = this.detachTimeLogLoads(session);
        const revision = Math.max(previous.state.revision, session.state.revision);
        session.state = { ...copyLogState(previous.state), following: false, revision };
        session.lastRawLines = new Map(previous.lastRawLines);
        session.aggregateLines = previous.aggregateLines.map((line) => ({ ...line }));
        session.aggregateSequence = previous.aggregateSequence;
        session.deploymentTargets = copyDeploymentTargets(previous.deploymentTargets);
        this.emitLogReset(session);
        await Promise.all([
          this.closeLogStreams(failedStreams).catch(() => undefined),
          this.closeTimeLogLoads(failedTimeLoads).catch(() => undefined),
        ]);
      }
      throw error;
    }
  }

  public clearLogs(sessionId: string): KubernetesLogState {
    const session = this.requireLog(sessionId);
    this.flushPendingLogBatch(session);
    session.state.lines = [];
    session.aggregateLines = [];
    session.aggregateSequence = 0;
    session.state.hasOlder = false;
    this.emitLogReset(session);
    return copyLogState(session.state);
  }

  public async closeLogs(sessionId: string): Promise<void> {
    const session = this.logs.get(sessionId);
    if (!session) {
      throw new Error('Kubernetes log session is not active.');
    }
    this.logs.delete(sessionId);
    session.closed = true;
    this.clearPendingLogBatch(session);
    const results = await Promise.allSettled([
      ...this.detachLogStreams(session).map((stream) => this.closeLogStream(stream)),
      ...[...session.olderLoads].map((pending) => this.closeOlderLoad(pending)),
      ...this.detachTimeLogLoads(session).map((pending) => this.closeTimeLogLoad(pending)),
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
    const session = this.requireTerminal(id);
    const attempt = session.attempt;
    if (session.state.state !== 'open'
      || !session.handle
      || !attempt
      || !attempt.openPublished
      || attempt.closeRequested
      || attempt.statusFailure) {
      throw new Error('Kubernetes terminal session is not ready for input.');
    }
    session.handle.write(data);
  }

  public resizeTerminal(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
      throw new Error('Kubernetes terminal dimensions must be positive integers.');
    }
    const session = this.requireTerminal(id);
    const attempt = session.attempt;
    if (session.state.state !== 'open'
      || !session.handle
      || !attempt
      || !attempt.openPublished
      || attempt.closeRequested
      || attempt.statusFailure) {
      throw new Error('Kubernetes terminal session is not ready to resize.');
    }
    session.handle.resize(cols, rows);
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

  private async loadTimeLogSnapshot(
    session: LogSession,
    startTime: string,
    scopeGeneration: number
  ): Promise<void> {
    if (!this.isLogTimeTransitionCurrent(session, scopeGeneration, startTime)) {
      throw closedBefore('log snapshot');
    }
    const targets = session.state.scope === 'deployment'
      ? session.deploymentTargets?.pods ?? []
      : [{ uid: session.input.podName, podName: session.input.podName }];
    if (targets.length === 0) {
      throw new Error('No Deployment Pods currently expose this container.');
    }
    const tailLines = session.state.scope === 'deployment'
      ? Math.max(1, Math.ceil(MAXIMUM_LOG_LINES / targets.length))
      : MAXIMUM_LOG_LINES;
    const snapshots = await Promise.all(targets.map((target) => (
      this.readTimeLogSnapshot(session, target.podName, startTime, tailLines, scopeGeneration)
    )));
    if (!this.isLogTimeTransitionCurrent(session, scopeGeneration, startTime)) {
      throw closedBefore('log snapshot');
    }

    session.state.lines = [];
    session.state.hasOlder = false;
    session.lastRawLines.clear();
    session.aggregateLines = [];
    session.aggregateSequence = 0;
    for (const snapshot of snapshots) {
      const lastLine = snapshot.lines.at(-1);
      if (lastLine) session.lastRawLines.set(snapshot.podName, lastLine);
      if (session.state.scope === 'deployment') {
        for (const rawLine of snapshot.lines) {
          session.aggregateLines.push({
            display: aggregateDisplayLine(snapshot.podName, rawLine),
            podName: snapshot.podName,
            timestamp: aggregateTimestamp(rawLine),
            sequence: ++session.aggregateSequence,
          });
        }
      } else {
        session.state.lines = appendBoundedLogLines(session.state.lines, snapshot.lines);
      }
    }
    if (session.state.scope === 'deployment') {
      session.aggregateLines.sort(compareAggregateLogLines);
      session.aggregateLines = session.aggregateLines.slice(-MAXIMUM_LOG_LINES);
      session.state.lines = session.aggregateLines.map((line) => line.display);
    }
  }

  private async readTimeLogSnapshot(
    session: LogSession,
    podName: string,
    startTime: string,
    tailLines: number,
    scopeGeneration: number
  ): Promise<TimeLogSnapshot> {
    const pending: TimeLogLoad = {
      generation: ++session.nextGeneration,
      scopeGeneration,
      podName,
      startTime,
      closeRequested: false,
      handleClosed: false,
    };
    session.timeLoads.add(pending);
    let lines: string[] = [];
    try {
      const handle = await this.options.client().openPodLog({
        namespace: session.input.namespace,
        podName,
        container: session.input.container,
        tailLines,
        follow: false,
        sinceTime: startTime,
      }, {
        onLine: (line) => {
          if (this.isCurrentTimeLogLoad(session, pending)) {
            lines = appendBoundedLogLines(lines, [line], tailLines);
          }
        },
      });
      pending.handle = handle;
      if (!this.isCurrentTimeLogLoad(session, pending)) {
        throw closedBefore('log snapshot');
      }
      await handle.completed;
      if (!this.isCurrentTimeLogLoad(session, pending)) {
        throw closedBefore('log snapshot');
      }
      return { podName, lines };
    } finally {
      session.timeLoads.delete(pending);
      await this.closeTimeLogLoad(pending).catch(() => undefined);
    }
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
    session.logBatchHoldGenerations.add(scopeGeneration);
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
      this.applyPendingLogBatch(
        session,
        initial && session.state.scope === 'deployment' ? INITIAL_LOG_TAIL_LINES : MAXIMUM_LOG_LINES,
        scopeGeneration
      );
    } catch (error) {
      this.clearPendingLogBatch(session, scopeGeneration);
      const streams = [...session.streams.values()].filter((stream) => stream.scopeGeneration === scopeGeneration);
      for (const stream of streams) {
        if (session.streams.get(stream.podName) === stream) session.streams.delete(stream.podName);
      }
      await this.closeLogStreams(streams).catch(() => undefined);
      throw error;
    } finally {
      session.logBatchHoldGenerations.delete(scopeGeneration);
      if (session.pendingScopeGeneration === session.scopeGeneration) {
        this.scheduleLogFlush(session, session.scopeGeneration);
      }
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
        if (session.pendingScopeGeneration !== undefined
          && session.pendingScopeGeneration !== scopeGeneration) {
          this.clearPendingLogBatch(session);
        }
        session.pendingScopeGeneration = scopeGeneration;
        for (const rawLine of incoming) {
          // Resume cursors commit with the batch. A partially opened multi-Pod
          // generation may still fail, and discarded lines must remain
          // eligible for the next bounded catch-up request.
          session.pendingLastRawLines.set(podName, rawLine);
          if (session.state.scope === 'deployment') {
            session.pendingAggregateLines.push({
              display: aggregateDisplayLine(podName, rawLine),
              podName,
              timestamp: aggregateTimestamp(rawLine),
              sequence: ++session.aggregateSequence,
            });
          } else {
            session.pendingPodLines.push(rawLine);
          }
        }
        this.compactPendingLogBatch(session);
        this.scheduleLogFlush(session, scopeGeneration);
      },
    });
    stream.handle = handle;
    if (!this.isCurrentLogStream(session, stream)) {
      await this.closeLogStream(stream);
      throw closedBefore('log session');
    }
  }

  private compactPendingLogBatch(session: LogSession): void {
    if (session.pendingPodLines.length >= PENDING_LOG_COMPACTION_LINES) {
      session.pendingPodLines = session.pendingPodLines.slice(-MAXIMUM_LOG_LINES);
    }
    if (session.pendingAggregateLines.length >= PENDING_LOG_COMPACTION_LINES) {
      session.pendingAggregateLines.sort(compareAggregateLogLines);
      session.pendingAggregateLines = session.pendingAggregateLines.slice(-MAXIMUM_LOG_LINES);
    }
  }

  private scheduleLogFlush(session: LogSession, scopeGeneration: number): void {
    if (session.logBatchHoldGenerations.has(scopeGeneration) || session.logFlushTimer !== undefined) return;
    if (this.logBatchDelayMs === 0) {
      this.flushPendingLogBatch(session);
      return;
    }
    const timer = setTimeout(() => {
      if (session.logFlushTimer !== timer) return;
      session.logFlushTimer = undefined;
      if (!this.isLogSessionActive(session)
        || session.scopeGeneration !== scopeGeneration
        || session.pendingScopeGeneration !== scopeGeneration) {
        if (session.pendingScopeGeneration === scopeGeneration) {
          session.pendingPodLines = [];
          session.pendingAggregateLines = [];
          session.pendingLastRawLines.clear();
          session.pendingScopeGeneration = undefined;
        }
        const pendingGeneration = session.pendingScopeGeneration;
        if (this.isLogSessionActive(session)
          && pendingGeneration === session.scopeGeneration
          && !session.logBatchHoldGenerations.has(pendingGeneration)) {
          this.scheduleLogFlush(session, pendingGeneration);
        }
        return;
      }
      this.flushPendingLogBatch(session);
    }, this.logBatchDelayMs);
    session.logFlushTimer = timer;
  }

  private applyPendingLogBatch(
    session: LogSession,
    maximum = MAXIMUM_LOG_LINES,
    expectedScopeGeneration?: number
  ): AppliedLogBatch | undefined {
    if (expectedScopeGeneration !== undefined
      && session.pendingScopeGeneration !== expectedScopeGeneration) {
      return undefined;
    }
    if (session.logFlushTimer !== undefined) {
      clearTimeout(session.logFlushTimer);
      session.logFlushTimer = undefined;
    }
    const pendingPodLines = session.pendingPodLines;
    const pendingAggregateLines = session.pendingAggregateLines;
    const pendingLastRawLines = session.pendingLastRawLines;
    session.pendingPodLines = [];
    session.pendingAggregateLines = [];
    session.pendingLastRawLines = new Map();
    session.pendingScopeGeneration = undefined;
    for (const [podName, rawLine] of pendingLastRawLines) {
      session.lastRawLines.set(podName, rawLine);
    }

    if (session.state.scope !== 'deployment') {
      if (pendingPodLines.length === 0) return undefined;
      const existing = session.state.lines;
      const retainedOldCount = Math.min(existing.length, Math.max(0, maximum - pendingPodLines.length));
      const removeLeading = existing.length - retainedOldCount;
      const appended = pendingPodLines.length > maximum
        ? pendingPodLines.slice(-maximum)
        : pendingPodLines;
      const next = [...existing.slice(removeLeading), ...appended];
      session.state.lines = next;
      return { appendable: true, removeLeading, lines: [...appended] };
    }

    if (pendingAggregateLines.length === 0) return undefined;
    pendingAggregateLines.sort(compareAggregateLogLines);
    const existing = session.aggregateLines;
    const incomingEntries = new Set(pendingAggregateLines);
    const next = mergeBoundedAggregateLogLines(existing, pendingAggregateLines, maximum);
    const unchanged = next.length === existing.length
      && next.every((entry, index) => entry === existing[index]);
    session.aggregateLines = next;
    session.state.lines = next.map((entry) => entry.display);
    if (unchanged) return undefined;

    let oldCount = 0;
    let sawIncoming = false;
    let appendable = true;
    for (const entry of next) {
      if (incomingEntries.has(entry)) {
        sawIncoming = true;
      } else {
        if (sawIncoming) appendable = false;
        oldCount += 1;
      }
    }
    const oldStart = existing.length - oldCount;
    if (oldStart < 0 || next.slice(0, oldCount).some((entry, index) => entry !== existing[oldStart + index])) {
      appendable = false;
    }
    return {
      appendable,
      removeLeading: appendable ? oldStart : 0,
      lines: appendable ? next.slice(oldCount).map((entry) => entry.display) : [],
    };
  }

  private flushPendingLogBatch(session: LogSession): void {
    const applied = this.applyPendingLogBatch(session);
    if (!applied || !this.isLogSessionActive(session)) return;
    const baseRevision = session.state.revision;
    session.state.revision += 1;
    if (!applied.appendable) {
      this.emitLogReset(session, false);
      return;
    }
    const update: KubernetesLogUpdate = {
      kind: 'append',
      sessionId: session.state.sessionId,
      podName: session.state.podName,
      namespace: session.state.namespace,
      container: session.state.container,
      scope: session.state.scope,
      following: session.state.following,
      ...(session.state.startTime ? { startTime: session.state.startTime } : {}),
      baseRevision,
      revision: session.state.revision,
      removeLeading: applied.removeLeading,
      lines: applied.lines,
    };
    for (const listener of this.logListeners) listener(update);
  }

  private clearPendingLogBatch(session: LogSession, expectedScopeGeneration?: number): void {
    if (expectedScopeGeneration !== undefined
      && session.pendingScopeGeneration !== expectedScopeGeneration) {
      return;
    }
    if (session.logFlushTimer !== undefined) clearTimeout(session.logFlushTimer);
    session.logFlushTimer = undefined;
    session.pendingPodLines = [];
    session.pendingAggregateLines = [];
    session.pendingLastRawLines.clear();
    session.pendingScopeGeneration = undefined;
  }

  private detachLogStreams(session: LogSession): LogStream[] {
    const streams = [...session.streams.values()];
    session.streams.clear();
    for (const stream of streams) stream.closeRequested = true;
    return streams;
  }

  private detachTimeLogLoads(session: LogSession): TimeLogLoad[] {
    const loads = [...session.timeLoads];
    session.timeLoads.clear();
    for (const load of loads) load.closeRequested = true;
    return loads;
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

  private async closeTimeLogLoads(loads: TimeLogLoad[]): Promise<void> {
    const results = await Promise.allSettled(loads.map((load) => this.closeTimeLogLoad(load)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw errorFromFailures(failures, 'Kubernetes log snapshot cleanup failed.');
  }

  private async closeTimeLogLoad(pending: TimeLogLoad): Promise<void> {
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

    let resolveReadiness = (): void => undefined;
    const readiness = new Promise<void>((resolve) => {
      resolveReadiness = resolve;
    });
    const attempt: TerminalAttempt = {
      generation: ++session.nextGeneration,
      shellIndex,
      handleClosed: false,
      closeRequested: false,
      retrying: false,
      normalClose: false,
      openPublished: false,
      receivedOutput: false,
      readinessSettled: false,
      readiness,
      resolveReadiness,
    };
    session.attempt = attempt;
    session.handle = undefined;
    session.state.shell = shell;
    session.state.state = 'connecting';
    session.state.error = undefined;
    let handle: KubernetesPodExecHandle;
    try {
      handle = await this.options.client().openPodExec({
        ...input,
        shell,
        allowDegradedDash: shellIndex === SHELL_FALLBACKS.length - 1,
      }, {
        onData: (data) => {
          if (!this.isTerminalSessionActive(session)
            || session.attempt !== attempt
            || attempt.closeRequested
            || attempt.statusFailure
            || attempt.normalClose) {
            return;
          }
          if (data.length > 0) {
            attempt.receivedOutput = true;
          }
          this.emitTerminalOutput(session, data);
          if (data.length > 0) {
            this.markTerminalAttemptReady(attempt);
          }
        },
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
    await this.waitForTerminalAttemptReady(attempt);
    if (!this.isTerminalSessionActive(session)) {
      if (
        session.finalStateEmitted
        && session.pageGeneration === this.pageGeneration
        && session.allGeneration === this.allGeneration
      ) {
        return;
      }
      throw closedBefore('terminal session');
    }
    if (session.attempt !== attempt) {
      return;
    }
    if (attempt.closeRequested) {
      await this.closeTerminalAttempt(attempt);
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
    attempt.openPublished = true;
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
    this.markTerminalAttemptReady(attempt);
    if (attempt.handle && attempt.openPublished && !attempt.retrying) {
      if (attempt.receivedOutput) {
        void this.finalizeTerminal(session, 'error', error.message).catch(() => undefined);
        return;
      }
      attempt.retrying = true;
      session.state.state = 'connecting';
      session.handle = undefined;
      this.emitTerminal(session);
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
    this.markTerminalAttemptReady(attempt);
    if (attempt.handle) {
      void this.finalizeTerminal(session, 'closed').catch(() => undefined);
    }
  }

  private onTerminalAttemptError(session: TerminalSession, attempt: TerminalAttempt, error: Error): void {
    if (!this.isTerminalSessionActive(session) || session.attempt !== attempt || attempt.statusFailure) {
      return;
    }
    this.markTerminalAttemptReady(attempt);
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
    this.markTerminalAttemptReady(attempt);
    if (attempt.handle && !attempt.handleClosed) {
      attempt.handleClosed = true;
      await attempt.handle.close();
    }
  }

  private async waitForTerminalAttemptReady(attempt: TerminalAttempt): Promise<void> {
    if (!attempt.readinessSettled) {
      if (this.terminalReadyTimeoutMs === 0) {
        this.markTerminalAttemptReady(attempt);
      } else {
        attempt.readinessTimer = setTimeout(() => {
          this.markTerminalAttemptReady(attempt);
        }, this.terminalReadyTimeoutMs);
      }
    }
    await attempt.readiness;
  }

  private markTerminalAttemptReady(attempt: TerminalAttempt): void {
    if (attempt.readinessSettled) {
      return;
    }
    attempt.readinessSettled = true;
    if (attempt.readinessTimer) {
      clearTimeout(attempt.readinessTimer);
      attempt.readinessTimer = undefined;
    }
    attempt.resolveReadiness();
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

  private isLogTimeTransitionCurrent(
    session: LogSession,
    scopeGeneration: number,
    startTime: string | undefined
  ): boolean {
    return this.isLogTransitionCurrent(session, scopeGeneration, false)
      && session.state.startTime === startTime;
  }

  private isCurrentOlderLoad(session: LogSession, pending: OlderLogLoad): boolean {
    return this.isLogSessionActive(session)
      && session.state.scope === 'pod'
      && session.scopeGeneration === pending.scopeGeneration
      && session.olderLoads.has(pending)
      && !pending.closeRequested;
  }

  private isCurrentTimeLogLoad(session: LogSession, pending: TimeLogLoad): boolean {
    return this.isLogTimeTransitionCurrent(session, pending.scopeGeneration, pending.startTime)
      && session.timeLoads.has(pending)
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

  private emitLogReset(session: LogSession, changed = true): void {
    if (!this.isLogSessionActive(session)) {
      return;
    }
    if (changed) {
      session.state.revision += 1;
    }
    const update: KubernetesLogUpdate = { kind: 'reset', state: copyLogState(session.state) };
    for (const listener of this.logListeners) {
      listener(update);
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
