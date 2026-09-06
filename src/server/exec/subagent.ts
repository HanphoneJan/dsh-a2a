/**
 * The `subagent` executor: one inbound task is delegated to a named one-shot
 * subagent under the context's parent session. The child runs with the
 * composition's own tools and the delegation boundary; its output becomes the
 * task's artifact. The subagent seam must be mounted, else the skill binding
 * fails loudly at resolution time.
 * @module dsh-a2a/server/exec/subagent
 */

import type { A2aExecutor, A2aExecutorInput, A2aExecutorOutput } from '../executor.ts'
import { ContextSessionPool } from './agent-runtime.ts'

/** Structural slice of `ctx.subagents` this executor calls. */
export interface SubagentsLike {
  start(
    name: string,
    request: {
      readonly label?: string
      readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
      readonly parent: unknown
      readonly signal: AbortSignal
    },
  ): Promise<{ readonly result: Promise<{ readonly output: readonly { readonly type: string; readonly text?: string }[] }>; dispose(): Promise<void> }>
}

export interface SubagentExecutorOptions {
  readonly pool: ContextSessionPool
  readonly subagents: SubagentsLike
  /** Provider name (e.g. 'in-process'); configurable per deployment. */
  readonly provider: string
}

/** Build a subagent executor delegating inbound tasks to one-shot children. */
export function createSubagentExecutor(opts: SubagentExecutorOptions): A2aExecutor {
  const { pool, subagents, provider } = opts
  return {
    name: 'subagent',
    async execute(input: A2aExecutorInput, execCtx): Promise<A2aExecutorOutput> {
      if (!input.prompt) {
        return { parts: [{ text: 'No prompt provided.' }] }
      }
      const { agent } = await pool.agentFor(input.contextId)
      const run = await subagents.start(provider, {
        label: `a2a:${input.skill}`,
        prompt: [{ type: 'text', text: input.prompt }],
        parent: agent,
        signal: input.signal,
      })
      const result = await run.result
      const text = result.output
        .filter((b): b is { readonly type: string; readonly text: string } => typeof b.text === 'string')
        .map((b) => b.text)
        .filter(Boolean)
        .join('\n')
        .trim()
      execCtx.onEvent({
        type: 'artifact',
        artifactId: 'result',
        parts: [{ text: text || '(subagent returned no output)' }],
        name: input.skill,
        lastChunk: true,
      })
      return { parts: [{ text: text || '(subagent returned no output)' }] }
    },
    disposeAll: () => pool.disposeAll(),
  }
}