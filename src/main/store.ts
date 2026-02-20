import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ForwardRule, ForwardRuleDraft, HostConfig, HostDraft, ServiceConfig, ServiceDraft } from '../shared/types';

export class ServiceStore {
  private hosts: HostConfig[] = [];

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this.hosts = this.normalize(data);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        this.hosts = [];
        await this.persist();
        return;
      }
      throw error;
    }
  }

  listHosts(): HostConfig[] {
    return this.hosts.map((host) => this.cloneHost(host));
  }

  findHostById(id: string): HostConfig | undefined {
    const host = this.hosts.find((item) => item.id === id);
    return host ? this.cloneHost(host) : undefined;
  }

  async upsertHost(host: HostConfig): Promise<void> {
    const index = this.hosts.findIndex((item) => item.id === host.id);
    if (index >= 0) {
      this.hosts[index] = this.cloneHost(host);
    } else {
      this.hosts.push(this.cloneHost(host));
    }
    await this.persist();
  }

  async removeHost(id: string): Promise<void> {
    this.hosts = this.hosts.filter((item) => item.id !== id);
    await this.persist();
  }

  async removeService(hostId: string, serviceId: string): Promise<void> {
    const index = this.hosts.findIndex((item) => item.id === hostId);
    if (index < 0) {
      return;
    }

    const host = this.hosts[index];
    this.hosts[index] = {
      ...host,
      services: host.services.filter((service) => service.id !== serviceId),
    };
    await this.persist();
  }

  async removeForward(hostId: string, forwardId: string): Promise<void> {
    const index = this.hosts.findIndex((item) => item.id === hostId);
    if (index < 0) {
      return;
    }

    const host = this.hosts[index];
    this.hosts[index] = {
      ...host,
      forwards: host.forwards.filter((forward) => forward.id !== forwardId),
    };
    await this.persist();
  }

  private normalize(data: unknown): HostConfig[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .map((item) => this.normalizeHost(item as Partial<HostDraft>))
      .filter((item): item is HostConfig => item !== null);
  }

  private normalizeHost(input: Partial<HostDraft>): HostConfig | null {
    if (!input.name || !input.sshHost || !input.username) {
      return null;
    }

    return {
      id: input.id?.trim() || randomUUID(),
      name: input.name.trim(),
      sshHost: input.sshHost.trim(),
      sshPort: Number(input.sshPort || 22),
      username: input.username.trim(),
      authType: input.authType === 'password' ? 'password' : 'privateKey',
      password: input.password,
      privateKey: input.privateKey,
      passphrase: input.passphrase,
      privateKeyPath: input.privateKeyPath,
      forwards: Array.isArray(input.forwards)
        ? input.forwards
            .map((forward) => this.normalizeForward(forward))
            .filter((forward): forward is ForwardRule => forward !== null)
        : [],
      services: Array.isArray(input.services)
        ? input.services
            .map((service) => this.normalizeService(service))
            .filter((service): service is ServiceConfig => service !== null)
        : [],
    };
  }

  private normalizeForward(input: Partial<ForwardRuleDraft>): ForwardRule | null {
    if (!input.localHost || !input.remoteHost || !input.localPort || !input.remotePort) {
      return null;
    }

    const localPort = Number(input.localPort);
    const remotePort = Number(input.remotePort);
    if (
      !Number.isInteger(localPort) ||
      localPort < 1 ||
      localPort > 65535 ||
      !Number.isInteger(remotePort) ||
      remotePort < 1 ||
      remotePort > 65535
    ) {
      return null;
    }

    return {
      id: input.id?.trim() || randomUUID(),
      localHost: input.localHost.trim(),
      localPort,
      remoteHost: input.remoteHost.trim(),
      remotePort,
      autoStart: Boolean(input.autoStart),
    };
  }

  private normalizeService(input: Partial<ServiceDraft>): ServiceConfig | null {
    if (!input.name || !input.startCommand || !input.port) {
      return null;
    }

    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    const forwardLocalPort = input.forwardLocalPort ? Number(input.forwardLocalPort) : undefined;
    if (
      forwardLocalPort !== undefined &&
      (!Number.isInteger(forwardLocalPort) || forwardLocalPort < 1 || forwardLocalPort > 65535)
    ) {
      return null;
    }

    return {
      id: input.id?.trim() || randomUUID(),
      name: input.name.trim(),
      startCommand: input.startCommand.trim(),
      port,
      forwardLocalPort,
      pid: typeof (input as Partial<ServiceConfig>).pid === 'number' ? (input as Partial<ServiceConfig>).pid : undefined,
      stdoutPath: (input as Partial<ServiceConfig>).stdoutPath,
      stderrPath: (input as Partial<ServiceConfig>).stderrPath,
    };
  }

  private cloneHost(host: HostConfig): HostConfig {
    return {
      ...host,
      forwards: host.forwards.map((forward) => ({ ...forward })),
      services: host.services.map((service) => ({ ...service })),
    };
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.hosts, null, 2), 'utf8');
  }
}
