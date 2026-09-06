/**
 * The `session` executor: one inbound task is one turn on the context's DSH
 * agent session; reply text becomes the task's output part. Works on any
 * composition with an agent loop (the `chat` skill and the default path).
 * @module dsh-a2a/server/exec/session
 */

import type { A2aExecutor, A2aExecutorInput, A2aExecutorOutput } from '../executor.ts'
import { ContextSessionPool } from './agent-runtime.ts'

/** Build the session executor over a context session pool. */
export function createSessionExecutor(pool: ContextSessionPool): A2aExecutor {
  return {
    name: 'session',
    async execute(input: A2aExecutorInput): Promise<A2aExecutorOutput> {
      if (!input.prompt) {
        return { parts: [{ text: 'No prompt provided.' }] }
      }
      const reply = await pool.runTurn(input.contextId, input.prompt, input.signal)
      const text = (input.signal.aborted && !reply ? '(canceled)' : reply) || '(no reply)'
      return { parts: [{ text }] }
    },
    disposeAll: () => pool.disposeAll(),
  }
}