/**
 * ContextSessionPool unit tests: live-handle existence, per-context dispose
 * (the "close session" primitive), and the once-per-open callback the plugin
 * uses to persist the contextId → sessionId binding.
 * @module dsh-a2a/tests/unit/agent-runtime.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { ContextSessionPool, type AgentRegistryLike, type LiveAgent } from '../../src/server/exec/agent-runtime.ts'

/** Minimal fake registry whose handles record create counts and dispose calls. */
function fakeAgents() {
  const created = new Map<string, number>()
  const disposed: string[] = []
  const create = vi.fn(async (opts: { readonly sessionId: string }) => {
    created.set(opts.sessionId, (created.get(opts.sessionId) ?? 0) + 1)
    const agent: LiveAgent = {
      session: { deriveMessages: () => [] },
      send: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      cancel: vi.fn(),
    }
    return {
      agent,
      dispose: vi.fn(async () => {
        disposed.push(opts.sessionId)
      }),
    }
  })
  return { create, created, disposed }
}

function poolWith(opts: { onSessionOpened?: (info: { readonly sessionId: string; readonly contextId: string; readonly firstPrompt: string }) => void | Promise<void> } = {}) {
  const agents = fakeAgents()
  const pool = new ContextSessionPool(agents as unknown as AgentRegistryLike, {
    cwd: '/tmp',
    ...(opts.onSessionOpened !== undefined ? { onSessionOpened: opts.onSessionOpened } : {}),
  })
  return { agents, pool }
}

describe('ContextSessionPool session lifecycle', () => {
  it('has() tracks a live handle and disposeContext releases it', async () => {
    const { agents, pool } = poolWith()
    expect(pool.has('ctx-1')).toBe(false)
    await pool.agentFor('ctx-1')
    expect(pool.has('ctx-1')).toBe(true)
    expect(await pool.disposeContext('ctx-1')).toBe(true)
    expect(pool.has('ctx-1')).toBe(false)
    expect(agents.disposed).toEqual(['a2a-ctx-1'])
  })

  it('disposeContext is a no-op for an unknown context', async () => {
    const { pool } = poolWith()
    expect(await pool.disposeContext('ctx-missing')).toBe(false)
    expect(pool.has('ctx-missing')).toBe(false)
  })

  it('re-opens a NEW handle for the same context after close (never refused)', async () => {
    const { agents, pool } = poolWith()
    await pool.agentFor('ctx-1')
    await pool.disposeContext('ctx-1')
    await pool.agentFor('ctx-1')
    // One create per open: close is a resource release, not a tombstone.
    expect(agents.created.get('a2a-ctx-1')).toBe(2)
  })

  it('fires onSessionOpened exactly once per freshly opened context (binding hook)', async () => {
    const opened: Array<{ sessionId: string; contextId: string; firstPrompt: string }> = []
    const { pool } = poolWith({ onSessionOpened: (info) => { opened.push(info) } })
    // First turn opens the session ⇒ fires once.
    await pool.runTurn('ctx-1', 'hello', new AbortController().signal)
    // Second turn reuses the live handle ⇒ no callback.
    await pool.runTurn('ctx-1', 'hello-again', new AbortController().signal)
    expect(opened).toEqual([
      { sessionId: 'a2a-ctx-1', contextId: 'ctx-1', firstPrompt: 'hello' },
    ])
    // Reopened after close fires the hook again; same derived session id.
    await pool.disposeContext('ctx-1')
    await pool.runTurn('ctx-1', 'after-close', new AbortController().signal)
    expect(opened).toEqual([
      { sessionId: 'a2a-ctx-1', contextId: 'ctx-1', firstPrompt: 'hello' },
      { sessionId: 'a2a-ctx-1', contextId: 'ctx-1', firstPrompt: 'after-close' },
    ])
  })
})