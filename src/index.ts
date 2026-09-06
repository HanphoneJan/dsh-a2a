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
import { probeService, type AgentPresetsLike, type AgentRegistryLike } from './server/exec/agent-runtime.ts'
import type { SubagentsLike } from './server/exec/subagent.ts'
import { handleApiRequest } from './api.ts'
import { A2AService, type A2AServiceImpl, type InboundCreateInput, type InboundServerView, type OutboundCreateInput, type OpResult, type PresetView, type SkillView } from './service.ts'
import { buildA2aCommand } from './commands.ts'
import { InboundServerManager, DomainInboundStore, type InboundManagerHost, type WebServerLike as InboundWebServerLike } from './servers/inbound-manager.ts'
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
        | (AgentPresetsLike & { list(): Promise<Array<{ id: string; name?: string; description?: string; isDefault?: boolean }>> })
        | undefined
      const subagents = probeService(ctx, 'subagents', 'start') as SubagentsLike | undefined
      const commandsRef = probeService(ctx, 'commands', 'register') as
        | { register(def: { name: string; description: string; handler(...args: unknown[]): unknown }): () => void }
        | undefined

      const baseUrl = config.baseUrl ?? `http://127.0.0.1:${process.env['DSH_A2A_PORT'] ?? '3000'}`

      // ── inbound manager ───────────────────────────────────────────────
      const inboundHost: InboundManagerHost = {
        ctx,
        webServer: webServer ?? { register: noopRegister },
        tasks: store,
        logger,
        ...(agents !== undefined ? { agents } : {}),
        ...(agentPresets !== undefined ? { agentPresets } : {}),
        ...(subagents !== undefined ? { subagents } : {}),
        resolveDefaultModel: () => resolveDefaultModel(ctx),
        sessionCwd: inboundCwd,
        defaultBaseUrl: baseUrl,
        subagentProvider,
        newId: () => crypto.randomUUID().slice(0, 8),
      }
      const inboundManager = new InboundServerManager(inboundHost, new DomainInboundStore(domain.inbound_servers))
      inboundManager.boot()

      // ── outbound manager ──────────────────────────────────────────────
      const outboundHost: OutboundManagerHost = {
        registrar: { register: (def) => tools?.register(def) },
        tokenOf: (env) => (env ? process.env[env] : undefined),
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
  readonly agentPresets?: (AgentPresetsLike & { list(): Promise<Array<{ id: string; name?: string; description?: string; isDefault?: boolean }>> }) | undefined
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
      ...(r.preset !== undefined ? { preset: r.preset } : {}),
      ...(r.authTokenEnv !== undefined ? { authTokenEnv: r.authTokenEnv } : {}),
      cardPath: live.cardPath,
      ...(live.card.supportedInterfaces?.[0]?.url !== undefined ? { cardUrl: live.card.supportedInterfaces[0].url } : {}),
      enabled: live.routes.active,
      skills: r.skills.map((s): SkillView => ({ id: s.id, name: s.name, ...(s.description != null ? { description: s.description } : {}) })),
    }
  }

  return {
    status(): unknown {
      return {
        inbounds: host.inboundManager.list().map((live) => inboundView(live.id)).filter((v): v is InboundServerView => v !== undefined),
        outbounds: host.outboundManager.list(),
        tasks: host.store.list().length,
      }
    },
    async presets(): Promise<PresetView[]> {
      if (host.agentPresets === undefined) return []
      try {
        return (await host.agentPresets.list()).map((p) => ({
          id: p.id,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.isDefault === true ? { isDefault: true } : {}),
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
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
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
    async updateInboundServer(id: string, patch: { name?: string; description?: string; version?: string; endpointPath?: string; preset?: string; authTokenEnv?: string; skills?: readonly SkillView[] }): Promise<OpResult> {
      return host.inboundManager.update(id, patch)
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

export type { OpResult }
export { A2AServer } from './server/a2a-server.ts'
export { A2AClient, A2AError } from './outbound/calls.ts'
export { A2AService } from './service.ts'
