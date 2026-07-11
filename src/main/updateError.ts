export type UpdateTrigger = 'auto' | 'manual';

export interface UpdateFailureClassification {
  message: string;
  isNetworkError: boolean;
  shouldRetry: boolean;
  shouldShowError: boolean;
}

const NETWORK_ERROR_CODES = [
  'net::err_network_changed',
  'net::err_internet_disconnected',
  'net::err_name_not_resolved',
  'net::err_connection_aborted',
  'net::err_connection_closed',
  'net::err_connection_failed',
  'net::err_connection_refused',
  'net::err_connection_reset',
  'net::err_connection_timed_out',
  'net::err_address_unreachable',
  'net::err_tunnel_connection_failed',
];

export function classifyUpdateFailure(
  rawMessage: string,
  trigger: UpdateTrigger,
  automaticRetryAttempted: boolean,
  canRetryAutomatically = true
): UpdateFailureClassification {
  const normalized = rawMessage.toLowerCase();
  const isNetworkError = NETWORK_ERROR_CODES.some((code) => normalized.includes(code));
  const shouldRetry = trigger === 'auto' && isNetworkError && !automaticRetryAttempted && canRetryAutomatically;
  const shouldShowError = trigger === 'manual' || !isNetworkError || !canRetryAutomatically;

  return {
    message: buildFriendlyError(rawMessage, shouldRetry),
    isNetworkError,
    shouldRetry,
    shouldShowError,
  };
}

function buildFriendlyError(rawMessage: string, retrying: boolean): string {
  const normalized = rawMessage.toLowerCase();

  if (normalized.includes('net::err_network_changed')) {
    return retrying
      ? 'Update check failed because the network changed. Retrying shortly.'
      : 'Update check failed because the network changed.';
  }
  if (normalized.includes('net::err_internet_disconnected')) {
    return 'Update check failed: no internet connection.';
  }
  if (normalized.includes('net::err_name_not_resolved')) {
    return 'Update check failed: DNS lookup failed.';
  }
  if (NETWORK_ERROR_CODES.some((code) => normalized.includes(code))) {
    return 'Update check failed: network connection failed.';
  }
  if (normalized.includes('status code 404')) {
    return 'Update metadata was not found in the release assets.';
  }
  if (normalized.includes('cannot find channel')) {
    return 'Update channel metadata is missing.';
  }
  if (
    normalized.includes('code signature') ||
    normalized.includes('did not pass validation') ||
    rawMessage.includes('代码不含资源')
  ) {
    return 'Update check failed: macOS signature validation blocked this update. Run in Terminal:\n' +
      'xattr -dr com.apple.quarantine "/Applications/Service Manager.app"\n' +
      'open -a "Service Manager"';
  }

  return `Update check failed: ${rawMessage}`;
}
