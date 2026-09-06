/**
 * @hanphone/dsh-a2a — Cordis plugin entry.
 *
 * Mounts the A2A v1.0 dual-end plugin: the inbound server (AgentCard derived
 * from the live tool registry, JSON-RPC + SSE, durable SQLite task store,
 * session/subagent executors, the `a2a/inbound-task` policy gate + audit)
 * and the outbound client (persisted multi-agent registry, skills mapped to
 * model tools, sync calls with per-agent timeout). Optional services are
 * probed rather than injected so a composition lacking one half idles just
 * that half; only the storage domain is required.
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
import { deriveSkills, buildCard, type ToolGetter } from './server/card.ts'
import { openDomain, DomainTaskStore, type A2aDomain, type TaskStore } from './server/store.ts'
import { ExecutorSet } from './server/executor.ts'
import { ContextSessionPool, probeService, type AgentPresetsLike, type AgentRegistryLike } from './server/exec/agent-runtime.ts'
import { createSessionExecutor } from './server/exec/session.ts'
import { createSubagentExecutor, type SubagentsLike } from './server/exec/subagent.ts'
import { A2AServer, type GateInput, type GateResult } from './server/a2a-server.ts'
import { A2aRoutes } from './server/routes.ts'
import { handleApiRequest } from './api.ts'
import { OutboundAgentRegistry, DomainAgentStore, type OutboundAgentSpec } from './outbound/registry.ts'
import { A2AService, type A2AServiceImpl, type OpResult } from './service.ts'
import { buildA2aCommand } from './commands.ts'
import type { InboundTaskDecision } from './events.ts'
import type { AgentCard, AgentSkill, TaskState } from './protocol.ts'

export const name = 'a2a'

/** Only the storage domain is required; the other halves are probed. */
export const inject = ['storageDomain'] as const

export interface A2AConfig {
  server: {
    enabled: boolean
    name: string
    description: string
    version: string
    /** Advertised base URL; null/absent lets the host webServer address be used. */
    baseUrl?: string
    endpointPath: string
    /** Environment variable name for the inbound bearer token; absent = anonymous. */
    authTokenEnv?: string
    skills: { ids: string[]; exclude: string[] }
    executors: Record<string, 'session' | 'subagent'>
    subagentProvider: string
  }
  client: {
    agents: OutboundAgentSpec[]
    toolPrefix: string
  }
}

/** Loader-validated config schema (defaults applied by the Loader). */
export const Config: z<A2AConfig> = z.object({
  server: z.object({
    enabled: z.boolean().default(true),
    name: z.string().default('My DSH Agent'),
    description: z.string().default('A DeepSeek Harness agent exposed over A2A v1.0'),
    version: z.string().default('0.1.0'),
    baseUrl: z.string(),
    endpointPath: z.string().default('/a2a'),
    authTokenEnv: z.string(),
    skills: z.object({
      ids: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    }),
    executors: z.dict(z.union(['session', 'subagent'] as const)).default({ chat: 'session' }),
    subagentProvider: z.string().default('in-process'),
  }),
  client: z.object({
    agents: z.array(z.object({
      name: z.string(),
      agentCardUrl: z.string(),
      bearerTokenEnv: z.string(),
      enabled: z.boolean().default(true),
      timeoutMs: z.number().default(60000),
    })).default([]),
    toolPrefix: z.string().default('a2a'),
  }),
})

/** Mutable state shared across the plugin's halves. */
interface Shared {
  readonly domain: A2aDomain
  readonly store: TaskStore
  registry: OutboundAgentRegistry | undefined
  server: A2AServer | undefined
  routes: A2aRoutes | undefined
  card: AgentCard | undefined
  executors: ExecutorSet | undefined
  enabled: boolean
}

