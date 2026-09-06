/**
 * Outbound agent registry tests: boot-time connection, tool registration,
 * add/remove/enable/disable/refresh, view states, and failure surfacing.
 * @module dsh-a2a/tests/unit/registry.spec
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryAgentStore, OutboundAgentRegistry } from '../../src/client/registry.ts'
import type { OutboundAgentRecord } from '../../src/server/store.ts'
import type { AgentCard } from '../../src/protocol.ts'

/** One remote card with a fixed skill list. */
function cardWith(skills: readonly { id: string }[]): AgentCard {
  return {
    name: 'remote',
    description: 'Remote agent',
    version: '1.0.0',
    supportedInterfaces: [{ url: 'https://remote.example/a2a', protocolBinding: 'JSONRPC' }],
    skills,
  }
}

/** A registrar capturing every registration and returning a working disposer. */
function captureRegistrar() {
  const registered: unknown[] = []
  const disposers: Array<() => void> = []
  const register = (def: unknown): (() => void) | void => {
    registered.push(def)
    const dispose = vi.fn(() => {})
    disposers.push(dispose)
    return dispose
  }
  return { register, registered, disposers }
}

/** A global fetch stub serving the given card for every request. */
function stubCardFetch(card: AgentCard, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { id: 'a2a-1', status: { state: 'COMPLETED', timestamp: new Date().toISOString() } } }), { status: 200 })
    }
    return new Response(JSON.stringify(card), { status, headers: { 'content-type': 'application/json' } })
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function options(store: MemoryAgentStore, registrar: ReturnType<typeof captureRegistrar>): ConstructorParameters<typeof OutboundAgentRegistry>[0] {
  return {
    registrar,
    store,
    toolPrefix: 'a2a',
    tokenOf: (env) => (env ? `token-${env}` : undefined),
    onError: () => {},
  }
}

describe('OutboundAgentRegistry', () => {
  it('connects enabled agents at load and registers one tool per skill', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }, { id: 'coding' }]))
    const store = new MemoryAgentStore([{ id: 'a1', name: 'agent-1', agentCardUrl: 'https://remote.example/card.json', enabled: true, timeoutMs: 1000, lastCardAt: null }])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    registry.loadAll()
    // loadAll connects in the background; wait for the view to appear.
    await vi.waitFor(() => {
      const view = registry.list().find((v) => v.id === 'a1')
      expect(view?.state).toBe('connected')
    })
    expect(reg.registered.length).toBe(2)
    const tools = registry.list()
    expect(tools[0]?.toolCount).toBe(2)
    expect(tools[0]?.skillCount).toBe(2)
  })

  it('skips disabled agents at load', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const store = new MemoryAgentStore([{ id: 'a1', name: 'agent', agentCardUrl: 'https://remote.example/card.json', enabled: false, timeoutMs: 1000, lastCardAt: null }])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    registry.loadAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(reg.registered).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('persists new agents and registers their tools', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const store = new MemoryAgentStore([])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    const result = await registry.add({ name: 'remote', agentCardUrl: 'https://remote.example/card.json' })
    expect(result.ok).toBe(true)
    expect(reg.registered.length).toBe(1)
    expect(store.list().length).toBe(1)
    const view = registry.list()[0]
    expect(view?.state).toBe('connected')
  })

  it('records a failed connection in the view and keeps the agent unpersisted', async () => {
    stubCardFetch(cardWith([]), 503)
    const store = new MemoryAgentStore([])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    const result = await registry.add({ name: 'remote', agentCardUrl: 'https://remote.example/card.json' })
    expect(result.ok).toBe(false)
    expect(store.list().length).toBe(0)
    const view = registry.list()[0]
    expect(view?.state).toBe('failed')
    expect(view?.lastError).toMatch(/HTTP 503/)
  })

  it('disables an agent by unregistering its tools and disconnects it', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const store = new MemoryAgentStore([])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    await registry.add({ name: 'remote', agentCardUrl: 'https://remote.example/card.json' })
    const id = registry.list()[0]!.id
    const disable = await registry.setEnabled(id, false)
    expect(disable.ok).toBe(true)
    expect(reg.disposers[0]).toHaveBeenCalledOnce()
    expect(registry.list()[0]?.state).toBe('disconnected')
    expect(store.list().find((r) => r.id === id)?.enabled).toBe(false)
  })

  it('removes an agent entirely', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const store = new MemoryAgentStore([])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    await registry.add({ name: 'remote', agentCardUrl: 'https://remote.example/card.json' })
    const id = registry.list()[0]!.id
    await registry.remove(id)
    expect(registry.list()).toEqual([])
    expect(store.list().find((r) => r.id === id)).toBeUndefined()
  })

  it('rejects unknown agent ids readably', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const registry = new OutboundAgentRegistry(options(new MemoryAgentStore([]), captureRegistrar()))
    expect((await registry.setEnabled('nope', true)).ok).toBe(false)
    expect((await registry.remove('nope')).ok).toBe(false)
  })

  it('seeds declared agents absent from the store', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const store = new MemoryAgentStore([])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    await registry.seed([{ name: 'declared', agentCardUrl: 'https://remote.example/card.json' }])
    expect(reg.registered.length).toBe(1)
    expect(registry.list()[0]?.state).toBe('connected')
    expect(store.list().map((r) => r.name)).toContain('declared')
  })

  it('seed keeps persisted records (disabled stays disconnected)', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const store = new MemoryAgentStore([{ id: 'a1', name: 'pre-disabled', agentCardUrl: 'https://remote.example/card.json', enabled: false, timeoutMs: 1000, lastCardAt: null }])
    const reg = captureRegistrar()
    const registry = new OutboundAgentRegistry(options(store, reg))
    registry.loadAll()
    await new Promise((r) => setTimeout(r, 10))
    await registry.seed([
      { name: 'pre-disabled', agentCardUrl: 'https://remote.example/card.json' },
      { name: 'fresh', agentCardUrl: 'https://remote.example/card.json' },
    ])
    // Only the store-absent name connects; the persisted disabled record stays put.
    expect(reg.registered.length).toBe(1)
    expect(registry.list().map((v) => v.name)).toEqual(['fresh'])
    expect(store.list().find((r) => r.name === 'pre-disabled')?.enabled).toBe(false)
  })

  it('does not resurrect a removed agent on a fresh load', async () => {
    stubCardFetch(cardWith([{ id: 'chat' }]))
    const store = new MemoryAgentStore([])
    const first = new OutboundAgentRegistry(options(store, captureRegistrar()))
    await first.add({ name: 'gone', agentCardUrl: 'https://remote.example/card.json' })
    await first.remove(first.list()[0]!.id)
    expect(store.list()).toEqual([])
    // A fresh registry over the same store must not reconnect the removed agent.
    const reg = captureRegistrar()
    const second = new OutboundAgentRegistry(options(store, reg))
    second.loadAll()
    await new Promise((r) => setTimeout(r, 10))
    expect(reg.registered).toEqual([])
    expect(second.list()).toEqual([])
  })
})