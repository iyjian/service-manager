export interface ProxyAutoStartRuntime {
  restoreRunningIntent(): Promise<unknown>;
}

type RetryWait = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

function isMixedPortConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Mixed port \d+ is already in use\./.test(message);
}

export async function restoreWithPortConflictRetry(
  runtime: ProxyAutoStartRuntime,
  wait: RetryWait = waitForRetryDelay,
  signal?: AbortSignal
): Promise<unknown | undefined> {
  const retryDelays = [200, 500, 1_000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (signal?.aborted) {
      return undefined;
    }
    try {
      return await runtime.restoreRunningIntent();
    } catch (error) {
      if (signal?.aborted) {
        return undefined;
      }
      if (!isMixedPortConflict(error) || attempt === retryDelays.length) {
        throw error;
      }
      await wait(retryDelays[attempt], signal);
      if (signal?.aborted) {
        return undefined;
      }
    }
  }

  throw new Error('Unreachable auto-start retry state.');
}

export function scheduleProxyAutoStart(
  runtime: ProxyAutoStartRuntime,
  onError: (error: unknown) => void,
  signal?: AbortSignal,
  wait?: RetryWait
): void {
  void restoreWithPortConflictRetry(runtime, wait, signal).catch((error) => {
    if (!signal?.aborted) {
      onError(error);
    }
  });
}

function waitForRetryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', settle);
      resolve();
    };
    const timer = setTimeout(settle, milliseconds);
    signal?.addEventListener('abort', settle, { once: true });
  });
}
