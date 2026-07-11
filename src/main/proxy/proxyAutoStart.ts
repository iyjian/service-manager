export interface ProxyAutoStartRuntime {
  restoreRunningIntent(): Promise<unknown>;
}

export function scheduleProxyAutoStart(
  runtime: ProxyAutoStartRuntime,
  onError: (error: unknown) => void
): void {
  void runtime.restoreRunningIntent().catch(onError);
}
