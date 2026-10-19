/**
 * The `session` executor: one inbound task is one turn on the context's DSH
 * agent session; reply text becomes the task's output part. Live assistant
 * deltas are projected as artifact chunks so SendStreamingMessage carries real
 * progress before the terminal task. Works on any composition with an agent
 * loop (the `chat` skill and the default path).
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
            return
          }
          // Tool deltas are structured data parts; they let a streaming client
          // observe tool activity without pretending it is assistant text.
          if (event.id.length > 0) {
            execCtx.onEvent({
              type: 'artifact',
              artifactId: `tool-call-${event.id}`,
              name: event.name ?? 'tool-call',
              parts: [{ data: { toolCallId: event.id, name: event.name ?? null, argumentsDelta: event.argumentsDelta } }],
              append: true,
              lastChunk: false,
            })
          }
        },
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
        throw new Error('a2a: agent produced no reply')
      }
      return { parts: [{ text: reply }] }
    },
    disposeAll: () => pool.disposeAll(),
  }
}
