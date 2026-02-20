import type { ServiceApi } from '../shared/types';

declare global {
  interface Window {
    serviceApi: ServiceApi;
  }
}

export {};
