export type AuthType = 'password' | 'privateKey';

export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown' | 'error';
export type ForwardState = 'none' | 'ok' | 'error';

export interface ServiceConfig {
  id: string;
  name: string;
  startCommand: string;
  port: number;
  forwardLocalPort?: number;
  pid?: number;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface HostConfig {
  id: string;
  name: string;
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  privateKeyPath?: string;
  services: ServiceConfig[];
}

export interface ServiceRuntime extends ServiceConfig {
  status: ServiceStatus;
  error?: string;
  updatedAt?: string;
  forwardState?: ForwardState;
  forwardError?: string;
}

export interface HostView extends Omit<HostConfig, 'services'> {
  services: ServiceRuntime[];
}

export interface ServiceDraft {
  id?: string;
  name: string;
  startCommand: string;
  port: number;
  forwardLocalPort?: number;
}

export interface HostDraft {
  id?: string;
  name: string;
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  privateKeyPath?: string;
  services: ServiceDraft[];
}

export interface PrivateKeyImportResult {
  path: string;
  content: string;
}

export interface ServiceStatusChange {
  hostId: string;
  serviceId: string;
  status: ServiceStatus;
  pid?: number;
  error?: string;
  updatedAt?: string;
  forwardState?: ForwardState;
  forwardError?: string;
}

export interface ServiceLogsResult {
  stdout: string;
  stderr: string;
}

export interface ServiceApi {
  listHosts: () => Promise<HostView[]>;
  saveHost: (host: HostDraft) => Promise<HostView>;
  deleteHost: (id: string) => Promise<void>;
  deleteService: (hostId: string, serviceId: string) => Promise<void>;
  startService: (hostId: string, serviceId: string) => Promise<void>;
  stopService: (hostId: string, serviceId: string) => Promise<void>;
  refreshService: (hostId: string, serviceId: string) => Promise<void>;
  getServiceLogs: (hostId: string, serviceId: string) => Promise<ServiceLogsResult>;
  importPrivateKey: () => Promise<PrivateKeyImportResult | null>;
  openExternal: (url: string) => Promise<void>;
  onStatusChanged: (listener: (change: ServiceStatusChange) => void) => () => void;
}
