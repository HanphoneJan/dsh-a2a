/**
 * HTTP binding tests: request-body cap and pre-stream status handling.
 * @module dsh-a2a/tests/unit/routes.spec
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { A2AServer } from '../../src/server/a2a-server.ts'
import { A2aRoutes } from '../../src/server/routes.ts'
import { MemoryTaskStore } from '../../src/server/store.ts'
import type { ExecutorSet } from '../../src/server/executor.ts'
import type { AgentCard } from '../../src/protocol.ts'

const card: AgentCard = {
  name: 'route-test',
  version: '1.0.0',
  capabilities: { streaming: true },
  supportedInterfaces: [{ url: 'http://127.0.0.1:3000/a2a', protocolBinding: 'JSONRPC' }],
  skills: [{ id: 'chat' }],
}

function fakeWebServer() {
  const routes: Array<{ kind: 'exact' | 'prefix'; path: string; handler: (...args: unknown[]) => unknown }> = []
  return {
    routes,
    register(route: (typeof routes)[number]) {
      routes.push(route)
      return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) }
    },
  }
}

function invoke(handler: (...args: unknown[]) => unknown, body: string, headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket?: { remoteAddress?: string; remotePort?: number }
    resume?(): void
  }
  req.method = 'POST'
  req.url = '/a2a'
  req.headers = { 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: '127.0.0.1', remotePort: 77 }
  req.resume = () => {}
  let status = 0
  let text = ''
  const res = {
    writeHead(value: number) { status = value },
    write(chunk: string) { text += chunk },
    end(chunk?: string) { if (chunk !== undefined) text += chunk },
  }
  setImmediate(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  const pending = handler(req, res) as Promise<void> | void
  return { pending, output: () => ({ status, text }) }
}

describe('A2aRoutes', () => {
  it('rejects an oversized body with 413 before touching the A2A server', async () => {
    const webServer = fakeWebServer()
    const server = new A2AServer({
      card,
      store: new MemoryTaskStore(),
      executors: { resolve: () => ({ name: 'session', execute: async () => ({ parts: [] }) }), disposeAll: async () => {} } as unknown as ExecutorSet,
      gate: async () => ({ ok: true }),
    })
    const routes = new A2aRoutes(webServer as never, server, '/a2a/card.json', 32)
    routes.enable()
    const route = webServer.routes.find((entry) => entry.kind === 'prefix')!
    const result = invoke(route.handler, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {}, padding: 'x'.repeat(100) }))
    await result.pending
    expect(result.output().status).toBe(413)
    routes.dispose()
  })
})
