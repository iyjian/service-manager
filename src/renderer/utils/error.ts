/** Renders an unknown thrown value as a presentable message string. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

const IPC_ERROR_PREFIX_PATTERN = /^Error invoking remote method '[^']+': (?:Error: )?/;

/** Removes Electron's IPC invocation prefix (`Error invoking remote method '<channel>':`) from `message`. */
export function stripIpcErrorPrefix(message: string): string {
  return message.replace(IPC_ERROR_PREFIX_PATTERN, '');
}

/** `toErrorMessage` with Electron's IPC invocation prefix removed so the underlying message is shown. */
export function toCleanErrorMessage(error: unknown): string {
  return stripIpcErrorPrefix(toErrorMessage(error));
}
