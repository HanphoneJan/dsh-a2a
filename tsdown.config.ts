import { defineConfig } from 'tsdown'

/** Double-face bundle: Node host half + browser dashboard half.
 * Host: ESM from tsc output, @deepseek-ai/* external (peers).
 * Browser: CJS wrapped into window.__ModuleLoader__.load by
 * scripts/build-client.mjs; react/cordis/ui-* stay external (the DSH browser
 * module table provides them at runtime). */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier) => specifier.startsWith('@deepseek-ai/'),
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: false,
    deps: {
      neverBundle: (specifier) =>
        specifier.startsWith('@deepseek-ai/')
        || specifier === 'react'
        || specifier.startsWith('react/'),
    },
  },
])