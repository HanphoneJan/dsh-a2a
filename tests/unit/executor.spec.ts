/**
 * ExecutorSet unit tests: skill→kind resolution, session default, and the
 * loud failure when a subagent-bound skill has no subagent seam.
 * @module dsh-a2a/tests/unit/executor.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { ExecutorSet, type A2aExecutor } from '../../src/server/executor.ts'
import { TaskState } from '../../src/protocol.ts'

function stubExecutor(name: string): A2aExecutor {
  return {
    name,
    execute: vi.fn(async () => ({ parts: [] })),
  }
}

describe('ExecutorSet', () => {
  it('defaults skills to the session executor', () => {
    const session = stubExecutor('session')
    const set = new ExecutorSet({}, session, undefined)
    expect(set.resolve('anything')).toBe(session)
  })

  it('resolves a subagent-bound skill to the subagent executor', () => {
    const session = stubExecutor('session')
    const subagent = stubExecutor('subagent')
    const set = new ExecutorSet({ coding: 'subagent' }, session, subagent)
    expect(set.resolve('coding')).toBe(subagent)
  })

  it('fails loudly when a subagent-bound skill has no subagent seam', () => {
    const set = new ExecutorSet({ coding: 'subagent' }, stubExecutor('session'), undefined)
    expect(() => set.resolve('coding')).toThrow(/no subagent seam is mounted/)
  })
})
