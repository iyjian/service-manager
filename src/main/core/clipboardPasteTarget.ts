import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface CaretRectangle { x: number; y: number; width: number; height: number }
export interface ClipboardPasteTarget {
  anchor?: CaretRectangle;
  paste(): Promise<void>;
  restore(): Promise<void>;
  dispose(): void;
}

export function clipboardPopupPosition(anchor: CaretRectangle, area: CaretRectangle,
  width = 360, height = 460): { x: number; y: number } {
  const below = anchor.y + anchor.height + 6;
  const y = below + height <= area.y + area.height ? below : anchor.y - height - 6;
  return {
    x: Math.round(Math.max(area.x, Math.min(anchor.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
  };
}

function runX11(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('xdotool', args, { timeout: 2500, maxBuffer: 4096 },
    (error, stdout) => error ? reject(new Error('Automatic paste requires X11 and xdotool.')) : resolve(stdout.trim())));
}

class MacPasteTarget implements ClipboardPasteTarget {
  anchor?: CaretRectangle;
  private child: ChildProcessWithoutNullStreams;
  private pending?: { resolve(value: Record<string, unknown>): void; reject(error: Error): void };
  private timer?: ReturnType<typeof setTimeout>;
  private failed = false;
  private readonly lines;

  constructor() {
    const helper = path.join(__dirname, '../native/clipboard-macos').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
    this.child = spawn(helper, [], { stdio: 'pipe' });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail());
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      if (line.length > 4096 || !this.pending) { this.fail(); return; }
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (!value || typeof value !== 'object') throw new Error();
        if (value.error) {
          const error = value.error === 'accessibility'
            ? 'Allow Service Manager in System Settings > Privacy & Security > Accessibility, then try again.'
            : 'The original text field could not be focused. Return to it and reopen clipboard history.';
          this.fail(new Error(error));
          return;
        }
        clearTimeout(this.timer);
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(value);
      } catch { this.fail(); }
    });
  }

  private fail(error = new Error('Clipboard target is unavailable. Reopen clipboard history in the text field.')): void {
    this.failed = true;
    clearTimeout(this.timer);
    this.pending?.reject(error);
    this.pending = undefined;
    this.child.kill();
  }

  private request(command?: 'paste' | 'restore'): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.failed || this.pending) { reject(new Error('Clipboard target is unavailable.')); return; }
      this.pending = { resolve, reject };
      this.timer = setTimeout(() => this.fail(), 3000);
      if (command) this.child.stdin.write(`${command}\n`);
    });
  }

  async capture(): Promise<void> {
    const result = await this.request();
    if (!Number.isInteger(result.pid) || (result.pid as number) <= 0) { this.dispose(); throw new Error('No paste target.'); }
    const anchor = result.anchor as CaretRectangle | undefined;
    if (anchor && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(anchor[key as keyof CaretRectangle]))
      && Math.abs(anchor.x) <= 1_000_000 && Math.abs(anchor.y) <= 1_000_000
      && anchor.width >= 0 && anchor.width <= 1_000_000 && anchor.height > 0 && anchor.height <= 1_000_000) this.anchor = anchor;
  }

  async paste(): Promise<void> {
    const result = await this.request('paste');
    if (result.ok !== true) throw new Error('Paste could not be sent to the original text field.');
  }

  async restore(): Promise<void> { await this.request('restore'); }
  dispose(): void {
    this.fail();
    this.lines.close();
  }
}

export async function captureClipboardPasteTarget(): Promise<ClipboardPasteTarget> {
  if (process.platform === 'darwin') {
    const target = new MacPasteTarget();
    try { await target.capture(); return target; }
    catch (error) { target.dispose(); throw error; }
  }
  if (process.platform !== 'linux' || process.env.WAYLAND_DISPLAY) {
    throw new Error('Automatic paste is not available in this desktop session.');
  }
  const window = await runX11(['getactivewindow']);
  if (!/^\d+$/.test(window)) throw new Error('No paste target.');
  return {
    async paste() { await runX11(['windowactivate', '--sync', window, 'key', '--clearmodifiers', 'ctrl+v']); },
    async restore() { await runX11(['windowactivate', '--sync', window]); },
    dispose() {},
  };
}
