import type { KubernetesContextInfo, KubernetesNamespaceScope } from '../../shared/types';

export interface KubeconfigDocument {
  clusters: Array<{
    name: string;
    cluster: {
      'insecure-skip-tls-verify'?: boolean;
    };
  }>;
  users: Array<{
    name: string;
    user: {
      token?: string;
      'client-certificate-data'?: string;
      'client-key-data'?: string;
      'client-certificate'?: string;
      'client-key'?: string;
      exec?: unknown;
      username?: string;
      password?: string;
      'auth-provider'?: unknown;
    };
  }>;
  contexts: Array<{
    name: string;
    context: {
      cluster: string;
      user: string;
    };
  }>;
  'current-context'?: string;
}

/**
 * Safe, credential-free result used before a Kubernetes client is imported or
 * constructed. It deliberately exposes no raw kubeconfig values.
 */
export type KubeconfigCredentialPreflight =
  | 'supported'
  | 'missing-context'
  | 'auth-provider'
  | 'exec-auth'
  | 'missing-auth'
  | 'unsupported-auth';

function contextSignature(context: KubernetesContextInfo): string {
  return JSON.stringify([
    context.name,
    context.clusterName,
    context.userName,
    context.supported,
    context.unsupportedReason ?? null,
    context.tlsVerificationDisabled,
  ]);
}

export function classifyKubeconfig(document: KubeconfigDocument): KubernetesContextInfo[] {
  const clusters = new Map(document.clusters.map(({ name, cluster }) => [name, cluster]));
  const users = new Map(document.users.map(({ name, user }) => [name, user]));

  return document.contexts.map(({ name, context }) => {
    const user = users.get(context.user);
    const cluster = clusters.get(context.cluster);
    const unsupportedReason = classifyUnsupportedAuthentication(user);

    return {
      name,
      clusterName: context.cluster,
      userName: context.user,
      supported: unsupportedReason === undefined,
      ...(unsupportedReason ? { unsupportedReason } : {}),
      tlsVerificationDisabled: cluster?.['insecure-skip-tls-verify'] === true,
    };
  });
}

/**
 * Classifies the selected Context's credential form without returning the
 * credential itself. This is safe to run on raw parsed kubeconfig data before
 * loading the Kubernetes client, whose auth-provider setup can execute
 * credential plugins.
 */
export function preflightKubeconfigContext(
  document: unknown,
  contextName: string
): KubeconfigCredentialPreflight {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return 'missing-context';
  }

  const rawDocument = document as Partial<KubeconfigDocument>;
  if (!Array.isArray(rawDocument.contexts) || !Array.isArray(rawDocument.users)) {
    return 'missing-context';
  }

  const context = rawDocument.contexts.find((candidate) => (
    candidate
    && typeof candidate.name === 'string'
    && candidate.name === contextName
    && candidate.context
    && typeof candidate.context === 'object'
    && typeof candidate.context.user === 'string'
  ));
  if (!context) {
    return 'missing-context';
  }

  const user = rawDocument.users.find((candidate) => (
    candidate
    && typeof candidate.name === 'string'
    && candidate.name === context.context.user
    && candidate.user
    && typeof candidate.user === 'object'
    && !Array.isArray(candidate.user)
  ))?.user;

  return credentialPreflight(user);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function classifyUnsupportedAuthentication(
  user: KubeconfigDocument['users'][number]['user'] | undefined
): KubernetesContextInfo['unsupportedReason'] | undefined {
  const result = credentialPreflight(user);
  if (result === 'supported') {
    return undefined;
  }
  if (result === 'exec-auth' || result === 'missing-auth') {
    return result;
  }
  return 'unsupported-auth';
}

function credentialPreflight(
  user: KubeconfigDocument['users'][number]['user'] | undefined
): KubeconfigCredentialPreflight {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    return 'missing-auth';
  }

  // Auth providers can load plugins, refresh tokens, or run commands through
  // the Kubernetes client. Reject them before accepting a token or certificate
  // that happens to appear alongside the provider configuration.
  if (isConfigured(user['auth-provider'])) {
    return 'auth-provider';
  }

  // Never execute exec credentials. Treat them as unsupported even if another
  // credential-like field is present, so the supported set remains explicit.
  if (isConfigured(user.exec)) {
    return 'exec-auth';
  }

  const certificateCredential = classifyCertificateCredential(user);
  if (certificateCredential === 'incomplete') {
    return 'unsupported-auth';
  }

  if (isNonEmptyString(user.token) || certificateCredential === 'complete') {
    return 'supported';
  }

  if (Object.keys(user).length === 0) {
    return 'missing-auth';
  }

  return 'unsupported-auth';
}

function isConfigured(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function classifyCertificateCredential(user: KubeconfigDocument['users'][number]['user']): 'none' | 'complete' | 'incomplete' {
  const inlineCertificate = isNonEmptyString(user['client-certificate-data']);
  const inlineKey = isNonEmptyString(user['client-key-data']);
  const fileCertificate = isNonEmptyString(user['client-certificate']);
  const fileKey = isNonEmptyString(user['client-key']);
  const hasCertificateField = inlineCertificate || inlineKey || fileCertificate || fileKey;

  if (!hasCertificateField) {
    return 'none';
  }

  if (inlineCertificate && inlineKey && !fileCertificate && !fileKey) {
    return 'complete';
  }
  if (fileCertificate && fileKey && !inlineCertificate && !inlineKey) {
    return 'complete';
  }

  return 'incomplete';
}

export function diffKubeconfigContexts(
  before: KubernetesContextInfo[],
  after: KubernetesContextInfo[]
): boolean {
  const beforeSignatures = before.map(contextSignature).sort();
  const afterSignatures = after.map(contextSignature).sort();

  return beforeSignatures.length !== afterSignatures.length || beforeSignatures.some((value, index) => value !== afterSignatures[index]);
}

export function normalizeNamespaceScope(value: KubernetesNamespaceScope): KubernetesNamespaceScope {
  if (value.mode === 'all') {
    return { mode: 'all', namespaces: [] };
  }

  if (value.mode !== 'selected' || !Array.isArray(value.namespaces)) {
    throw new Error('Namespace scope must use All Namespaces or at least one Namespace.');
  }

  if (value.namespaces.some((namespace) => typeof namespace !== 'string')) {
    throw new Error('Namespace names must be strings.');
  }

  const namespaces = [...new Set(value.namespaces.map((namespace) => namespace.trim()).filter(Boolean))].sort();
  if (namespaces.length === 0) {
    throw new Error('Select at least one Namespace.');
  }

  return { mode: 'selected', namespaces };
}
