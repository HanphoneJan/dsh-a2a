/**
 * Subagent executor visibility: only `text` blocks reach the result artifact;
 * reasoning never does, and an empty visible output settles with a status text.
 * @module dsh-a2a/tests/unit/subagent.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { createSubagentExecutor } from '../../src/server/exec/subagent.ts'
import type { ContextSessionPool } from '../../src/server/exec/agent-runtime.ts'

function harness(output: Array<{ type: string; text?: string }>) {
  const events: unknown[] = []
  const pool = {
    agentFor: vi.fn(async () => ({ agent: { id: 'parent' } })),
    contentBlocks: vi.fn(async () => [{ type: 'text' as const, text: 'go' }]),
  } as unknown as ContextSessionPool
  const subagents = {
    start: vi.fn(async () => ({
      result: Promise.resolve({ output }),
      dispose: vi.fn(async () => {}),
    })),
  }
  const executor = createSubagentExecutor({ pool, subagents, provider: 'in-process' })
  return { executor, events, pool, subagents }
}

describe('createSubagentExecutor visibility', () => {
  it('filters reasoning out of the result and emits only visible text', async () => {
    const { executor, events } = harness([
      { type: 'reasoning', text: 'private thought' },
      { type: 'text', text: 'visible answer' },
    ])
    const result = await executor.execute(
      { taskId: 't', contextId: 'c', skill: 'chat', parts: [{ text: 'go' }], prompt: 'go', signal: new AbortController().signal },
      { onEvent: (event) => { events.push(event) } },
    )
    expect(result.parts).toEqual([{ text: 'visible answer' }])
    expect(JSON.stringify(events)).not.toContain('private thought')
    expect(events).toContainEqual(expect.objectContaining({ type: 'artifact', artifactId: 'result', parts: [{ text: 'visible answer' }] }))
  })

  it('completes without a result artifact when no visible text exists', async () => {
    const { executor, events } = harness([{ type: 'reasoning', text: 'private thought' }])
    const result = await executor.execute(
      { taskId: 't', contextId: 'c', skill: 'chat', parts: [{ text: 'go' }], prompt: 'go', signal: new AbortController().signal },
      { onEvent: (event) => { events.push(event) } },
    )
    expect(result).toMatchObject({ parts: [], appendResult: false })
    expect(result.statusMessage).toMatch(/without visible output/)
    expect(events).toEqual([])
  })
})
