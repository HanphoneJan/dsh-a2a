/**
 * Dashboard API tests: snapshot shape, loopback enforcement, and control
 * action dispatch through the service facade.
 * @module dsh-a2a/tests/unit/api.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { handleApiRequest } from '../../src/api.ts'
import type { A2AServiceImpl } from '../../src/service.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'

/** A structural request whose socket carries a remote address. */
function reqWith(remoteAddress: string | undefined, method = 'GET', body = ''): IncomingMessage & { body?: string } {
  const req = new EventEmitter() as IncomingMessage & { body?: string }
  req.method = method
  req.url = '/a2a/api'
  req.headers = {}
  req.socket = { remoteAddress, remotePort: 12345 } as unknown as IncomingMessage['socket']
  req.body = body
  const read = (req as unknown as { on: (e: string, cb: (c: Buffer) => void) => void }).on.bind(req)
  ;(req as unknown as { on: (e: string, cb: (c: Buffer | string) => void) => void }).on = (e: string, cb: (c: Buffer | string) => void) => {
    if (e === 'data' && body.length > 0) setImmediate(() => cb(Buffer.from(body)))
    if (e === 'end') setImmediate(() => cb(''))
    return read(e, cb as (c: Buffer) => void)
  }
  return req
}

function resCollector() {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead(s: number, h?: Record<string, string>) {
      status = s
      headers = h ?? {}
    },
    end(text?: string) {
      body = text ?? ''
    },
    output: () => ({ status, headers, body }),
  } as unknown as ServerResponse & { output(): { status: number; headers: Record<string, string>; body: string } }
  return res
}

function facadeStub(overrides: Partial<A2AServiceImpl> = {}): A2AServiceImpl {
  return {
    status: () => ({ server: { enabled: true, cardUrl: 'http://x/a2a', skills: ['chat'], configured: false }, tasks: 0, agents: [], inbounds: [] }),
    enableServer: vi.fn(async () => ({ ok: true, message: 'server enabled' })),
    getTask: () => undefined,
    listTasks: () => [],
    cancelTask: vi.fn(async () => ({ ok: false, message: 'nope' })),
    agents: () => [],
    addAgent: vi.fn(async () => ({ ok: true, message: 'added' })),
    removeAgent: vi.fn(async () => ({ ok: true, message: 'removed' })),
    setAgentEnabled: vi.fn(async () => ({ ok: true, message: 'toggled' })),
    refreshAgentCard: vi.fn(async () => ({ ok: true, message: 'refreshed' })),
    identity: () => ({ name: 'x', description: 'd', version: '0.1.0' }),
    updateIdentity: vi.fn(async () => ({ ok: true, message: 'identity updated' })),
    closeInbound: vi.fn(async () => ({ ok: true, message: 'peer closed' })),
    inbounds: () => [],
    ...overrides,
  }
}

describe('handleApiRequest', () => {
  it('serves a snapshot on GET for loopback callers', async () => {
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1'), res, facadeStub())
    const out = res.output()
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body).server.enabled).toBe(true)
  })

  it('rejects non-loopback callers with 403', async () => {
    const res = resCollector()
    await handleApiRequest(reqWith('203.0.113.5'), res, facadeStub())
    expect(res.output().status).toBe(403)
  })

  it('dispatches server.enable to the facade', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(reqWith('::1', 'POST', JSON.stringify({ action: 'server.enable' })), res, impl)
    expect(res.output().status).toBe(200)
    expect(impl.enableServer).toHaveBeenCalledWith(true)
  })

  it('dispatches agent.add with the supplied spec', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(
      reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'agent.add', name: 'aa', agentCardUrl: 'https://x/card.json' })),
      res,
      impl,
    )
    expect(res.output().status).toBe(200)
    expect(impl.addAgent).toHaveBeenCalledWith({ name: 'aa', agentCardUrl: 'https://x/card.json' })
  })

  it('returns 409 with the facade message when a control action fails', async () => {
    const impl = facadeStub({ cancelTask: vi.fn(async () => ({ ok: false, message: 'task not found' })) })
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'task.cancel', id: 't1' })), res, impl)
    const out = res.output()
    expect(out.status).toBe(409)
    expect(JSON.parse(out.body).message).toBe('task not found')
  })

  it('dispatches identity.update with the supplied patch', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(
      reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'identity.update', name: 'New Agent', description: 'desc', version: '0.2.0' })),
      res,
      impl,
    )
    expect(res.output().status).toBe(200)
    expect(impl.updateIdentity).toHaveBeenCalledWith({ name: 'New Agent', description: 'desc', version: '0.2.0' })
  })

  it('dispatches inbound.close with the peer id', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'inbound.close', id: 'peer-1' })), res, impl)
    expect(res.output().status).toBe(200)
    expect(impl.closeInbound).toHaveBeenCalledWith('peer-1')
  })

  it('includes inbounds in the snapshot', async () => {
    const impl = facadeStub({ status: () => ({ server: { enabled: true, configured: true }, tasks: 0, agents: [], inbounds: [{ id: 'p1' }] }) })
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1'), res, impl)
    expect(JSON.parse(res.output().body).inbounds).toEqual([{ id: 'p1' }])
  })
})