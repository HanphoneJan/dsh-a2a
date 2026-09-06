/**
 * GUI control API for the A2A settings dashboard: one `GET /a2a/api`
 * snapshot plus `POST /a2a/api` control actions (inbound/outbound server
 * CRUD + enable/disable, task view/cancel) and `GET /a2a/api/presets` for the
 * preset roster the pickers need. The browser half talks only to this route;
 * it carries no protocol knowledge. Loopback-only by default so the dashboard
 * cannot be driven from the wire.
 *
 * The route body is bound to the same `A2AServiceImpl` facade the `/a2a`
 * command surface uses, so GUI actions and commands cannot disagree.
 * @module dsh-a2a/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { A2AServiceImpl } from './service.ts'

/** Control actions the dashboard can issue. */
export type ApiAction =
  | { readonly action: 'inbound.create'; readonly name: string; readonly description: string; readonly version: string; readonly endpointPath?: string; readonly preset?: string; readonly authTokenEnv?: string; readonly skills?: readonly { id: string; name: string; description?: string }[]; readonly enabled?: boolean }
  | { readonly action: 'inbound.remove' | 'inbound.enable' | 'inbound.disable' | 'inbound.update'; readonly id: string; readonly name?: string; readonly description?: string; readonly version?: string; readonly endpointPath?: string; readonly preset?: string; readonly authTokenEnv?: string; readonly skills?: readonly { id: string; name: string; description?: string }[] }
  | { readonly action: 'outbound.create'; readonly name: string; readonly agentCardUrl: string; readonly bearerTokenEnv?: string; readonly preset?: string; readonly enabled?: boolean; readonly timeoutMs?: number }
  | { readonly action: 'outbound.remove' | 'outbound.enable' | 'outbound.disable' | 'outbound.refresh'; readonly id: string }
  | { readonly action: 'task.cancel'; readonly id: string }
  | { readonly action: 'inbound.close'; readonly id: string }

/** One snapshot of the whole plugin for the dashboard. */
export interface ApiSnapshot {
  readonly inbounds: readonly unknown[]
  readonly outbounds: readonly unknown[]
  readonly tasks: readonly unknown[]
  readonly peers: readonly unknown[]
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.once('error', reject)
  })
}

/** The caller is the local machine (never a remote peer). */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(value))
}

/** Handle one dashboard API request against the service facade. */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  impl: A2AServiceImpl,
): Promise<void> {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden')
    return
  }
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (req.method === 'GET' && path === '/a2a/api/presets') {
    json(res, 200, await impl.presets())
    return
  }
  if (req.method === 'GET') {
    json(res, 200, snapshotOf(impl))
    return
  }
  if (req.method === 'POST') {
    let payload: ApiAction
    try {
      payload = JSON.parse(await readBody(req)) as ApiAction
    } catch {
      json(res, 400, { ok: false, message: 'invalid JSON body' })
      return
    }
    const result = await dispatch(payload, impl)
    json(res, result.ok ? 200 : 409, result)
    return
  }
  res.writeHead(405, { 'content-type': 'text/plain' })
  res.end('Method Not Allowed')
}

function snapshotOf(impl: A2AServiceImpl): ApiSnapshot {
  const status = impl.status() as { inbounds: readonly unknown[]; outbounds: readonly unknown[]; tasks: number; peers?: readonly unknown[] }
  return {
    inbounds: status.inbounds ?? [],
    outbounds: status.outbounds ?? [],
    tasks: impl.listTasks() as readonly unknown[],
    peers: status.peers ?? impl.inbounds() as readonly unknown[],
  }
}

async function dispatch(payload: ApiAction, impl: A2AServiceImpl): Promise<{ readonly ok: boolean; readonly message: string }> {
  switch (payload.action) {
    case 'inbound.create':
      return impl.createInboundServer({
        name: payload.name,
        description: payload.description,
        version: payload.version,
        ...(payload.endpointPath !== undefined ? { endpointPath: payload.endpointPath } : {}),
        ...(payload.preset !== undefined ? { preset: payload.preset } : {}),
        ...(payload.authTokenEnv !== undefined ? { authTokenEnv: payload.authTokenEnv } : {}),
        ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
      })
    case 'inbound.remove':
      return impl.removeInboundServer(payload.id)
    case 'inbound.enable':
      return impl.setInboundServerEnabled(payload.id, true)
    case 'inbound.disable':
      return impl.setInboundServerEnabled(payload.id, false)
    case 'inbound.update':
      return impl.updateInboundServer(payload.id, {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.version !== undefined ? { version: payload.version } : {}),
        ...(payload.endpointPath !== undefined ? { endpointPath: payload.endpointPath } : {}),
        ...(payload.preset !== undefined ? { preset: payload.preset } : {}),
        ...(payload.authTokenEnv !== undefined ? { authTokenEnv: payload.authTokenEnv } : {}),
        ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
      })
    case 'outbound.create':
      return impl.createOutboundServer({
        name: payload.name,
        agentCardUrl: payload.agentCardUrl,
        ...(payload.bearerTokenEnv !== undefined ? { bearerTokenEnv: payload.bearerTokenEnv } : {}),
        ...(payload.preset !== undefined ? { preset: payload.preset } : {}),
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
        ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
      })
    case 'outbound.remove':
      return impl.removeOutboundServer(payload.id)
    case 'outbound.enable':
      return impl.setOutboundServerEnabled(payload.id, true)
    case 'outbound.disable':
      return impl.setOutboundServerEnabled(payload.id, false)
    case 'outbound.refresh':
      return impl.refreshOutboundServer(payload.id)
    case 'task.cancel':
      return impl.cancelTask(payload.id)
    case 'inbound.close':
      return impl.closeInbound(payload.id)
    default:
      return { ok: false, message: `unknown action ${String((payload as { action?: unknown }).action)}` }
  }
}
