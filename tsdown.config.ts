import { defineConfig } from 'tsdown'

/** Bundle the plugin entry; host-provided @deepseek-ai/* stay external (peers). */
export default defineConfig({
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
})