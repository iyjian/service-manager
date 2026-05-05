import { randomUUID } from 'node:crypto';
import type { HostConfig, HostDraft } from '../shared/types';

export interface ExportedConfigFile {
  schemaVersion: number;
  exportedAt: string;
  app: string;
  hosts: HostConfig[];
}

export function countRules(hosts: HostConfig[]): number {
  return hosts.reduce((total, host) => total + host.forwards.length, 0);
}

export function countServices(hosts: HostConfig[]): number {
  return hosts.reduce((total, host) => total + host.services.length, 0);
}

export function parseImportedHostDrafts(data: unknown): HostDraft[] {
  if (Array.isArray(data)) {
    return data as HostDraft[];
  }
  if (data && typeof data === 'object') {
    const hosts = (data as { hosts?: unknown }).hosts;
    if (Array.isArray(hosts)) {
      return hosts as HostDraft[];
    }
  }
  throw new Error('Invalid config file format. Expected an array of hosts or an object with "hosts".');
}

export function ensureUniqueImportedIds(hosts: HostConfig[]): HostConfig[] {
  const hostIds = new Set<string>();
  const forwardIds = new Set<string>();
  const serviceIdsByHost = new Map<string, Set<string>>();

  return hosts.map((host) => {
    const nextHostId = host.id && !hostIds.has(host.id) ? host.id : randomUUID();
    hostIds.add(nextHostId);

    const forwards = host.forwards.map((forward) => {
      const nextForwardId = forward.id && !forwardIds.has(forward.id) ? forward.id : randomUUID();
      forwardIds.add(nextForwardId);
      return { ...forward, id: nextForwardId };
    });

    const serviceIds = serviceIdsByHost.get(nextHostId) ?? new Set<string>();
    serviceIdsByHost.set(nextHostId, serviceIds);
    const services = host.services.map((service) => {
      const nextServiceId = service.id && !serviceIds.has(service.id) ? service.id : randomUUID();
      serviceIds.add(nextServiceId);
      return { ...service, id: nextServiceId };
    });

    return {
      ...host,
      id: nextHostId,
      forwards,
      services,
    };
  });
}
