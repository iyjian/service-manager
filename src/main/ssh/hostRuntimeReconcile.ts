import { isDeepStrictEqual } from 'node:util';
import type { ForwardRule, HostConfig, ServiceConfig } from '../../shared/types';

function connection(host: HostConfig) {
  return { sshHost: host.sshHost, sshPort: host.sshPort, username: host.username, authType: host.authType,
    password: host.password, privateKey: host.privateKey, passphrase: host.passphrase,
    privateKeyPath: host.privateKeyPath, jumpHosts: host.jumpHosts.map(({ privateKeyId: _id, ...hop }) => hop) };
}

function forwardRuntime({ name: _name, ...rule }: ForwardRule) { return rule; }

export function sameServiceRuntime(left: ServiceConfig, right: ServiceConfig): boolean {
  return left.startCommand === right.startCommand && left.port === right.port
    && left.forwardLocalPort === right.forwardLocalPort;
}

export function planHostRuntimeChanges(previous: HostConfig | undefined, next: HostConfig) {
  const sameConnection = previous !== undefined && isDeepStrictEqual(connection(previous), connection(next));
  const previousForwards = new Map(previous?.forwards.map(rule => [rule.id, rule]));
  const nextForwards = new Map(next.forwards.map(rule => [rule.id, rule]));
  const previousServices = new Map(previous?.services.map(service => [service.id, service]));
  const nextServices = new Map(next.services.map(service => [service.id, service]));
  const unchangedRule = (left: ForwardRule, right?: ForwardRule) => sameConnection && right !== undefined
    && isDeepStrictEqual(forwardRuntime(left), forwardRuntime(right));
  const unchangedService = (left: ServiceConfig, right?: ServiceConfig) => sameConnection && right !== undefined
    && sameServiceRuntime(left, right);
  return {
    stopForwardIds: (previous?.forwards ?? []).filter(rule => !unchangedRule(rule, nextForwards.get(rule.id))).map(rule => rule.id),
    startForwards: next.forwards.filter(rule => rule.autoStart && !unchangedRule(rule, previousForwards.get(rule.id))),
    stopServiceIds: (previous?.services ?? []).filter(service => !unchangedService(service, nextServices.get(service.id))).map(service => service.id),
    refreshServiceIds: next.services.filter(service => !unchangedService(service, previousServices.get(service.id))).map(service => service.id),
  };
}

interface PendingHost {
  previous?: HostConfig;
  next?: HostConfig;
  controller: AbortController;
  done: Promise<void>;
}

/** Coalesce queued saves while allowing an in-flight reconciliation to finish in order. */
export class HostRuntimeReconciler {
  private readonly pending = new Map<string, PendingHost>();
  private stopped = false;

  constructor(private readonly reconcile: (previous: HostConfig | undefined, next: HostConfig, signal: AbortSignal) => Promise<void>,
    private readonly report: (hostId: string, error: unknown) => void) {}

  schedule(previous: HostConfig | undefined, next: HostConfig): void {
    if (this.stopped) return;
    const existing = this.pending.get(next.id);
    if (existing && !existing.controller.signal.aborted) { existing.next = next; return; }
    const entry: PendingHost = { previous, next, controller: new AbortController(), done: Promise.resolve() };
    this.pending.set(next.id, entry);
    entry.done = Promise.resolve().then(async () => {
      while (entry.next && !entry.controller.signal.aborted) {
        const desired = entry.next;
        entry.next = undefined;
        try { await this.reconcile(entry.previous, desired, entry.controller.signal); }
        catch (error) { if (!entry.controller.signal.aborted) this.report(desired.id, error); }
        entry.previous = desired;
      }
    }).finally(() => {
      if (this.pending.get(next.id) === entry) this.pending.delete(next.id);
    });
  }

  async cancel(hostId: string): Promise<void> {
    const entry = this.pending.get(hostId);
    entry?.controller.abort();
    await entry?.done;
  }
  async cancelAll(): Promise<void> {
    const entries = [...this.pending.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.done));
  }
  async drain(): Promise<void> {
    await Promise.all([...this.pending.values()].map(entry => entry.done));
  }
  async shutdown(): Promise<void> { this.stopped = true; await this.cancelAll(); }
}
