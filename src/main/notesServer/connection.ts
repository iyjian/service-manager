import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Agent, request } from 'node:http';
import type { Client, SFTPWrapper } from 'ssh2';
import { connectSshChain, closeSshClients, type SshEndpointConfig } from '../ssh/sshChain';

export const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
export class NotesServerConnection {
  private closed = false;
  constructor(readonly client: Client, readonly signal: AbortSignal) {
    client.once('close', () => { this.closed = true; });
  }
  get usable(): boolean { return !this.closed && !this.signal.aborted; }
  static async open(endpoint: SshEndpointConfig, signal: AbortSignal): Promise<NotesServerConnection> {
    const chain = await connectSshChain(endpoint, [], { signal, readyTimeout: 15_000, keepaliveInterval: 5_000, keepaliveCountMax: 2 });
    const result = new NotesServerConnection(chain.targetClient, signal);
    signal.addEventListener('abort', () => result.close(), { once: true }); return result;
  }
  close(): void { this.closed = true; closeSshClients([this.client]); }
  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Server command timed out.')); }, 90_000);
      this.client.exec(command, (error, stream) => {
        if (error) { clearTimeout(timer); reject(new Error('Cannot execute server command.')); return; }
        let out = ''; let overflow = false;
        stream.on('data', chunk => { out += chunk.toString(); if (out.length > 256_000) { overflow = true; stream.close(); } });
        stream.stderr.resume();
        stream.on('error', () => { clearTimeout(timer); reject(new Error('Server command failed.')); });
        stream.on('close', (code?: number) => { clearTimeout(timer); if (code !== 0 || overflow || this.signal.aborted) reject(new Error('Server command failed. Check systemd, permissions and runtime compatibility.')); else resolve(out.trim()); });
      });
    });
  }
  async sftp(): Promise<SFTPWrapper> { return new Promise((resolve, reject) => this.client.sftp((e, s) => e ? reject(new Error('Cannot open file transfer.')) : resolve(s))); }
  async write(remote: string, bytes: Buffer, mode = 0o600): Promise<void> {
    const sftp = await this.sftp();
    try { await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(remote, { mode });
      stream.once('error', () => reject(new Error('File upload failed.'))); stream.once('close', resolve); stream.end(bytes);
    }); } finally { sftp.end(); }
  }
  async read(remote: string, max = 1024 * 1024): Promise<Buffer> {
    const sftp = await this.sftp();
    try { return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0; const stream = sftp.createReadStream(remote);
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > max) stream.destroy(new Error('File too large.')); else chunks.push(chunk); });
      stream.once('error', () => reject(new Error('Cannot read server configuration. Deploy the server first.')));
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    }); } finally { sftp.end(); }
  }
  async uploadDirectory(local: string, remote: string): Promise<void> {
    await this.exec(`mkdir -p -- ${quote(remote)} && chmod 700 -- ${quote(remote)}`);
    for (const item of await fs.readdir(local, { withFileTypes: true })) {
      if (item.isDirectory()) await this.uploadDirectory(path.join(local, item.name), `${remote}/${item.name}`);
      else if (item.isFile()) await this.write(`${remote}/${item.name}`, await fs.readFile(path.join(local, item.name)));
    }
  }
  async api<T>(port: number, token: string, route: string, payload?: unknown, binary = false): Promise<T> {
    if (this.signal.aborted) throw new Error('Operation cancelled.');
    const socket = await new Promise<any>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, stream?: unknown): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(stream);
      };
      const abort = (): void => finish(new Error('Operation cancelled.'));
      const timer = setTimeout(() => finish(new Error('Notes server channel timed out.')), 15_000);
      this.signal.addEventListener('abort', abort, { once: true });
      this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, stream) => {
        if (settled) { stream?.destroy(); return; }
        finish(error ? new Error('Notes server is disconnected.') : undefined, stream);
      });
    });
    return new Promise<T>((resolve, reject) => {
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
      const req = request({ host: '127.0.0.1', port, path: route, method: data ? 'POST' : 'GET', agent,
        signal: this.signal, headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 128 * 1024 * 1024) req.destroy(new Error('Response too large.')); else chunks.push(chunk); });
        response.on('error', () => reject(new Error('Notes server response interrupted.')));
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          if (response.statusCode !== 200) {
            reject(Object.assign(new Error(response.statusCode === 409 ? 'Notes changed on another client. Your draft is preserved.' : 'Notes server request failed.'), { status: response.statusCode })); return;
          }
          try { resolve((binary ? bytes : JSON.parse(bytes.toString('utf8'))) as T); } catch { reject(new Error('Invalid Notes server response.')); }
        });
      });
      const timeout = setTimeout(() => req.destroy(new Error('Notes server request timed out.')), 30_000);
      req.on('error', () => reject(new Error('Notes server is disconnected.')));
      req.on('close', () => { clearTimeout(timeout); agent.destroy(); socket.destroy(); }); req.end(data);
    });
  }
}
