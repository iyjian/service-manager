import type { KubernetesPortForwardState } from '../../shared/types';

export interface KubernetesDeclaredPortSource {
  owner?: string;
  name?: string;
  source: 'container' | 'restartable-init' | 'service';
}

export interface KubernetesDeclaredPort {
  remotePort: number;
  declarations: KubernetesDeclaredPortSource[];
}

type UnknownRecord = Record<string, unknown>;
type KubernetesOverviewLabel = 'Kind' | 'Namespace' | 'Status' | 'Name' | 'Pod IP';

export interface KubernetesPortForwardTarget {
  targetKind: 'pod' | 'service';
  namespace: string;
  targetName: string;
}

/** Matches only live forwards owned by the exact drawer resource. */
export function hasActiveKubernetesPortForward(
  forwards: readonly KubernetesPortForwardState[],
  target: KubernetesPortForwardTarget,
): boolean {
  return forwards.some((forward) => (
    (forward.state === 'starting' || forward.state === 'running')
    && forward.targetKind === target.targetKind
    && forward.namespace === target.namespace
    && forward.targetName === target.targetName
  ));
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isTcpPortDeclaration(value: UnknownRecord, key: 'containerPort' | 'port'): value is UnknownRecord & Record<typeof key, number> {
  const port = value[key];
  return (value.protocol === undefined || value.protocol === 'TCP')
    && typeof port === 'number'
    && Number.isInteger(port)
    && port >= 1
    && port <= 65535;
}

function appendDeclaredPort(
  result: KubernetesDeclaredPort[],
  byPort: Map<number, KubernetesDeclaredPort>,
  remotePort: number,
  declaration: KubernetesDeclaredPortSource,
): void {
  const existing = byPort.get(remotePort);
  if (existing) {
    existing.declarations.push(declaration);
    return;
  }
  const declaredPort = { remotePort, declarations: [declaration] };
  byPort.set(remotePort, declaredPort);
  result.push(declaredPort);
}

function declaredPortSource(
  source: KubernetesDeclaredPortSource['source'],
  owner: unknown,
  name: unknown,
): KubernetesDeclaredPortSource {
  const declaration: KubernetesDeclaredPortSource = { source };
  const ownerText = nonEmptyString(owner);
  const nameText = nonEmptyString(name);
  if (ownerText !== undefined) declaration.owner = ownerText;
  if (nameText !== undefined) declaration.name = nameText;
  return declaration;
}

function collectContainerPorts(
  containers: unknown,
  source: 'container' | 'restartable-init',
  result: KubernetesDeclaredPort[],
  byPort: Map<number, KubernetesDeclaredPort>,
): void {
  if (!Array.isArray(containers)) return;
  for (const candidate of containers) {
    const container = asRecord(candidate);
    if (!container || (source === 'restartable-init' && container.restartPolicy !== 'Always')) continue;
    if (!Array.isArray(container.ports)) continue;
    for (const candidatePort of container.ports) {
      const port = asRecord(candidatePort);
      if (!port || !isTcpPortDeclaration(port, 'containerPort')) continue;
      appendDeclaredPort(
        result,
        byPort,
        port.containerPort,
        declaredPortSource(source, container.name, port.name),
      );
    }
  }
}

export function detectKubernetesForwardPorts(
  detail: Record<string, unknown>,
  targetKind: 'pod' | 'service',
): KubernetesDeclaredPort[] {
  const result: KubernetesDeclaredPort[] = [];
  const byPort = new Map<number, KubernetesDeclaredPort>();
  const spec = asRecord(detail.spec);
  if (!spec) return result;

  if (targetKind === 'pod') {
    collectContainerPorts(spec.containers, 'container', result, byPort);
    collectContainerPorts(spec.initContainers, 'restartable-init', result, byPort);
    return result;
  }

  if (!Array.isArray(spec.ports)) return result;
  for (const candidatePort of spec.ports) {
    const port = asRecord(candidatePort);
    if (!port || !isTcpPortDeclaration(port, 'port')) continue;
    appendDeclaredPort(
      result,
      byPort,
      port.port,
      declaredPortSource('service', undefined, port.name),
    );
  }
  return result;
}

export function buildKubernetesPortForwardDialogModel(
  ports: readonly KubernetesDeclaredPort[],
): {
  remotePort: string;
  selectorVisible: boolean;
} {
  if (ports.length === 0) {
    return {
      remotePort: '',
      selectorVisible: false,
    };
  }
  if (ports.length === 1) {
    return {
      remotePort: String(ports[0].remotePort),
      selectorVisible: false,
    };
  }
  return {
    remotePort: '',
    selectorVisible: true,
  };
}

export function buildKubernetesOverviewFields(
  detail: Record<string, unknown>,
  fallback: { kind: string; name: string; namespace?: string; status?: string },
): Array<{ label: KubernetesOverviewLabel; value: string }> {
  const metadata = asRecord(detail.metadata);
  const status = asRecord(detail.status);
  const kind = nonEmptyString(detail.kind) ?? fallback.kind;
  const fields: Array<[KubernetesOverviewLabel, string | undefined]> = [
    ['Kind', kind],
    ['Namespace', nonEmptyString(metadata?.namespace) ?? fallback.namespace],
    ['Status', nonEmptyString(status?.phase) ?? fallback.status],
    ['Name', nonEmptyString(metadata?.name) ?? fallback.name],
  ];
  if (kind.toLowerCase() === 'pod') {
    fields.push(['Pod IP', nonEmptyString(status?.podIP)]);
  }
  return fields.flatMap(([label, value]) => value ? [{ label, value }] : []);
}
