import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import {
  SENTRY_MAIN_DISABLED_INTEGRATIONS,
  createDisabledSentryDataCollection,
  sanitizeSentryEvent,
} from '../shared/sentryPrivacy';

const SENTRY_DSN = 'https://aa1d0f984487e9599bdca218d137794a@o209654.ingest.us.sentry.io/4511762598002688';

Sentry.init({
  dsn: SENTRY_DSN,
  release: `${app.getName().replace(/\W/g, '-')}@${app.getVersion()}`,
  environment: app.isPackaged ? 'production' : 'development',
  initialScope: {
    tags: {
      'service-manager.process': 'main',
    },
  },
  sendDefaultPii: false,
  dataCollection: createDisabledSentryDataCollection(),
  attachScreenshot: false,
  includeLocalVariables: false,
  enableRendererProfiling: false,
  enableLogs: false,
  enableMetrics: false,
  sendClientReports: false,
  tracesSampleRate: 0,
  profilesSampleRate: 0,
  maxBreadcrumbs: 0,
  skipOpenTelemetrySetup: true,
  beforeBreadcrumb: () => null,
  beforeSend: (event, hint) => sanitizeSentryEvent(event, hint, 'main'),
  beforeSendTransaction: () => null,
  beforeSendLog: () => null,
  beforeSendMetric: () => null,
  integrations: (defaults) => defaults.filter(
    (integration) => !SENTRY_MAIN_DISABLED_INTEGRATIONS.has(integration.name),
  ),
});

export async function flushSentry(): Promise<void> {
  try {
    await Sentry.flush(1_500);
  } catch {
    // Error telemetry must never interfere with application shutdown.
  }
}
