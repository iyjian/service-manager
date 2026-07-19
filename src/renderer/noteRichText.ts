// This source wrapper gives the renderer compiler the canonical shared types
// and implementation. The renderer copy step replaces its emitted wrapper with
// the ESM build of the shared module, while restoring the main-process CJS
// artifact at dist/shared/noteRichText.js.
export * from '../shared/noteRichText.js';
