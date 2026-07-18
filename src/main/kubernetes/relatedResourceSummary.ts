import type { KubernetesRelatedBackendSummary } from '../../shared/types';

type UnknownRecord = Record<string, unknown>;

const MAX_BACKEND_PORTS = 32;
const MAX_BACKEND_TARGETS = 64;
const MAX_BACKEND_TEXT = 160;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function records(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = record(candidate);
    return item ? [item] : [];
  });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_BACKEND_TEXT)
    : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function uniqueBounded(values: string[], limit: number): { values: string[]; total: number } {
  const unique = [...new Set(values)].sort();
  return { values: unique.slice(0, limit), total: unique.length };
}

function portLabel(value: UnknownRecord): string | undefined {
  const port = integer(value.port);
  if (!port || port < 1 || port > 65_535) return undefined;
  const protocol = text(value.protocol) ?? 'TCP';
  const name = text(value.name);
  return name ? `${name} · ${port}/${protocol}` : `${port}/${protocol}`;
}

function targetLabel(value: UnknownRecord): string | undefined {
  const target = record(value.targetRef);
  const name = text(target?.name);
  if (!name) return undefined;
  const kind = text(target?.kind);
  return kind ? `${kind}/${name}` : name;
}

/** Maps one legacy Endpoints object without exposing any address field. */
export function mapKubernetesEndpointsSummary(value: Record<string, unknown>): KubernetesRelatedBackendSummary {
  const metadata = record(value.metadata);
  const subsets = records(value.subsets);
  const readyAddresses = subsets.flatMap((subset) => records(subset.addresses));
  const notReadyAddresses = subsets.flatMap((subset) => records(subset.notReadyAddresses));
  const ports = uniqueBounded(
    subsets.flatMap((subset) => records(subset.ports).flatMap((port) => {
      const label = portLabel(port);
      return label ? [label] : [];
    })),
    MAX_BACKEND_PORTS,
  );
  const targets = uniqueBounded(
    [...readyAddresses, ...notReadyAddresses].flatMap((address) => {
      const target = targetLabel(address);
      return target ? [target] : [];
    }),
    MAX_BACKEND_TARGETS,
  );
  return {
    kind: 'Endpoints',
    name: text(metadata?.name) ?? 'Endpoints',
    ready: readyAddresses.length,
    notReady: notReadyAddresses.length,
    ports: ports.values,
    portCount: ports.total,
    targets: targets.values,
    targetCount: targets.total,
  };
}

/** Maps EndpointSlices without exposing `endpoints[].addresses`. */
export function mapKubernetesEndpointSliceSummaries(
  values: Iterable<Record<string, unknown>>,
): KubernetesRelatedBackendSummary[] {
  return [...values].slice(0, 200).map((value) => {
    const metadata = record(value.metadata);
    const endpoints = records(value.endpoints);
    const ready = endpoints.filter((endpoint) => record(endpoint.conditions)?.ready !== false).length;
    const ports = uniqueBounded(
      records(value.ports).flatMap((port) => {
        const label = portLabel(port);
        return label ? [label] : [];
      }),
      MAX_BACKEND_PORTS,
    );
    const targets = uniqueBounded(
      endpoints.flatMap((endpoint) => {
        const target = targetLabel(endpoint);
        return target ? [target] : [];
      }),
      MAX_BACKEND_TARGETS,
    );
    return {
      kind: 'EndpointSlice',
      name: text(metadata?.name) ?? 'EndpointSlice',
      ready,
      notReady: endpoints.length - ready,
      ports: ports.values,
      portCount: ports.total,
      targets: targets.values,
      targetCount: targets.total,
    };
  });
}
