import type {
  ForwardState,
  HostConfig,
  HostView,
  ServiceStatus,
  ServiceStatusChange,
  TunnelStatusChange,
} from '../shared/types';

interface ServiceRuntimeState {
  status: ServiceStatus;
  pid?: number;
  error?: string;
  updatedAt?: string;
}

interface ServiceForwardRuntimeState {
  state: ForwardState;
  error?: string;
}

export class RuntimeRegistry {
  private readonly serviceStatus = new Map<string, ServiceRuntimeState>();
  private readonly serviceForwardStatus = new Map<string, ServiceForwardRuntimeState>();

  getServiceStatus(hostId: string, serviceId: string, defaultPid?: number): ServiceRuntimeState {
    const status = this.serviceStatus.get(this.serviceKey(hostId, serviceId));
    return {
      status: status?.status ?? (defaultPid ? 'running' : 'stopped'),
      pid: status?.pid ?? defaultPid,
      error: status?.error,
      updatedAt: status?.updatedAt,
    };
  }

  getServiceForwardStatus(hostId: string, serviceId: string): ServiceForwardRuntimeState {
    return this.serviceForwardStatus.get(this.serviceKey(hostId, serviceId)) ?? { state: 'none' };
  }

  setServiceStatus(hostId: string, serviceId: string, status: ServiceStatus, pid?: number, error?: string): ServiceStatusChange {
    const forward = this.getServiceForwardStatus(hostId, serviceId);
    const payload: ServiceStatusChange = {
      hostId,
      serviceId,
      status,
      pid,
      error,
      updatedAt: new Date().toISOString(),
      forwardState: forward.state,
      forwardError: forward.error,
    };
    this.serviceStatus.set(this.serviceKey(hostId, serviceId), payload);
    return payload;
  }

  setServiceForwardStatus(hostId: string, serviceId: string, state: ForwardState, error?: string): ServiceRuntimeState {
    this.serviceForwardStatus.set(this.serviceKey(hostId, serviceId), { state, error });
    return this.getServiceStatus(hostId, serviceId);
  }

  toView(hosts: HostConfig[], getTunnelStatus: (forwardId: string) => TunnelStatusChange): HostView[] {
    return hosts.map((host) => ({
      ...host,
      forwards: host.forwards.map((forward) => {
        const status = getTunnelStatus(forward.id);
        return {
          ...forward,
          status: status.status,
          error: status.error,
          reconnectAt: status.reconnectAt,
        };
      }),
      services: host.services.map((service) => {
        const status = this.getServiceStatus(host.id, service.id, service.pid);
        const forward = this.getServiceForwardStatus(host.id, service.id);
        return {
          ...service,
          status: status.status,
          pid: status.pid,
          error: status.error,
          updatedAt: status.updatedAt,
          forwardState: service.forwardLocalPort && service.port > 0 ? forward.state : 'none',
          forwardError: service.forwardLocalPort && service.port > 0 ? forward.error : undefined,
        };
      }),
    }));
  }

  private serviceKey(hostId: string, serviceId: string): string {
    return `${hostId}:${serviceId}`;
  }
}