export function apply(ctx: Context, config: A2AConfig) {
  const logger = ctx.logger('a2a')
  const serverConfig = { ...config.server }
  const clientConfig = { ...config.client }
  const authToken = serverConfig.authTokenEnv !== undefined ? process.env[serverConfig.authTokenEnv] : undefined
  const toolPrefix = clientConfig.toolPrefix
  const subagentProvider = serverConfig.subagentProvider
  const inboundCwd = inboundSessionCwd()

  ctx.inject(['storageDomain'], (ctx) => {
    ctx.effect(async () => {
      const domain = await openDomain(ctx.storageDomain)
      const store = new DomainTaskStore(domain)
      const holder: Shared = {
        domain,
        store,
        registry: undefined,
        server: undefined,
        routes: undefined,
        card: undefined,
        executors: undefined,
        enabled: serverConfig.enabled,
      }

      // ── inbound server half ────────────────────────────────────────────
      const webServer = probeService(ctx, 'webServer', 'register') as
        | { register(route: { kind: 'exact' | 'prefix'; path: string; handler(...args: unknown[]): unknown }): () => void }
        | undefined
      if (webServer === undefined) {
        logger.warn('a2a: webServer not mounted; inbound server idle')
      } else {
        try {
          const skills = deriveSkills(
            probeService(ctx, 'tools', 'get') as ToolGetter | undefined ?? { get: () => undefined },
            { ids: serverConfig.skills.ids, exclude: serverConfig.skills.exclude },
          )
          const baseUrl = serverConfig.baseUrl ?? `http://127.0.0.1:${process.env['DSH_A2A_PORT'] ?? '3000'}`
          const endpointPath = serverConfig.endpointPath ?? '/a2a'
          const card = buildCard({
            baseUrl,
            endpointPath,
            name: serverConfig.name ?? 'My DSH Agent',
            description: serverConfig.description ?? 'A DeepSeek Harness agent exposed over A2A v1.0',
            version: serverConfig.version ?? '0.1.0',
            skills,
            ...(authToken ? { authToken } : {}),
          })
          holder.card = card

          // Executors: probe the agent loop; refuse tasks readably without it.
          const agents = probeService(ctx, 'agents', 'create') as AgentRegistryLike | undefined
          const presets = probeService(ctx, 'agentPresets', 'resolve') as AgentPresetsLike | undefined
          const sessionPool = agents
            ? new ContextSessionPool(agents, {
              cwd: inboundCwd,
              ...(presets ? { agentPresets: presets } : {}),
              resolveAgentOptions: () => resolveDefaultModel(ctx),
            })
            : undefined
          const sessionExecutor = sessionPool ? createSessionExecutor(sessionPool) : refuseExecutor('no agent loop mounted')
          const subagents = probeService(ctx, 'subagents', 'start') as SubagentsLike | undefined
          const subagentExecutor = sessionPool !== undefined && subagents !== undefined
            ? createSubagentExecutor({ pool: sessionPool, subagents, provider: subagentProvider })
            : undefined
          const executors = new ExecutorSet(serverConfig.executors, sessionExecutor, subagentExecutor)
          holder.executors = executors

          const skillIds = new Set(skills.map((s) => s.id))
          const gate = async (input: GateInput): Promise<GateResult> => {
            if (!skillIds.has(input.skill)) {
              return { ok: false, reason: `unknown skill "${input.skill}"` }
            }
            const decision: InboundTaskDecision = {
              contextId: input.contextId,
              skill: input.skill,
              parts: input.parts,
              remotePeerId: input.remotePeerId,
            }
            const decided = await ctx.waterfall('a2a/inbound-task', decision, async (d) => d)
            // Built-in audit: every task decision is logged with its source.
            logger.info(`[a2a] inbound skill=${decided.skill} remote=${decided.remotePeerId} rejected=${decided.rejected?.reason ?? 'no'}`)
            if (decided.rejected !== undefined) return { ok: false, reason: decided.rejected.reason }
            return { ok: true }
          }

          const server = new A2AServer({
            card,
            store,
            executors,
            ...(authToken ? { authToken } : {}),
            gate,
            onTaskSettled: (taskId) => logger.info(`[a2a] task settled ${taskId}`),
          })
          holder.server = server
          const routes = new A2aRoutes(webServer as never, server)
          holder.routes = routes
          if (holder.enabled) routes.enable()
        } catch (err) {
          logger.error(`a2a: server half failed to build: ${(err as Error).message}`)
        }
      }

      // ── outbound client half (after the inbound routes exist, so a
      // loopback agent can fetch this server's own card) ──────────────────
      const toolsService = probeService(ctx, 'tools', 'get') as
        | (ToolGetter & { register(def: unknown): (() => void) | void })
        | undefined
      if (toolsService === undefined) {
        logger.warn('a2a: tools service not mounted; outbound client idle')
      } else {
        const registry = new OutboundAgentRegistry({
          registrar: { register: (def) => toolsService.register(def) },
          store: new DomainAgentStore(domain.agents),
          toolPrefix,
          tokenOf: (env) => (env ? process.env[env] : undefined),
          onError: (message) => logger.warn(message),
        })
        holder.registry = registry
        registry.loadAll()
        // Declared agents seed the registry: the persisted store stays the
        // runtime state, so a disabled or removed agent is not reconnected.
        if (clientConfig.agents.length > 0) await registry.seed(clientConfig.agents)
      }

      // ── service facade + commands ──────────────────────────────────────
      const impl: A2AServiceImpl = makeFacade(holder, logger.info.bind(logger))
      new A2AService(ctx, impl)

      const commands = probeService(ctx, 'commands', 'register') as
        | { register(def: { name: string; description: string; handler(...args: unknown[]): unknown }): () => void }
        | undefined
      if (commands !== undefined) {
        ctx.effect(() => commands.register(buildA2aCommand(impl) as never), 'a2a: command')
      }

      // ── GUI dashboard API (loopback-only /a2a/api) ─────────────────────
      const dashboardWebServer = probeService(ctx, 'webServer', 'register') as
        | { register(route: { kind: 'exact' | 'prefix'; path: string; handler(...args: unknown[]): unknown }): () => void }
        | undefined
      if (dashboardWebServer !== undefined) {
        ctx.effect(() => dashboardWebServer.register({
          kind: 'prefix',
          path: '/a2a/api',
          handler: (req: unknown, res: unknown) => handleApiRequest(req as never, res as never, impl),
        }), 'a2a: dashboard api')
      } else {
        logger.warn('a2a: webServer not mounted; GUI dashboard API idle')
      }

      return async () => {
        holder.routes?.dispose()
        await holder.executors?.disposeAll()
        await holder.registry?.disposeAll()
        await domain.close()
      }
    }, 'a2a: domain + halves')
  })
}

