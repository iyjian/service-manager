const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value.slice(0, 256) : undefined;
const termination = (state: Record<string, unknown>): string => text(state.reason)
  ?? (typeof state.signal === 'number' && state.signal !== 0 ? `Signal:${state.signal}` : `ExitCode:${state.exitCode ?? 'Unknown'}`);

/** Display status (not API phase), shared by LIST/Watch rows and Pod details. */
export function kubernetesPodStatus(value: unknown): string | undefined {
  const pod = record(value), metadata = record(pod.metadata), spec = record(pod.spec), status = record(pod.status);
  if (metadata.deletionTimestamp) return status.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
  const phase = text(status.phase);
  if (phase === 'Succeeded') return 'Completed';
  if (phase === 'Failed' && text(status.reason)) return text(status.reason);
  const initContainers = list(spec.initContainers), initStatuses = list(status.initContainerStatuses);
  for (let index = 0; index < initContainers.length; index++) {
    const container = initContainers[index];
    const current = initStatuses.find(item => item.name === container.name) ?? {};
    const state = record(current.state), stopped = record(state.terminated);
    if (container.restartPolicy === 'Always' ? current.started === true : stopped.exitCode === 0) continue;
    if (state.terminated) return `Init:${termination(stopped)}`;
    const reason = text(record(state.waiting).reason);
    if (reason && reason !== 'PodInitializing') return `Init:${reason}`;
    return `Init:${index}/${initContainers.length}`;
  }
  const containers = list(status.containerStatuses);
  // Waiting failures take priority over a different container still running.
  for (const container of containers) {
    const reason = text(record(record(container.state).waiting).reason);
    if (reason) return reason;
  }
  for (const container of containers) {
    const stopped = record(record(container.state).terminated);
    if (Object.keys(stopped).length && stopped.exitCode !== 0) return termination(stopped);
  }
  const running = containers.some(container => record(container.state).running);
  if (running) {
    const ready = list(status.conditions).find(condition => condition.type === 'Ready');
    return ready?.status === 'False' ? 'NotReady' : 'Running';
  }
  if (containers.length && containers.every(container => record(record(container.state).terminated).exitCode === 0)) return 'Completed';
  if (list(status.conditions).some(condition => condition.type === 'PodScheduled' && condition.reason === 'SchedulingGated')) return 'SchedulingGated';
  return text(status.reason) ?? phase;
}
