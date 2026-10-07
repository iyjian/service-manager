import { createHash } from 'node:crypto';
interface ClipboardPort { writeText(value: string): void; readText(): string; clear(): void; }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let protectedHash: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Shared with the application's clipboard-history capture; never persist Vault copies. */
export function isVaultClipboardValue(value: string): boolean {
  return protectedHash !== undefined && digest(value) === protectedHash;
}
export function copyVaultValue(clipboard: ClipboardPort, value: string, lifetime = 30_000): void {
  clearTimeout(timer);
  protectedHash = digest(value);
  try { clipboard.writeText(value); } catch (error) { protectedHash = undefined; throw error; }
  timer = setTimeout(() => {
    try { if (isVaultClipboardValue(clipboard.readText())) clipboard.clear(); }
    catch { /* Clipboard ownership may have changed or the OS may be unavailable. */ }
    finally { protectedHash = undefined; timer = undefined; }
  }, lifetime);
  timer.unref();
}
