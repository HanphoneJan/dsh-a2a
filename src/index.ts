/**
 * @hanphone/dsh-a2a — Cordis plugin entry.
 *
 * Mounts the A2A v1.0.1 dual-end plugin as a MULTI-INSTANCE composition: an
 * arbitrary set of inbound A2A servers (each a preset-bound session pool, its
 * own endpoint + AgentCard + creator-declared skills + auth) and an arbitrary
 * set of outbound A2A connections (each a remote URL + preset + timeout).
 * Instances are persisted in the `a2a` domain (`inbound_servers` /
 * `outbound_servers` tables) and created/edited/started/stopped entirely from
 * the GUI — the plugin `Config` is minimal and instance setup is not
 * patch-config driven. The protocol surface is aligned with the official A2A
 * v1.0.1 spec (see docs/design.md).
 *
 * Optional services are probed rather than injected so a composition lacking
 * one half idles just that half; only the storage domain is required.
 *
 * Function-plugin export shape: named `name`/`inject`/`Config`/`apply`, no
 * default export (mixing forms makes the Loader drop the namespace).
 * @module dsh-a2a
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { openDomain, DomainTaskStore, type A2aDomain, type TaskStore } from './server/store.ts'
import { probeService, type AgentPresetsLike, type AgentRegistryLike, type CredentialsLike, type SkillsLike } from './server/exec/agent-runtime.ts'
import { aggregateSessionViews, type SessionView } from './server/session-registry.ts'
import { isTerminal } from './protocol.ts'
import type { SubagentsLike } from './server/exec/subagent.ts'
import { handleApiRequest } from './api.ts'
import { A2AService, type A2AServiceImpl, type InboundCreateInput, type InboundServerView, type OutboundCreateInput, type OpResult, type PresetView, type SkillView } from './service.ts'
import { buildA2aCommand } from './commands.ts'
import { InboundServerManager, DomainInboundStore, resolveAuthToken, type InboundManagerHost, type WebServerLike as InboundWebServerLike } from './servers/inbound-manager.ts'
import { OutboundServerManager, DomainOutboundStore, type OutboundManagerHost, type OutboundServerView } from './servers/outbound-manager.ts'

export const name = 'a2a'

/** Only the storage domain is required; the other halves are probed. */
export const inject = ['storageDomain'] as const

/** Minimal host-level config; per-instance setup happens in the GUI/domain. */
export interface A2AConfig {
  /** Advertised base URL for every inbound card; absent lets a default stand. */
  baseUrl?: string
  /** Subagent driver provider for the inbound subagent executors. */
  subagentProvider: string
  /** Default outbound connection timeout (ms). */
  defaultTimeoutMs: number
}

/** Loader-validated config schema (defaults applied by the Loader). */
export const Config: z<A2AConfig> = z.object({
  baseUrl: z.string(),
  subagentProvider: z.string().default('in-process'),
  defaultTimeoutMs: z.number().default(60_000),
})

