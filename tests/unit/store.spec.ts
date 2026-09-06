/**
 * MemoryTaskStore unit tests: task lifecycle, artifact append semantics, and
 * context→session binding. DomainTaskStore regression tests use a kv table
 * that mimics the real storage-domain write chain (queued put: durability
 * first, memory updated on a later microtask), which burned the composition
 * once: a fire-and-forget put followed by a synchronous read returned the
 * pre-write memory state and failed the task with `task <id> not found`.
 * @module dsh-a2a/tests/unit/store.spec
 */

import { describe, expect, it } from 'vitest'
import { DomainTaskStore, MemoryTaskStore } from '../../src/server/store.ts'
import { TaskState } from '../../src/protocol.ts'

/** Kv table that updates memory only AFTER the queued write settles (real contract). */
function chainedTable(seed: Record<string, string> = {}) {
  const rows = new Map<string, string>(Object.entries(seed))
  return {
    get: (key: string) => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() {
      return rows.size
    },
    put: async (key: string, value: string) => {
      await Promise.resolve() // durability before memory, exactly like enqueue()
      rows.set(key, value)
    },
    delete: async (key: string) => rows.delete(key),
    update: async (key: string, fn: (current: string) => string) => {
      const next = fn(rows.get(key) ?? '')
      rows.set(key, next)
      return next
    },
  }
}

/** Domain fake whose tables mirror the real write-chain visibility. */
function chainedDomain(seedTasks: Record<string, string> = {}) {
  const tasks = chainedTable(seedTasks)
  const contexts = chainedTable()
  return {
    tasks,
    contexts,
    async close() {},
  }
}

describe('MemoryTaskStore', () => {
  it('creates tasks server-side with a uuid taskId and SUBMITTED state', () => {
    const store = new MemoryTaskStore()
    const record = store.create({ contextId: 'c1', skill: 'chat', parts: [{ text: 'hi' }], remotePeerId: null })
    expect(record.taskId).toMatch(/^a2a-/)
    expect(record.state).toBe(TaskState.SUBMITTED)
    expect(record.sessionId).toBeNull()
    expect(store.get(record.taskId)).toEqual(record)
  })

  it('transitions state and records an error message', () => {
    const store = new MemoryTaskStore()
    const record = store.create({ contextId: 'c', skill: 'chat', parts: [], remotePeerId: null })
    const updated = store.setState(record.taskId, TaskState.FAILED, { code: 'executor', text: 'boom' })
    expect(updated.state).toBe(TaskState.FAILED)
    expect(updated.error).toEqual({ code: 'executor', message: 'boom' })
    expect(updated.updatedAt >= record.updatedAt).toBe(true)
  })

  it('appends artifact chunks, merging into the same artifactId', () => {
    const store = new MemoryTaskStore()
    const record = store.create({ contextId: 'c', skill: 'chat', parts: [], remotePeerId: null })
    store.appendArtifact(record.taskId, { artifactId: 'result', parts: [{ text: 'a' }] })
    const second = store.appendArtifact(record.taskId, { artifactId: 'result', parts: [{ text: 'b' }] })
    expect(second.artifacts).toEqual([{ artifactId: 'result', parts: [{ text: 'a' }, { text: 'b' }] }])
    expect(second.artifacts[0]?.name).toBeUndefined()
  })

  it('stores and reads a context→session binding', async () => {
    const store = new MemoryTaskStore()
    await store.setContextSession('ctx-1', 'session-9')
    expect(await store.getContextSession('ctx-1')).toBe('session-9')
    expect(await store.getContextSession('ctx-missing')).toBeUndefined()
  })
})

describe('DomainTaskStore', () => {
  it('create is immediately readable and transitions without reading the table back', () => {
    const domain = chainedDomain()
    const store = new DomainTaskStore(domain as never)
    const record = store.create({ contextId: 'c1', skill: 'chat', parts: [{ text: 'hi' }], remotePeerId: null })
    // The queued write has not settled yet; the synchronous read must still see it.
    expect(store.get(record.taskId)?.taskId).toBe(record.taskId)
    const working = store.setState(record.taskId, TaskState.WORKING)
    expect(working.state).toBe(TaskState.WORKING)
    expect(store.list().map((r) => r.taskId)).toEqual([record.taskId])
  })

  it('seeds the live view from already-opened table records (restart recovery)', () => {
    const taskId = 'a2a-seeded'
    const seeded = JSON.stringify({
      taskId,
      contextId: 'ctx-seeded',
      skill: 'chat',
      state: 'COMPLETED',
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:01.000Z',
      sessionId: 's1',
      remotePeerId: null,
      parts: [],
      artifacts: [],
      executor: 'session',
      summary: null,
    })
    const store = new DomainTaskStore(chainedDomain({ 'task:a2a-seeded': seeded }) as never)
    expect(store.get(taskId)?.state).toBe(TaskState.COMPLETED)
  })

  it('keeps context bindings on the live view', async () => {
    const store = new DomainTaskStore(chainedDomain() as never)
    await store.setContextSession('ctx-1', 'session-9')
    expect(await store.getContextSession('ctx-1')).toBe('session-9')
  })
})
