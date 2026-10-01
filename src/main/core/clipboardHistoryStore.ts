import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ClipboardEntry {
  id: string;
  kind: 'text' | 'image';
  value: string;
  createdAt: number;
}
export const MAX_CLIPBOARD_BYTES = 2 * 1024 * 1024;

export function validClipboardValue(kind: unknown, value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value) <= MAX_CLIPBOARD_BYTES
    && Buffer.byteLength(JSON.stringify(value)) <= MAX_CLIPBOARD_BYTES + 2
    && (kind === 'text' || (kind === 'image' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)));
}

/** This file deliberately lives outside every synchronized store and export. */
export class ClipboardHistoryStore {
  entries: ClipboardEntry[] = [];
  accelerator: string;
  enabled = true;
  private lastFingerprint = '';

  constructor(private readonly filename: string, defaultAccelerator: string,
    private readonly encode: (text: string) => Buffer = text => Buffer.from(text),
    private readonly decode: (data: Buffer) => string = data => data.toString()) {
    this.accelerator = defaultAccelerator;
    if (!existsSync(filename)) return;
    if (statSync(filename).size > 64 * 1024 * 1024) throw new Error('Clipboard history file is too large.');
    // A damaged or unavailable encrypted file is never overwritten silently.
    const data = JSON.parse(decode(readFileSync(filename)));
    if (!data || !Array.isArray(data.entries)) throw new Error('Invalid clipboard history file.');
    this.entries = data.entries.filter((item: ClipboardEntry) => item && typeof item.id === 'string' && item.id.length <= 64
      && Number.isFinite(item.createdAt) && item.createdAt >= 0 && item.createdAt <= 8.64e15
      && validClipboardValue(item.kind, item.value)).slice(0, 20);
    if (typeof data.accelerator === 'string') this.accelerator = data.accelerator;
    this.enabled = data.enabled !== false;
  }

  capture(kind: 'text' | 'image', value: string): boolean {
    if (!validClipboardValue(kind, value)) { this.lastFingerprint = ''; return false; }
    const fingerprint = createHash('sha256').update(kind).update(value).digest('hex');
    if (fingerprint === this.lastFingerprint) return false;
    const previousFingerprint = this.lastFingerprint;
    const previousEntries = this.entries;
    this.lastFingerprint = fingerprint;
    this.entries = [{ id: randomUUID(), kind, value, createdAt: Date.now() },
      ...this.entries.filter(item => item.kind !== kind || item.value !== value)].slice(0, 20);
    try { this.save(); }
    catch (error) { this.entries = previousEntries; this.lastFingerprint = previousFingerprint; throw error; }
    return true;
  }

  forget(id?: string): void {
    const previousEntries = this.entries;
    this.entries = id === undefined ? [] : this.entries.filter(item => item.id !== id);
    try { this.save(); }
    catch (error) { this.entries = previousEntries; throw error; }
  }

  save(): void {
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp`;
    writeFileSync(temporary, this.encode(JSON.stringify({ entries: this.entries,
      accelerator: this.accelerator, enabled: this.enabled })), { mode: 0o600 });
    renameSync(temporary, this.filename);
  }
}
