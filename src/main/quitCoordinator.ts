export type AppQuitIntent = 'normal' | 'install-update' | 'signal';

export const DEFAULT_APP_QUIT_CLEANUP_TIMEOUT_MS = 8_000;

export interface AppQuitCoordinatorTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AppQuitCoordinatorOptions {
  abortAutoStart(): void;
  cleanup(): Promise<void>;
  reportCleanupError(error: unknown): void | Promise<void>;
  quit(): void;
  installUpdate(): void;
  exit(): void;
  cleanupTimeoutMs?: number;
  timer?: AppQuitCoordinatorTimer;
}

type CleanupOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: unknown }
  | { status: 'timed-out' };

const defaultTimer: AppQuitCoordinatorTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AppQuitCleanupTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Application runtime cleanup exceeded ${timeoutMs} ms`);
    this.name = 'AppQuitCleanupTimeoutError';
  }
}

function mergeQuitIntent(current: AppQuitIntent, requested: AppQuitIntent): AppQuitIntent {
  if (current === 'signal' || requested === 'signal') return 'signal';
  if (current === 'install-update' || requested === 'install-update') return 'install-update';
  return 'normal';
}

/**
 * Owns the single asynchronous application-exit sequence. In particular, an
 * update installer is not launched until app-owned runtimes have stopped or
 * the bounded cleanup deadline expires, so a stuck runtime cannot strand quit.
 */
export class AppQuitCoordinator {
  private intent: AppQuitIntent = 'normal';
  private cleanupPromise?: Promise<void>;
  private quitAllowed = false;
  private readonly cleanupTimeoutMs: number;
  private readonly timer: AppQuitCoordinatorTimer;

  constructor(private readonly options: AppQuitCoordinatorOptions) {
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_APP_QUIT_CLEANUP_TIMEOUT_MS;
    this.timer = options.timer ?? defaultTimer;
  }

  public canQuitImmediately(): boolean {
    return this.quitAllowed;
  }

  public request(intent: AppQuitIntent): Promise<void> {
    if (this.quitAllowed) return Promise.resolve();

    this.intent = mergeQuitIntent(this.intent, intent);
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.run();
    }
    return this.cleanupPromise;
  }

  private async run(): Promise<void> {
    try {
      this.options.abortAutoStart();
    } catch (error) {
      this.reportCleanupError(error);
    }

    try {
      const outcome = await this.waitForCleanup();
      if (outcome.status === 'failed') {
        this.reportCleanupError(outcome.error);
      } else if (outcome.status === 'timed-out') {
        this.reportCleanupError(new AppQuitCleanupTimeoutError(this.cleanupTimeoutMs));
      }
    } catch (error) {
      // Timer implementations are injectable for deterministic tests. A timer
      // failure is diagnostic-only and must not block the final quit action.
      this.reportCleanupError(error);
    }

    // Set the bypass before invoking any Electron/updater final action. Both
    // app.quit() and quitAndInstall() synchronously begin another quit event.
    this.quitAllowed = true;
    if (this.intent === 'signal') {
      this.options.exit();
    } else if (this.intent === 'install-update') {
      this.options.installUpdate();
    } else {
      this.options.quit();
    }
  }

  private async waitForCleanup(): Promise<CleanupOutcome> {
    // Convert cleanup rejection into data before racing it with the deadline.
    // The attached rejection handler remains alive if the deadline wins, so a
    // later cleanup rejection cannot become an unhandled promise rejection.
    const cleanupOutcome = (async (): Promise<CleanupOutcome> => {
      try {
        await this.options.cleanup();
        return { status: 'completed' };
      } catch (error) {
        return { status: 'failed', error };
      }
    })();

    let timeoutHandle: unknown;
    let timeoutScheduled = false;
    const timeoutOutcome = new Promise<CleanupOutcome>((resolve) => {
      timeoutHandle = this.timer.setTimeout(
        () => resolve({ status: 'timed-out' }),
        this.cleanupTimeoutMs,
      );
      timeoutScheduled = true;
    });

    try {
      return await Promise.race([cleanupOutcome, timeoutOutcome]);
    } finally {
      if (timeoutScheduled) {
        try {
          this.timer.clearTimeout(timeoutHandle);
        } catch (error) {
          this.reportCleanupError(error);
        }
      }
    }
  }

  private reportCleanupError(error: unknown): void {
    try {
      void Promise.resolve(this.options.reportCleanupError(error)).catch(() => undefined);
    } catch {
      // Cleanup diagnostics are best effort and cannot strand the process or
      // surface a detached rejection after a deadline has already won.
    }
  }
}
