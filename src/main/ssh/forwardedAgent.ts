import { AgentProtocol, BaseAgent, utils, type ParsedKey } from 'ssh2';
import type { Duplex } from 'node:stream';
import type { HostConfig } from '../../shared/types';
import { resolveHostPrivateKey } from './hostConnection';

const MAX_PACKET = 128 * 1024;

/** Validate packet lengths before ssh2 buffers untrusted agent requests. */
class BoundedAgentProtocol extends AgentProtocol {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private packet?: Buffer;
  private packetBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly released: () => void) {
    super(false);
    this.on('error', () => undefined);
    this.once('finish', () => this.destroy());
    this.touch();
  }
  private touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.destroy(), 30_000);
    this.timer.unref();
  }
  override _write(data: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.touch();
    const consume = (offset: number): void => {
      while (offset < data.length) {
        if (!this.packet) {
          while (this.headerBytes < 4 && offset < data.length) {
            this.header[this.headerBytes++] = data[offset++];
          }
          if (this.headerBytes < 4) break;
          const size = this.header.readUInt32BE(0);
          this.headerBytes = 0;
          if (size < 1 || size > MAX_PACKET) {
            callback(new Error('Invalid agent packet length.')); return;
          }
          this.packet = Buffer.allocUnsafe(size + 4);
          this.header.copy(this.packet);
          this.packetBytes = 4;
        }
        const count = Math.min(this.packet.length - this.packetBytes, data.length - offset);
        data.copy(this.packet, this.packetBytes, offset, offset + count);
        this.packetBytes += count; offset += count;
        if (this.packetBytes === this.packet.length) {
          const packet = this.packet;
          this.packet = undefined;
          // ssh2 does not consume unknown request payloads (including OpenSSH's
          // session-bind extension). Strip that payload so its failure response
          // stays in order without interpreting payload bytes as another frame.
          const supported = packet[4] === 11 || packet[4] === 13;
          const request = supported ? packet : Buffer.from([0, 0, 0, 1, 27]);
          super._write(request, encoding, (error) => {
            if (error) callback(error); else queueMicrotask(() => consume(offset));
          });
          return;
        }
      }
      callback();
    };
    consume(0);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    super._destroy(error, () => callback(error));
  }
  override destroy(error?: Error): this {
    clearTimeout(this.timer); this.released();
    return super.destroy(error);
  }
}

// OpenSSH agents return SSH-encoded ECDSA/DSA signatures, while key.sign()
// returns ASN.1 DER for these key types.
function agentSignature(signature: Buffer, type: string): Buffer {
  if (!type.startsWith('ecdsa-') && type !== 'ssh-dss') return signature;
  let offset = 0;
  const length = (): number => {
    const first = signature[offset++];
    if (first < 128) return first;
    const bytes = first & 127;
    if (bytes < 1 || bytes > 2 || offset + bytes > signature.length) throw new Error('Invalid signature');
    const value = signature.readUIntBE(offset, bytes); offset += bytes; return value;
  };
  if (signature[offset++] !== 0x30 || length() !== signature.length - offset) throw new Error('Invalid signature');
  const parts: Buffer[] = [];
  for (let i = 0; i < 2; i++) {
    if (signature[offset++] !== 0x02) throw new Error('Invalid signature');
    const size = length();
    if (!size || offset + size > signature.length) throw new Error('Invalid signature');
    let integer = signature.subarray(offset, offset + size); offset += size;
    if (type === 'ssh-dss') {
      while (integer.length > 20 && integer[0] === 0) integer = integer.subarray(1);
      if (integer.length > 20) throw new Error('Invalid signature');
      const padded = Buffer.alloc(20); integer.copy(padded, 20 - integer.length); parts.push(padded);
    } else {
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(integer.length); parts.push(prefix, integer);
    }
  }
  if (offset !== signature.length) throw new Error('Invalid signature');
  return Buffer.concat(parts);
}

/** A session-scoped agent exposing exactly one key; no OS agent or ssh binary. */
export class ForwardedKeyAgent extends BaseAgent {
  private key?: ParsedKey;
  private readonly streams = new Set<BoundedAgentProtocol>();
  private budget = 64;
  private budgetAt = Date.now();
  constructor(keyText: string, passphrase?: string) {
    super();
    const parsed = utils.parseKey(keyText, passphrase);
    if (parsed instanceof Error) throw new Error('Could not unlock the SSH agent forwarding key.');
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key?.isPrivateKey()) throw new Error('SSH agent forwarding requires a private key.');
    this.key = key;
  }
  private allowed(): boolean {
    const now = Date.now();
    this.budget = Math.min(64, this.budget + (now - this.budgetAt) / 100);
    this.budgetAt = now;
    if (!this.key || this.budget < 1) return false;
    this.budget--; return true;
  }
  override getIdentities(callback: (error: Error | null, keys?: ParsedKey[]) => void): void {
    if (!this.allowed()) { callback(new Error('SSH agent unavailable.')); return; }
    // AgentProtocol serializes only the public key, never its private material.
    const publicKey = utils.parseKey(`${this.key!.type} ${this.key!.getPublicSSH().toString('base64')}`);
    if (publicKey instanceof Error || Array.isArray(publicKey)) { callback(new Error('SSH agent unavailable.')); return; }
    callback(null, [publicKey]);
  }
  override sign(publicKey: unknown, data: Buffer, options: { hash?: string }, callback: (error: Error | null, signature?: Buffer) => void): void {
    if (!this.allowed() || !Buffer.isBuffer(data) || data.length > 64 * 1024
      || (options.hash !== undefined && options.hash !== 'sha256' && options.hash !== 'sha512')) {
      callback(new Error('SSH agent signing request rejected.')); return;
    }
    try {
      const requested = utils.parseKey(publicKey);
      if (requested instanceof Error || Array.isArray(requested)
        || !this.key!.getPublicSSH().equals(requested.getPublicSSH())) throw new Error('Unknown key');
      const signature = this.key!.sign(data, options.hash);
      if (signature instanceof Error) throw signature;
      callback(null, agentSignature(signature, this.key!.type));
    } catch { callback(new Error('SSH agent signing request rejected.')); }
  }
  override getStream(callback: (error: Error | null, stream?: Duplex) => void): void {
    if (!this.key || this.streams.size >= 16) { callback(new Error('SSH agent unavailable.')); return; }
    const stream = new BoundedAgentProtocol(() => this.streams.delete(stream));
    this.streams.add(stream);
    stream.on('identities', (request: unknown) => this.getIdentities((error, keys) => {
      if (error || !keys) stream.failureReply(request); else stream.getIdentitiesReply(request, keys);
    }));
    stream.on('sign', (request: unknown, key: unknown, data: Buffer, options: { hash?: string }) => {
      this.sign(key, data, options, (error, signature) => {
        if (error || !signature) stream.failureReply(request); else stream.signReply(request, signature);
      });
    });
    callback(null, stream);
  }
  dispose(): void {
    this.key = undefined;
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }
}

export async function createForwardedAgent(host: HostConfig): Promise<ForwardedKeyAgent | undefined> {
  if (host.forwardAgent === false) return undefined;
  const first = host.jumpHosts[0] ?? host;
  if (first.authType !== 'privateKey') return undefined;
  const key = host.jumpHosts.length ? first.privateKey : await resolveHostPrivateKey(host);
  if (!key?.trim()) return undefined;
  return new ForwardedKeyAgent(key, first.passphrase);
}
