import fs from 'node:fs';
import path from 'node:path';

export const DEVELOPMENT_USER_DATA_DIRECTORY_NAME = 'Service Manager Development';

export interface RuntimeProfileApp {
  readonly isPackaged: boolean;
  getPath(name: 'appData'): string;
  setPath(name: 'userData' | 'sessionData', value: string): void;
}

/**
 * Selects the local data profile before Electron or an imported runtime opens
 * any persistent state. Packaged builds retain Electron's existing paths.
 */
export function configureRuntimeDataProfile(app: RuntimeProfileApp): string | undefined {
  if (app.isPackaged) return undefined;

  const developmentRoot = path.join(
    app.getPath('appData'),
    DEVELOPMENT_USER_DATA_DIRECTORY_NAME,
  );
  fs.mkdirSync(developmentRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(developmentRoot, 0o700);
  app.setPath('userData', developmentRoot);
  app.setPath('sessionData', developmentRoot);
  return developmentRoot;
}
