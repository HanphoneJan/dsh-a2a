import { defineConfig } from 'vitest/config'

// Tests run against the harness checkout source graph. The local tsconfig
// extends the checkout's tsconfig.base.json; Vite's native tsconfig paths
// resolution applies that `paths` map, so @deepseek-ai/* resolve to the
// checkout's src/vendor independent of this package's own dependency layout.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})