export interface MihomoProxyEntry {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  history?: { time: string; delay: number }[];
}

export class MihomoApi {
  constructor(
    private readonly controllerPort: number,
    private readonly secret: string
  ) {}

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.controllerPort}`;
  }

  private async request(method: string, endpoint: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secret}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`mihomo API ${method} ${endpoint} failed (HTTP ${response.status})${text ? `: ${text}` : ''}`);
    }
    return response;
  }

  async getVersion(): Promise<string> {
    const response = await this.request('GET', '/version');
    const data = (await response.json()) as { version?: string };
    return data.version ?? 'unknown';
  }

  async getProxies(): Promise<Record<string, MihomoProxyEntry>> {
    const response = await this.request('GET', '/proxies');
    const data = (await response.json()) as { proxies?: Record<string, MihomoProxyEntry> };
    return data.proxies ?? {};
  }

  async selectProxy(group: string, name: string): Promise<void> {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { name });
  }

  async patchConfigs(patch: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', '/configs', patch);
  }
}
