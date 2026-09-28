import type { KubernetesApi, NotesApi, ProxyApi, ServiceApi, SettingsApi, SqlApi } from '../shared/types';

declare global {
  interface Window {
    vaultApi: import('../shared/types').VaultApi;
    notesServerApi: import('../shared/types').NotesServerApi;
    panelWindowApi: import('../shared/types').PanelWindowApi;
    serviceApi: ServiceApi;
    notesApi: NotesApi;
    settingsApi: SettingsApi;
    proxyApi: ProxyApi;
    kubernetesApi: KubernetesApi;
    sqlApi: SqlApi;
  }
}

export {};
