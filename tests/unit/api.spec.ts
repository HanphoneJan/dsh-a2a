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
function reqWith(remoteAddress: string | undefined, method = 'GET', body = '', url = '/a2a/api'): IncomingMessage & { body?: string } {
  const req = new EventEmitter() as IncomingMessage & { body?: string }
  req.method = method
  req.url = url
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
    status: () => ({ inbounds: [], outbounds: [], tasks: 0, peers: [] }),
    presets: vi.fn(async () => []),
    listInboundServers: () => [],
    createInboundServer: vi.fn(async () => ({ ok: true, message: 'created', id: 'in-1' })),
    removeInboundServer: vi.fn(async () => ({ ok: true, message: 'removed' })),
    setInboundServerEnabled: vi.fn(async () => ({ ok: true, message: 'toggled' })),
    updateInboundServer: vi.fn(async () => ({ ok: true, message: 'updated' })),
    listOutboundServers: () => [],
    createOutboundServer: vi.fn(async () => ({ ok: true, message: 'created', id: 'out-1' })),
    removeOutboundServer: vi.fn(async () => ({ ok: true, message: 'removed' })),
    setOutboundServerEnabled: vi.fn(async () => ({ ok: true, message: 'toggled' })),
    refreshOutboundServer: vi.fn(async () => ({ ok: true, message: 'refreshed' })),
    getTask: () => undefined,
    listTasks: () => [],
    cancelTask: vi.fn(async () => ({ ok: false, message: 'nope' })),
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
    expect(JSON.parse(out.body).inbounds).toEqual([])
  })

  it('rejects non-loopback callers with 403', async () => {
    const res = resCollector()
    await handleApiRequest(reqWith('203.0.113.5'), res, facadeStub())
    expect(res.output().status).toBe(403)
  })

  it('serves the preset roster on GET /a2a/api/presets', async () => {
    const impl = facadeStub({ presets: vi.fn(async () => [{ id: 'ptc', name: 'PTC 模式' }]) })
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1', 'GET', '', '/a2a/api/presets'), res, impl)
    const out = res.output()
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toEqual([{ id: 'ptc', name: 'PTC 模式' }])
  })

  it('dispatches inbound.create with the supplied input', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(
      reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'inbound.create', name: 'Main', description: 'd', version: '1.0.0', preset: 'ptc' })),
      res,
      impl,
    )
    expect(res.output().status).toBe(200)
    expect(impl.createInboundServer).toHaveBeenCalledWith({
      name: 'Main', description: 'd', version: '1.0.0', preset: 'ptc',
    })
  })

  it('dispatches inbound.enable/disable/remove by id', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'inbound.enable', id: 'in-1' })), res, impl)
    expect(impl.setInboundServerEnabled).toHaveBeenCalledWith('in-1', true)
    await handleApiRequest(reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'inbound.disable', id: 'in-1' })), res, impl)
    expect(impl.setInboundServerEnabled).toHaveBeenCalledWith('in-1', false)
    await handleApiRequest(reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'inbound.remove', id: 'in-1' })), res, impl)
    expect(impl.removeInboundServer).toHaveBeenCalledWith('in-1')
  })

  it('dispatches outbound.create with the supplied spec', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(
      reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'outbound.create', name: 'remote', agentCardUrl: 'https://x/card.json', preset: 'ptc' })),
      res,
      impl,
    )
    expect(res.output().status).toBe(200)
    expect(impl.createOutboundServer).toHaveBeenCalledWith({
      name: 'remote', agentCardUrl: 'https://x/card.json', preset: 'ptc',
    })
  })

  it('returns 409 with the facade message when a control action fails', async () => {
    const impl = facadeStub({ cancelTask: vi.fn(async () => ({ ok: false, message: 'task not found' })) })
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'task.cancel', id: 't1' })), res, impl)
    const out = res.output()
    expect(out.status).toBe(409)
    expect(JSON.parse(out.body).message).toBe('task not found')
  })

  it('dispatches inbound.close with the peer id', async () => {
    const impl = facadeStub()
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1', 'POST', JSON.stringify({ action: 'inbound.close', id: 'peer-1' })), res, impl)
    expect(res.output().status).toBe(200)
    expect(impl.closeInbound).toHaveBeenCalledWith('peer-1')
  })

  it('includes inbounds/outbounds/tasks in the snapshot', async () => {
    const impl = facadeStub({ status: () => ({ inbounds: [{ id: 'in-1' }], outbounds: [{ id: 'out-1' }], tasks: 0, peers: [{ id: 'p1' }] }) })
    const res = resCollector()
    await handleApiRequest(reqWith('127.0.0.1'), res, impl)
    const body = JSON.parse(res.output().body)
    expect(body.inbounds).toEqual([{ id: 'in-1' }])
    expect(body.outbounds).toEqual([{ id: 'out-1' }])
    expect(body.peers).toEqual([{ id: 'p1' }])
  })
})