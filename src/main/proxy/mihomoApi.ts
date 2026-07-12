import type { ProxyTraffic } from '../../shared/types';
import { extractTrafficRecords } from './trafficStream';

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

  async *streamTraffic(signal: AbortSignal): AsyncGenerator<ProxyTraffic> {
    const endpoint = '/traffic';
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.secret}`,
      },
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`mihomo API GET ${endpoint} failed (HTTP ${response.status})${text ? `: ${text}` : ''}`);
    }
    if (!response.body) {
      throw new Error('mihomo API GET /traffic returned no response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remainder = '';
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
        const parsed = extractTrafficRecords(remainder + decoder.decode(value, { stream: true }));
        remainder = parsed.remainder;
        yield* parsed.records;
      }

      const finalChunk = extractTrafficRecords(remainder + decoder.decode());
      yield* finalChunk.records;
    } finally {
      if (!finished) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
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

  async getProxyDelay(name: string, url: string, timeoutMs: number): Promise<number> {
    const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
    const response = await this.request('GET', `/proxies/${encodeURIComponent(name)}/delay?${query}`);
    const data = (await response.json()) as { delay?: unknown };
    if (typeof data.delay !== 'number' || !Number.isFinite(data.delay) || data.delay < 0) {
      throw new Error(`mihomo delay response for ${name} is invalid.`);
    }
    return Math.round(data.delay);
  }

  async selectProxy(group: string, name: string): Promise<void> {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { name });
  }

  async patchConfigs(patch: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', '/configs', patch);
  }
}
