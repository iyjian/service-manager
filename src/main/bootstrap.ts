import { app } from 'electron';
import { configureRuntimeDataProfile } from './appRuntimeProfile';

configureRuntimeDataProfile(app);

// Keep this runtime load after profile selection so static import side effects,
// Electron's ProcessSingleton, and every persistent store use the chosen root.
require('./main');