/** Facade closure over the shared holder (commands and `ctx.a2a` consumers). */
function makeFacade(holder: Shared, log: (message: string) => void): A2AServiceImpl {
  const serverEnabled = (): boolean => holder.routes?.active ?? false
  return {
    status(): unknown {
      return {
        server: {
          enabled: serverEnabled(),
          cardUrl: holder.card?.supportedInterfaces?.[0]?.url,
          skills: holder.card?.skills?.map((s) => s.id) ?? [],
          executors: holder.executors ? ['session', ...(holder.executors['subagent'] !== undefined ? ['subagent'] : [])] : [],
        },
        tasks: holder.store.list().length,
        agents: holder.registry?.list() ?? [],
      }
    },
    async enableServer(enable: boolean): Promise<OpResult> {
      if (holder.routes === undefined) return { ok: false, message: 'inbound server is not mounted (no webServer)' }
      if (enable) holder.routes.enable()
      else holder.routes.disable()
      log(`[a2a] server ${enable ? 'enabled' : 'disabled'}`)
      return { ok: true, message: `server ${enable ? 'enabled' : 'disabled'}` }
    },
    getTask(taskId: string): unknown {
      return holder.store.get(taskId)
    },
    listTasks(): unknown {
      return holder.store.list()
    },
    async cancelTask(taskId: string): Promise<OpResult> {
      const record = holder.store.get(taskId)
      if (record === undefined) return { ok: false, message: `task ${taskId} not found` }
      const aborted = holder.server?.abort?.(taskId) ?? false
      return { ok: true, message: aborted ? `task ${taskId} canceled` : `task ${taskId} already terminal` }
    },
    agents(): unknown {
      return holder.registry?.list() ?? []
    },
    async addAgent(spec: { name: string; agentCardUrl: string; bearerTokenEnv?: string }): Promise<OpResult> {
      const registry = holder.registry
      if (registry === undefined) return { ok: false, message: 'outbound client not mounted (no tools service)' }
      const result = await registry.add({ ...spec, enabled: true, timeoutMs: 60000 })
      return result
    },
    async removeAgent(id: string): Promise<OpResult> {
      return holder.registry?.remove(id) ?? { ok: false, message: 'outbound client not mounted' }
    },
    async setAgentEnabled(id: string, enabled: boolean): Promise<OpResult> {
      return holder.registry?.setEnabled(id, enabled) ?? { ok: false, message: 'outbound client not mounted' }
    },
    async refreshAgentCard(id: string): Promise<OpResult> {
      return holder.registry?.refresh(id) ?? { ok: false, message: 'outbound client not mounted' }
    },
  }
}

/** A task that refuses readably on compositions without an agent loop. */
function refuseExecutor(reason: string) {
  return {
    name: 'refuse',
    async execute(): Promise<{ parts: { text: string }[] }> {
      throw new Error(`a2a: ${reason}; refusing inbound task`)
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

export type { TaskState }
export type { AgentSkill }
export { A2AServer } from './server/a2a-server.ts'
export { A2AClient, A2AError } from './outbound/calls.ts'
export { A2AService } from './service.ts'