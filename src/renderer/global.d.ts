import type { KubernetesApi, NotesApi, ProxyApi, ServiceApi, SettingsApi } from '../shared/types';

declare global {
  interface Window {
    serviceApi: ServiceApi;
    notesApi: NotesApi;
    settingsApi: SettingsApi;
    proxyApi: ProxyApi;
    kubernetesApi: KubernetesApi;
  }
}

export {};
