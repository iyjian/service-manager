import type { KubernetesApi, ProxyApi, ServiceApi } from '../shared/types';

declare global {
  interface Window {
    serviceApi: ServiceApi;
    proxyApi: ProxyApi;
    kubernetesApi: KubernetesApi;
  }
}

export {};
