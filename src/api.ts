/**
 * GUI control API for the A2A settings dashboard: one `GET /a2a/api`
 * snapshot plus `POST /a2a/api` control actions (server toggle, outbound
 * agent management, task view). The browser half talks only to this route;
 * it carries no protocol knowledge. Loopback-only by default so the
 * dashboard cannot be driven from the wire.
 *
 * The route body is bound to the same `A2AServiceImpl` facade the `/a2a`
 * command surface uses, so GUI actions and commands cannot disagree.
 * @module dsh-a2a/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { A2AServiceImpl } from './service.ts'

/** Control actions the dashboard can issue. */
export type ApiAction =
  | { readonly action: 'server.enable' | 'server.disable' }
  | { readonly action: 'agent.add'; readonly name: string; readonly agentCardUrl: string; readonly bearerTokenEnv?: string }
  | { readonly action: 'agent.remove' | 'agent.enable' | 'agent.disable' | 'agent.refresh'; readonly id: string }
  | { readonly action: 'task.cancel'; readonly id: string }
  | { readonly action: 'identity.update'; readonly name?: string; readonly description?: string; readonly version?: string }
  | { readonly action: 'inbound.close'; readonly id: string }

/** One snapshot of the whole plugin for the dashboard. */
export interface ApiSnapshot {
  readonly server: {
    readonly enabled: boolean
    readonly cardUrl?: string
    readonly skills: readonly string[]
    readonly name?: string
    readonly description?: string
    readonly version?: string
    readonly configured: boolean
  }
  readonly tasks: readonly unknown[]
  readonly agents: readonly unknown[]
  readonly inbounds: readonly unknown[]
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
  const status = impl.status() as {
    server: {
      enabled: boolean
      cardUrl?: string
      skills: readonly string[]
      name?: string
      description?: string
      version?: string
      configured: boolean
    }
    tasks: number
    agents: readonly unknown[]
    inbounds: readonly unknown[]
  }
  return {
    server: status.server,
    tasks: impl.listTasks() as readonly unknown[],
    agents: impl.agents() as readonly unknown[],
    inbounds: status.inbounds ?? [],
  }
}

async function dispatch(payload: ApiAction, impl: A2AServiceImpl): Promise<{ readonly ok: boolean; readonly message: string }> {
  switch (payload.action) {
    case 'server.enable':
      return impl.enableServer(true)
    case 'server.disable':
      return impl.enableServer(false)
    case 'agent.add':
      return impl.addAgent({ name: payload.name, agentCardUrl: payload.agentCardUrl, ...(payload.bearerTokenEnv ? { bearerTokenEnv: payload.bearerTokenEnv } : {}) })
    case 'agent.remove':
      return impl.removeAgent(payload.id)
    case 'agent.enable':
      return impl.setAgentEnabled(payload.id, true)
    case 'agent.disable':
      return impl.setAgentEnabled(payload.id, false)
    case 'agent.refresh':
      return impl.refreshAgentCard(payload.id)
    case 'task.cancel':
      return impl.cancelTask(payload.id)
    case 'identity.update':
      return impl.updateIdentity({ ...(payload.name !== undefined ? { name: payload.name } : {}), ...(payload.description !== undefined ? { description: payload.description } : {}), ...(payload.version !== undefined ? { version: payload.version } : {}) })
    case 'inbound.close':
      return impl.closeInbound(payload.id)
    default:
      return { ok: false, message: `unknown action ${String((payload as { action?: unknown }).action)}` }
  }
}