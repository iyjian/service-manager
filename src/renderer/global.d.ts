import type { ProxyApi, ServiceApi } from '../shared/types';

declare global {
  interface Window {
    serviceApi: ServiceApi;
    proxyApi: ProxyApi;
  }
}

export {};
