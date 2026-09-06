/**
 * Composition tests: boot the plugin's `apply()` on a real Cordis Context
 * with stub host services (storageDomain, webServer, tools, commands) and
 * drive the assembled inbound server through the registered HTTP routes.
 * The full real composition (SQLite backend, agent loop) stays P1 per the
 * design doc; this covers assembly, route registration, the skill gate, and
 * the `a2a/inbound-task` policy seam at the Cordis layer.
 * @module dsh-a2a/tests/composition/composition.spec
 */

import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../../src/index.ts'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { InboundTaskDecision } from '../../src/events.ts'

/** A minimal in-memory kv table matching the storage-domain KvTable contract. */
function fakeTable() {
  const rows = new Map<string, string>()
  return {
    get: (key: string) => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() {
      return rows.size
    },
    put: async (key: string, value: string) => { rows.set(key, value) },
    delete: async (key: string) => rows.delete(key),
    update: async (key: string, fn: (current: string) => string) => {
      const next = fn(rows.get(key) ?? '')
      rows.set(key, next)
      return next
    },
  }
}

/** Structural DomainFacility fake: opens the a2a domain over three kv tables. */
function fakeStorageDomain() {
  const tables = new Map<string, ReturnType<typeof fakeTable>>()
  const open = vi.fn(async () => ({
    name: 'a2a',
    table: (name: string) => {
      let table = tables.get(name)
      if (table === undefined) {
        table = fakeTable()
        tables.set(name, table)
      }
      return table
    },
    close: async () => {},
  }))
  return { open } as unknown as DomainFacility
}

interface FakeRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (...args: unknown[]) => unknown
}

function fakeWebServer() {
  const routes: FakeRoute[] = []
  const register = vi.fn((route: { kind: 'exact' | 'prefix'; path: string; handler(...args: unknown[]): unknown }) => {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route as unknown as FakeRoute)
      if (index >= 0) routes.splice(index, 1)
    }
  })
  return { register, routes }
}

function fakeTools() {
  const tools = new Map<string, { name: string; description?: string }>()
  const registered: unknown[] = []
  const register = vi.fn((def: unknown) => {
    const d = def as { name: string }
    registered.push(def)
    const dispose = () => registered.splice(registered.indexOf(def), 1)
    tools.set(d.name, { name: d.name })
    return dispose
  })
  return { get: (name: string) => tools.get(name), register, registered }
}

function fakeCommands() {
  const definitions: Array<{ name: string }> = []
  const register = vi.fn((def: { name: string }) => {
    definitions.push(def)
    return () => {
      const index = definitions.indexOf(def)
      if (index >= 0) definitions.splice(index, 1)
    }
  })
  return { register, definitions }
}

/** Fake HTTP request/responses so the registered route handler is exercisable. */
function invoke(route: FakeRoute, body: string) {
  const req = new EventEmitter() as EventEmitter & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket?: { remoteAddress?: string; remotePort?: number }
  }
  req.method = 'POST'
  req.url = '/a2a'
  req.headers = { 'content-type': 'application/json', accept: 'application/json' }
  const chunks: Buffer[] = []
  let sent: { status: number; headers: Record<string, string>; body: string } | undefined
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      sent = { status, headers, body: '' }
    },
    write(chunk: string) {
      if (sent) sent.body += chunk
      else chunks.push(Buffer.from(chunk))
    },
    end(chunk?: string) {
      if (chunk && sent !== undefined) sent.body += chunk
    },
  }
  // Deliver the request body after the handler subscribes.
  setImmediate(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  const result = (route.handler as (r: typeof req, s: typeof res) => unknown)(req as never, res as never)
  return {
    result,
    response: () => sent,
    unavailable: () => chunks,
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

function harness(config: ReturnType<typeof Config> = Config()) {
  const ctx = new Context()
  contexts.push(ctx)
  const storageDomain = fakeStorageDomain()
  const webServer = fakeWebServer()
  const tools = fakeTools()
  const commands = fakeCommands()
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('webServer', webServer as never)
  ctx.provide('tools', tools as never)
  ctx.provide('commands', commands as never)
  apply(ctx, config)
  return { ctx, storageDomain, webServer, tools, commands }
}

async function waitForFacade(ctx: Context): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.a2a).toBeDefined()
  })
}