export function apply(ctx: Context, config: A2AConfig) {
  const logger = ctx.logger('a2a')
  const subagentProvider = config.subagentProvider
  const inboundCwd = inboundSessionCwd()

  ctx.inject(['storageDomain'], (ctx) => {
    ctx.effect(async () => {
      const domain = await openDomain(ctx.storageDomain)
      const store = new DomainTaskStore(domain)

      // Probe the optional host services each half uses.
      const webServer = probeService(ctx, 'webServer', 'register') as InboundWebServerLike | undefined
      const tools = probeService(ctx, 'tools', 'register') as
        | ({ get(name: string): unknown } & { register(def: unknown): (() => void) | void })
        | undefined
      const agents = probeService(ctx, 'agents', 'create') as AgentRegistryLike | undefined
      const agentPresets = probeService(ctx, 'agentPresets', 'list') as
        | (AgentPresetsLike & { list(): Promise<Array<{ id: string; name?: string; description?: string }>>; readonly defaultId?: string })
        | undefined
      const skills = probeService(ctx, 'skills', 'list') as SkillsLike | undefined
      const credentials = probeService(ctx, 'credentials', 'resolve') as CredentialsLike | undefined
      const subagents = probeService(ctx, 'subagents', 'start') as SubagentsLike | undefined
      const commandsRef = probeService(ctx, 'commands', 'register') as
        | { register(def: { name: string; description: string; handler(...args: unknown[]): unknown }): () => void }
        | undefined

      const baseUrl = config.baseUrl ?? `http://127.0.0.1:${webServerPort(webServer) ?? process.env['DSH_A2A_PORT'] ?? '3000'}`

      // ── inbound manager ───────────────────────────────────────────────
      const inboundHost: InboundManagerHost = {
        ctx,
        webServer: webServer ?? { register: noopRegister },
        tasks: store,
        logger,
        ...(agents !== undefined ? { agents } : {}),
        ...(agentPresets !== undefined ? { agentPresets } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(credentials !== undefined ? { credentials } : {}),
        ...(subagents !== undefined ? { subagents } : {}),
        ...(agentPresets?.defaultId !== undefined ? { defaultPresetId: agentPresets.defaultId } : {}),
        resolveDefaultModel: () => resolveDefaultModel(ctx),
        sessionCwd: inboundCwd,
        defaultBaseUrl: baseUrl,
        subagentProvider,
        newId: () => crypto.randomUUID().slice(0, 8),
      }
      const inboundManager = new InboundServerManager(inboundHost, new DomainInboundStore(domain.inbound_servers))
      await inboundManager.boot()

      // ── outbound manager ──────────────────────────────────────────────
      const outboundHost: OutboundManagerHost = {
        registrar: { register: (def) => tools?.register(def) },
        tokenOf: async (env) => (env ? await resolveAuthToken(credentials, env) : undefined),
        ...(credentials !== undefined ? { credentials } : {}),
        onError: (message) => logger.warn(message),
        defaultTimeoutMs: config.defaultTimeoutMs,
      }
      const outboundManager = new OutboundServerManager(
        outboundHost,
        domain.agents,
        new DomainOutboundStore(domain.outbound_servers),
        () => `out-${crypto.randomUUID().slice(0, 12)}`,
      )
      outboundManager.boot()

      // ── service facade + commands + GUI API ───────────────────────────
      const impl: A2AServiceImpl = makeFacade({ domain, store, inboundManager, outboundManager, agentPresets, logger: logger.info.bind(logger) })
      new A2AService(ctx, impl)

      if (commandsRef !== undefined) {
        ctx.effect(() => commandsRef.register(buildA2aCommand(impl) as never), 'a2a: command')
      }

      if (webServer !== undefined) {
        ctx.effect(() => webServer.register({
          kind: 'prefix',
          path: '/a2a/api',
          handler: (req: unknown, res: unknown) => handleApiRequest(req as never, res as never, impl),
        }), 'a2a: dashboard api')
      } else {
        logger.warn('a2a: webServer not mounted; GUI dashboard API idle')
      }

      return async () => {
        inboundManager.disposeAll()
        await outboundManager.disposeAll()
        await domain.close()
      }
    }, 'a2a: multi-instance composition')
  })
}

interface FacadeHost {
  readonly domain: A2aDomain
  readonly store: TaskStore
  readonly inboundManager: InboundServerManager
  readonly outboundManager: OutboundServerManager
  readonly agentPresets?: (AgentPresetsLike & { list(): Promise<Array<{ id: string; name?: string; description?: string }>>; readonly defaultId?: string }) | undefined
  readonly logger: (message: string) => void
}

/** Facade closure over the two managers (commands and `ctx.a2a` consumers). */
function makeFacade(host: FacadeHost): A2AServiceImpl {
  const inboundView = (id: string): InboundServerView | undefined => {
    const live = host.inboundManager.get(id)
    if (live === undefined) return undefined
    const r = live.record
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.version,
      endpointPath: live.endpointPath,
      // Effective preset: the record's, else the deployment default.
      ...(live.preset !== undefined ? { preset: live.preset } : {}),
      ...(r.authTokenEnv !== undefined ? { authTokenEnv: r.authTokenEnv } : {}),
      cardPath: live.cardPath,
      ...(live.card.supportedInterfaces?.[0]?.url !== undefined ? { cardUrl: live.card.supportedInterfaces[0].url } : {}),
      enabled: live.routes.active,
      skills: live.skills.map((s): SkillView => ({ id: s.id, name: s.name, ...(s.description != null ? { description: s.description } : {}) })),
    }
  }

  // Cancel every non-terminal task of one context through whichever instance
  // owns the shared task store (abort is idempotent per task record).
  const cancelContextTasks = (contextId: string): number => {
    let canceled = 0
    for (const task of host.store.list()) {
      if (task.contextId !== contextId || isTerminal(task.state)) continue
      for (const live of host.inboundManager.list()) {
        if (live.server.abort(task.taskId)) {
          canceled += 1
          break
        }
      }
    }
    return canceled
  }

  // Aggregate the session layer: live observations (streaming, pool handles)
  // folded over the shared task store, grouped by contextId.
  const sessionViews = (): SessionView[] => aggregateSessionViews(host.store.list(), host.inboundManager.list())

  return {
    status(): unknown {
      return {
        inbounds: host.inboundManager.list().map((live) => inboundView(live.id)).filter((v): v is InboundServerView => v !== undefined),
        outbounds: host.outboundManager.list(),
        tasks: host.store.list().length,
        sessions: sessionViews(),
      }
    },
    async presets(): Promise<PresetView[]> {
      if (host.agentPresets === undefined) return []
      const defaultId = host.agentPresets.defaultId
      try {
        return (await host.agentPresets.list()).map((p) => ({
          id: p.id,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(defaultId !== undefined && p.id === defaultId ? { isDefault: true } : {}),
        }))
      } catch {
        return []
      }
    },
    // ── inbound ─────────────────────────────────────────────────────────
    listInboundServers(): InboundServerView[] {
      return host.inboundManager.list().map((live) => inboundView(live.id)).filter((v): v is InboundServerView => v !== undefined)
    },
    async createInboundServer(input: InboundCreateInput): Promise<OpResult> {
      const result = await host.inboundManager.add({
        name: input.name,
        description: input.description,
        version: input.version,
        ...(input.endpointPath !== undefined ? { endpointPath: input.endpointPath } : {}),
        ...(input.preset !== undefined ? { preset: input.preset } : {}),
        ...(input.authTokenEnv !== undefined ? { authTokenEnv: input.authTokenEnv } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      })
      host.logger(`[a2a] inbound created: ${result.message}`)
      return result
    },
    async removeInboundServer(id: string): Promise<OpResult> {
      return host.inboundManager.remove(id)
    },
    async setInboundServerEnabled(id: string, enabled: boolean): Promise<OpResult> {
      return host.inboundManager.setEnabled(id, enabled)
    },
    async updateInboundServer(id: string, patch: { name?: string; description?: string; version?: string; endpointPath?: string; preset?: string; authTokenEnv?: string }): Promise<OpResult> {
      return host.inboundManager.update(id, patch)
    },
    async setInboundAuth(id: string, token: string | undefined): Promise<OpResult> {
      return host.inboundManager.setAuth(id, token)
    },
    // ── outbound ────────────────────────────────────────────────────────
    listOutboundServers(): OutboundServerView[] {
      return [...host.outboundManager.list()]
    },
    async createOutboundServer(input: OutboundCreateInput): Promise<OpResult> {
      return host.outboundManager.add({
        ...(input.id !== undefined ? { id: input.id } : {}),
        name: input.name,
        agentCardUrl: input.agentCardUrl,
        ...(input.bearerTokenEnv !== undefined ? { bearerTokenEnv: input.bearerTokenEnv } : {}),
        ...(input.preset !== undefined ? { preset: input.preset } : {}),
        enabled: input.enabled ?? true,
        timeoutMs: input.timeoutMs ?? host.outboundManager.defaultTimeoutMs,
      })
    },
    async removeOutboundServer(id: string): Promise<OpResult> {
      return host.outboundManager.remove(id)
    },
    async setOutboundServerEnabled(id: string, enabled: boolean): Promise<OpResult> {
      return host.outboundManager.setEnabled(id, enabled)
    },
    async refreshOutboundServer(id: string): Promise<OpResult> {
      return host.outboundManager.refresh(id)
    },
    async setOutboundAuth(id: string, token: string | undefined): Promise<OpResult> {
      return host.outboundManager.setAuth(id, token)
    },
    async discoverOutbound(url: string, bearerToken?: string): Promise<OpResult & { readonly preview?: unknown }> {
      return host.outboundManager.discover(url, bearerToken)
    },
    async updateOutboundServer(id: string, patch: { readonly name?: string; readonly preset?: string; readonly timeoutMs?: number }): Promise<OpResult> {
      return host.outboundManager.update(id, patch)
    },
    // ── tasks ───────────────────────────────────────────────────────────
    getTask(taskId: string): unknown {
      return host.store.get(taskId)
    },
    listTasks(): unknown {
      return host.store.list()
    },
    async cancelTask(taskId: string): Promise<OpResult> {
      const live = host.inboundManager.list().find((l) => l.server.abort(taskId))
      return { ok: live !== undefined, message: live !== undefined ? `task ${taskId} canceled` : `task ${taskId} not found or already terminal` }
    },
    // ── inbound sessions (per contextId) ────────────────────────────────
    listSessions(): SessionView[] {
      return sessionViews()
    },
    async cancelSessionTasks(contextId: string): Promise<OpResult> {
      const canceled = cancelContextTasks(contextId)
      return {
        ok: true,
        message: canceled > 0
          ? `session ${contextId}: canceled ${canceled} active task(s)`
          : `session ${contextId}: no active tasks`,
      }
    },
    async closeSession(contextId: string): Promise<OpResult> {
      const canceled = cancelContextTasks(contextId)
      // Dispose every live handle for the context across instances; the next
      // task on the same contextId re-opens a fresh handle (never refused —
      // A2A has no closed-context concept, see session-registry docs).
      let closed = 0
      for (const live of host.inboundManager.list()) {
        if (live.sessionPool !== undefined && live.sessionPool.has(contextId)) {
          await live.sessionPool.disposeContext(contextId)
          closed += 1
        }
      }
      const parts: string[] = [
        ...(canceled > 0 ? [`canceled ${canceled} active task(s)`] : []),
        ...(closed > 0 ? [`closed ${closed} live session(s)`] : []),
      ]
      return {
        ok: true,
        message: parts.length > 0 ? `session ${contextId}: ${parts.join('; ')}` : `session ${contextId}: no active tasks or live sessions`,
      }
    },
    // ── inbound peers (aggregated across instances) ─────────────────────
    inbounds(): unknown {
      return host.inboundManager.list().flatMap((live) => live.inbound.list())
    },
    async closeInbound(peerId: string): Promise<OpResult> {
      for (const live of host.inboundManager.list()) {
        const peers = live.inbound.activeTasksOf(peerId)
        for (const taskId of peers) live.server.abort(taskId)
        const result = live.inbound.closePeer(peerId)
        if (result) return { ok: true, message: `inbound peer ${peerId} closed` }
      }
      return { ok: false, message: `inbound peer ${peerId} not found` }
    },
  }
}

function resolveDefaultModel(ctx: Context): { provider?: string; model?: string } | undefined {
  const service = probeService(ctx, 'agentDefaultModel', 'currentSelection') as
    | { currentSelection(): { provider?: string; model?: string } }
    | undefined
  return service?.currentSelection()
}

/** Absolute stable cwd for inbound per-context sessions (never profile root). */
function inboundSessionCwd(): string {
  const home = join(homedir(), '.dsh')
  const dshHome = process.env['DSH_HOME'] ?? home
  const dir = join(dshHome, 'a2a-sessions')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // cwd fallback below stays valid
  }
  return dir
}

function noopRegister(): () => void {
  return () => {}
}

/** The listening port of a mounted webServer (undefined when unavailable). */
function webServerPort(webServer: InboundWebServerLike | undefined): string | undefined {
  const candidate = webServer as { port?: number | (() => number) } | undefined
  if (candidate === undefined) return undefined
  const value = typeof candidate.port === 'function' ? (candidate as { port(): number }).port() : candidate.port
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

export type { OpResult }
export { A2AServer } from './server/a2a-server.ts'
export { A2AClient, A2AError } from './outbound/calls.ts'
export { A2AService } from './service.ts'
