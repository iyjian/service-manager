declare module 'ssh2' {
  import { EventEmitter } from 'node:events';
  import { Duplex } from 'node:stream';

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
  }

  export interface ClientChannel extends Duplex {
    stderr: Duplex;
    on(event: 'close', listener: (code?: number, signal?: string) => void): this;
    on(event: 'data', listener: (data: Buffer | string) => void): this;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    end(): void;
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
