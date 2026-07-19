import * as Sentry from '@sentry/electron/renderer';
import {
  SENTRY_RENDERER_DISABLED_INTEGRATIONS,
  createDisabledSentryDataCollection,
  normalizeSentryScope,
  sanitizeSentryEvent,
} from './sentryPrivacy.js';

Sentry.init({
  initialScope: {
    tags: {
      'service-manager.process': 'renderer',
    },
  },
  sendDefaultPii: false,
  dataCollection: createDisabledSentryDataCollection(),
  enableLogs: false,
  enableMetrics: false,
  autoSessionTracking: false,
  sendClientReports: false,
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
  beforeSend: (event, hint) => sanitizeSentryEvent(event, hint, 'renderer'),
  beforeSendTransaction: () => null,
  beforeSendLog: () => null,
  beforeSendMetric: () => null,
  integrations: (defaults) => defaults.filter(
    (integration) => !SENTRY_RENDERER_DISABLED_INTEGRATIONS.has(integration.name),
  ),
});

export function captureRendererException(scope: string, error: unknown): void {
  try {
    const capturedError = error instanceof Error ? error : new Error('Captured renderer error');
    Sentry.withScope((eventScope) => {
      eventScope.setTag('service-manager.scope', normalizeSentryScope(scope));
      Sentry.captureException(capturedError);
    });
  } catch {
    // Telemetry is best effort and must never disrupt the renderer.
  }
}

window.addEventListener('error', (event) => {
  captureRendererException('window:error', event.error ?? new Error('Unexpected renderer error'));
});

window.addEventListener('unhandledrejection', (event) => {
  captureRendererException('window:unhandledrejection', event.reason);
});
