declare module 'ssh2' {
  import { EventEmitter } from 'node:events';
  import { Duplex, Readable, Writable } from 'node:stream';

  export interface ConnectConfig {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    sock?: Duplex;
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    readyTimeout?: number;
    authHandler?: Array<'password' | 'publickey'>;
    agent?: BaseAgent;
    agentForward?: boolean;
  }

  export interface ParsedKey {
    type: string;
    isPrivateKey(): boolean;
    getPublicSSH(): Buffer;
    equals(key: unknown): boolean;
    sign(data: Buffer, hash?: string): Buffer | Error;
  }
  export const utils: { parseKey(data: unknown, passphrase?: string): ParsedKey | ParsedKey[] | Error };
  export class BaseAgent {
    getIdentities(callback: (error: Error | null, keys?: ParsedKey[]) => void): void;
    sign(key: unknown, data: Buffer, options: { hash?: string }, callback: (error: Error | null, signature?: Buffer) => void): void;
    getStream(callback: (error: Error | null, stream?: Duplex) => void): void;
  }
  export class AgentProtocol extends Duplex {
    constructor(client: boolean);
    getIdentitiesReply(request: unknown, keys: ParsedKey[]): void;
    signReply(request: unknown, signature: Buffer): void;
    failureReply(request: unknown): void;
  }

  export interface ClientChannel extends Duplex {
    close(): void;
    on(event: 'error', listener: (error: Error) => void): this;
    stderr: Duplex;
    setWindow(rows: number, cols: number, height: number, width: number): void;
    on(event: 'close', listener: (code?: number, signal?: string) => void): this;
    on(event: 'data', listener: (data: Buffer | string) => void): this;
  }

  export interface SFTPWrapper {
    createReadStream(path: string): Readable;
    createWriteStream(path: string, options?: { mode?: number }): Writable;
    end(): void;
  }

  export class Client extends EventEmitter {
    sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): void;
    connect(config: ConnectConfig): this;
    end(): void;
    destroy(): void;
    shell(window: { term: string; cols: number; rows: number }, callback: (error: Error | undefined, channel: ClientChannel) => void): void;
    shell(window: { term: string; cols: number; rows: number }, options: { agentForward?: boolean }, callback: (error: Error | undefined, channel: ClientChannel) => void): void;
    exec(command: string, callback: (error: Error | undefined, channel: ClientChannel) => void): void;
    forwardOut(
      srcIP: string,
      srcPort: number,
      dstIP: string,
      dstPort: number,
      callback: (error: Error | undefined, stream: Duplex) => void
    ): void;
    once(event: 'ready', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'close', listener: () => void): this;
    on(event: 'ready', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: () => void): this;
  }
}
