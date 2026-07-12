export const MAX_KUBERNETES_TERMINAL_INPUT_LENGTH = 65_536;

export function validateKubernetesTerminalInput(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_KUBERNETES_TERMINAL_INPUT_LENGTH
  ) {
    throw new Error('Kubernetes terminal input must be text within the allowed size.');
  }
  return value;
}
