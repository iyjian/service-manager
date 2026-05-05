import type { ServiceStatus, TunnelStatus } from '../shared/types';

export function statusClass(status: ServiceStatus | TunnelStatus): string {
  if (status === 'running') return 'status-running';
  if (status === 'error') return 'status-error';
  if (status === 'starting' || status === 'stopping') return 'status-transition';
  return 'status-stopped';
}

export function canStartService(status: ServiceStatus): boolean {
  return status === 'stopped' || status === 'error';
}

export function canStopService(status: ServiceStatus): boolean {
  return status === 'running' || status === 'starting';
}

export function canStartForward(status: TunnelStatus): boolean {
  return status === 'stopped' || status === 'error';
}

export function canStopForward(status: TunnelStatus): boolean {
  return status === 'running' || status === 'starting';
}

export function formatStatus(status: string): string {
  return status.toUpperCase();
}

export function runtimeStatusMarker(status: ServiceStatus | TunnelStatus): string {
  return status === 'stopped' || status === 'unknown' ? '○' : '●';
}