describe('plugin composition (stub host services)', () => {
  it('assembles and registers the /a2a command when enabled', async () => {
    const { ctx, commands } = harness()
    await waitForFacade(ctx)
    await ctx.a2a.enableServer(true)
    expect(commands.definitions.some((d) => d.name === 'a2a')).toBe(true)
    const status = ctx.a2a.status() as { server: { enabled: boolean; skills: string[] } }
    expect(status.server.enabled).toBe(true)
    expect(status.server.skills).toContain('chat')
  })

  it('registers the AgentCard, endpoint, and dashboard routes by default', async () => {
    const { ctx, webServer } = harness()
    await waitForFacade(ctx)
    // The inbound server is enabled by default (install-and-use) and the
    // loopback dashboard API is registered at apply time.
    expect(webServer.routes.map((r) => r.path).sort()).toEqual(['/.well-known/agent-card.json', '/a2a', '/a2a/api'])
    await ctx.a2a.enableServer(false)
    expect(webServer.routes.map((r) => r.path).sort()).toEqual(['/a2a/api'])
    await ctx.a2a.enableServer(true)
    expect(webServer.routes.map((r) => r.path).sort()).toEqual(['/.well-known/agent-card.json', '/a2a', '/a2a/api'])
  })

  it('rejects a SendMessage for a skill outside the derived list', async () => {
    const { ctx, webServer } = harness()
    await waitForFacade(ctx)
    await ctx.a2a.enableServer(true)
    const route = webServer.routes.find((r) => r.path === '/a2a')!
    const { response } = invoke(route, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'm1', role: 'user', parts: [{ text: 'run rm -rf' }], metadata: { skill: 'coding' } } },
    }))
    await vi.waitFor(() => expect(response()).toBeDefined())
    const body = JSON.parse(response()!.body)
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toMatch(/unknown skill/)
  })

  it('lets a policy listener veto a chat task through a2a/inbound-task', async () => {
    const { ctx, webServer } = harness()
    await waitForFacade(ctx)
    ctx.on('a2a/inbound-task', (decision: InboundTaskDecision, next) => {
      if (decision.parts.some((p) => 'text' in p && /veto/i.test(p.text ?? ''))) {
        decision.rejected = { reason: 'vetoed by policy' }
      }
      return next(decision)
    })
    await ctx.a2a.enableServer(true)
    const route = webServer.routes.find((r) => r.path === '/a2a')!
    const { response } = invoke(route, JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'SendMessage',
      params: { message: { messageId: 'm2', role: 'user', parts: [{ text: 'please veto this' }] } },
    }))
    await vi.waitFor(() => expect(response()).toBeDefined())
    const body = JSON.parse(response()!.body)
    expect(body.error.message).toMatch(/vetoed by policy/)
  })

  it('settles an accepted chat task and persists it in the domain store', async () => {
    const { ctx, webServer, storageDomain } = harness()
    await waitForFacade(ctx)
    await ctx.a2a.enableServer(true)
    const route = webServer.routes.find((r) => r.path === '/a2a')!
    const { response } = invoke(route, JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'SendMessage',
      params: { message: { messageId: 'm3', role: 'user', parts: [{ text: 'hello' }] } },
    }))
    await vi.waitFor(() => expect(response()).toBeDefined())
    const task = JSON.parse(response()!.body).result
    expect(task.status.state).toBe('FAILED') // no agent loop: readable refusal
    expect(task.status.message.parts[0].text).toMatch(/refusing inbound task/)
    expect((await ctx.a2a.listTasks() as unknown[]).length).toBe(1)
    expect((storageDomain.open as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('seeds declared client agents into the tools registry and persists them', async () => {
    const card = {
      name: 'remote', description: 'Remote agent', version: '1.0.0',
      supportedInterfaces: [{ url: 'https://remote.example/a2a', protocolBinding: 'JSONRPC' }],
      skills: [{ id: 'chat' }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(card), { status: 200 })))
    try {
      const { ctx, tools } = harness(Config({
        server: { enabled: true, name: 'x', description: 'x', version: '0.1.0', endpointPath: '/a2a', skills: { ids: [], exclude: [] }, executors: {}, subagentProvider: 'in-process' },
        client: { toolPrefix: 'a2a', agents: [{ name: 'remote-1', agentCardUrl: 'https://remote.example/card.json', enabled: true, timeoutMs: 1000 }] },
      }))
      await waitForFacade(ctx)
      // The declared agent's skill becomes a model tool on the tools registry.
      await vi.waitFor(() => {
        expect(tools.get('a2a__remote-1__chat')).toBeDefined()
      })
      expect(ctx.a2a.status().agents).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})