/**
 * The `session` executor: one inbound task is one turn on the context's DSH
 * agent session; reply text becomes the task's output part. Live assistant
 * text deltas are projected as `result` artifact chunks so
 * SendStreamingMessage carries real progress before the terminal task. Tool
 * lifecycle is exposed only through the opt-in trace metadata channel; it is
 * never modelled as an artifact.
 * @module dsh-a2a/server/exec/session
 */

import type { A2aExecutor, A2aExecutorInput, A2aExecutorOutput } from '../executor.ts'
import { ContextSessionPool } from './agent-runtime.ts'

/** Build the session executor over a context session pool. */
export function createSessionExecutor(pool: ContextSessionPool): A2aExecutor {
  return {
    name: 'session',
    async execute(input: A2aExecutorInput, execCtx): Promise<A2aExecutorOutput> {
      if (input.parts.length === 0) {
        return { parts: [{ text: 'No prompt provided.' }] }
      }
      let streamed = false
      const reply = await pool.runTurn(input.contextId, input.parts, input.signal, {
        onEvent: (event) => {
          if (event.type === 'text-delta') {
            streamed = true
            execCtx.onEvent({ type: 'artifact', artifactId: 'result', parts: [{ text: event.text }], append: true, lastChunk: false })
          }
        },
        ...(input.trace === true
          ? { onTrace: (call) => execCtx.onEvent({ type: 'trace', call }) }
          : {}),
      })
      if (streamed) {
        // Close the incremental artifact without appending another copy of the
        // text: runTask must not append `reply` as a second result artifact.
        execCtx.onEvent({ type: 'artifact', artifactId: 'result', parts: [], append: true, lastChunk: true })
        return { parts: [], appendResult: false }
      }
      if (input.signal.aborted) {
        return { parts: [{ text: '(canceled)' }] }
      }
      if (reply.length === 0) {
        return {
          parts: [],
          appendResult: false,
          statusMessage: 'The agent completed without visible output.',
        }
      }
      return { parts: [{ text: reply }] }
    },
    disposeAll: () => pool.disposeAll(),
  }
}
