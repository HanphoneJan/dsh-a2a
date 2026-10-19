import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../deepseek-harness/vitest.shared.ts'

// Tests run against the harness checkout source graph. The local tsconfig
// extends the checkout's tsconfig.base.json; Vite's native tsconfig paths
// resolution applies that `paths` map, so @deepseek-ai/* resolve to the
// checkout's src/vendor independent of this package's own dependency layout.
//
// `standardDecoratorPlugin` comes from the harness's own test config: harness
// source uses standard TypeScript decorators (`@Remote`), and Vite's default
// parser rejects that syntax before any test runs. Integration tests that
// value-import the agent loop, LLM runtime, or session persistence need it.
export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})