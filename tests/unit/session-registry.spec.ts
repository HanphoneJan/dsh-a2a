/**
 * Session-layer unit tests: the per-instance streaming registry and the
 * per-context view aggregation over the shared task store, including the
 * degraded path (no agent loop / no live pool) that must still render rows.
 * @module dsh-a2a/tests/unit/session-registry.spec
 */

import { describe, expect, it } from 'vitest'
import { ContextSessionRegistry, aggregateSessionViews, type SessionInstanceLike } from '../../src/server/session-registry.ts'
import { TaskState, type TaskRecord } from '../../src/protocol.ts'

/** One fabricated task record with the fields aggregation reads. */
function task(overrides: Partial<TaskRecord> & { readonly taskId: string; readonly contextId: string }): TaskRecord {
  return {
    skill: 'chat',
    state: TaskState.COMPLETED,
    createdAt: '2026-09-07T10:00:00.000Z',
    updatedAt: '2026-09-07T10:00:00.000Z',
    sessionId: null,
    remotePeerId: null,
    parts: [],
    artifacts: [],
    executor: 'session',
    summary: null,
    ...overrides,
  }
}

function instance(overrides: Partial<SessionInstanceLike> & { readonly id: string; readonly name: string }): SessionInstanceLike {
  return {
    preset: undefined,
    sessions: new ContextSessionRegistry(),
    sessionPool: undefined,
    ...overrides,
  }
}

describe('ContextSessionRegistry (streaming observation)', () => {
  it('counts concurrent SSE subscriptions per task and releases on close', () => {
    const registry = new ContextSessionRegistry()
    expect(registry.streamingOpenCount('t1')).toBe(0)
    registry.noteStreamOpen('t1')
    registry.noteStreamOpen('t1')
    expect(registry.streamingOpenCount('t1')).toBe(2)
    registry.noteStreamClose('t1')
    expect(registry.streamingOpenCount('t1')).toBe(1)
    registry.noteStreamClose('t1')
    expect(registry.streamingOpenCount('t1')).toBe(0)
    // Closing an unknown task is a no-op, never throws.
    registry.noteStreamClose('t-unknown')
    expect(registry.streamingOpenCount('t-unknown')).toBe(0)
  })

  it('clear drops every observation (instance teardown)', () => {
    const registry = new ContextSessionRegistry()
    registry.noteStreamOpen('t1')
    registry.clear()
    expect(registry.streamingOpenCount('t1')).toBe(0)
  })
})

describe('aggregateSessionViews', () => {
  it('returns an empty list for an empty task store', () => {
    expect(aggregateSessionViews([], [])).toEqual([])
  })

  it('groups tasks by contextId with counts, timestamps and derived status', () => {
    const views = aggregateSessionViews(
      [
        task({ taskId: 't1', contextId: 'ctx-1', state: TaskState.WORKING, createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:05.000Z' }),
        task({ taskId: 't2', contextId: 'ctx-1', state: TaskState.COMPLETED, createdAt: '2026-09-07T10:00:01.000Z', updatedAt: '2026-09-07T10:00:02.000Z' }),
        task({ taskId: 't3', contextId: 'ctx-2', state: TaskState.CANCELED, createdAt: '2026-09-07T10:01:00.000Z', updatedAt: '2026-09-07T10:01:00.000Z' }),
      ],
      [],
    )
    expect(views).toHaveLength(2)
    const ctx1 = views.find((v) => v.contextId === 'ctx-1')!
    const ctx2 = views.find((v) => v.contextId === 'ctx-2')!
    // WORKING task ⇒ running; possibly-undefined fields absent with no instance.
    expect(ctx1.status).toBe('running')
    expect(ctx1.taskCount).toBe(2)
    expect(ctx1.activeCount).toBe(1)
    expect(ctx1.firstSeen).toBe('2026-09-07T10:00:00.000Z')
    expect(ctx1.lastSeen).toBe('2026-09-07T10:00:05.000Z')
    expect(ctx1.sessionId).toBe('a2a-ctx-1')
    expect(ctx1.serverId).toBeUndefined()
    expect(ctx1.live).toBe(false)
    expect(ctx1.streaming).toBe(false)
    expect(ctx2.status).toBe('idle')
    expect(ctx2.activeCount).toBe(0)
  })

  it('attaches the most recent task\'s instance (name/preset/serverId)', () => {
    const sessionsA = new ContextSessionRegistry()
    sessionsA.noteStreamOpen('t1') // t1 belongs to instance-a and is streaming
    const views = aggregateSessionViews(
      [
        task({ taskId: 't1', contextId: 'ctx-1', serverId: 'a', state: TaskState.COMPLETED, updatedAt: '2026-09-07T10:00:02.000Z' }),
        task({ taskId: 't2', contextId: 'ctx-1', serverId: 'b', state: TaskState.COMPLETED, updatedAt: '2026-09-07T10:00:05.000Z' }),
      ],
      [
        instance({ id: 'a', name: 'Instance A', preset: 'ptc', sessions: sessionsA }),
        instance({ id: 'b', name: 'Instance B', preset: 'standard' }),
      ],
    )
    const row = views.find((v) => v.contextId === 'ctx-1')!
    // Latest task (t2) came in through instance-b ⇒ its identity is shown.
    expect(row.serverId).toBe('b')
    expect(row.serverName).toBe('Instance B')
    expect(row.preset).toBe('standard')
    // Streaming folds over EVERY task's instance registry, not just the latest.
    expect(row.streaming).toBe(true)
  })

  it('reports live only when a pool actually holds the context handle', () => {
    const held = { has: (id: string) => id === 'ctx-1' }
    const views = aggregateSessionViews(
      [task({ taskId: 't1', contextId: 'ctx-1' }), task({ taskId: 't2', contextId: 'ctx-2' })],
      [instance({ id: 'a', name: 'A', sessionPool: held })],
    )
    const ctx1 = views.find((v) => v.contextId === 'ctx-1')!
    const ctx2 = views.find((v) => v.contextId === 'ctx-2')!
    expect(ctx1.live).toBe(true)
    expect(ctx2.live).toBe(false)
  })

  it('orders rows by most recent activity first', () => {
    const views = aggregateSessionViews(
      [
        task({ taskId: 'old', contextId: 'ctx-old', updatedAt: '2026-09-07T09:00:00.000Z' }),
        task({ taskId: 'new', contextId: 'ctx-new', updatedAt: '2026-09-07T11:00:00.000Z' }),
      ],
      [],
    )
    expect(views.map((v) => v.contextId)).toEqual(['ctx-new', 'ctx-old'])
  })
})