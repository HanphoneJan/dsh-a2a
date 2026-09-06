/**
 * Inbound server manager: owns every inbound A2A server instance. Each
 * instance binds one agent preset (its session pool is composed from that
 * preset) and advertises creator-declared skills. Instances are persisted in
 * the `inbound_servers` domain table and assembled on boot. The manager owns
 * route registration, lifecycle (enable/disable/remove), and disposes every
 * instance's environment on teardown.
 * @module dsh-a2a/servers/inbound-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { buildCard } from '../server/card.ts'
import { A2AServer } from '../server/a2a-server.ts'
import { A2aRoutes } from '../server/routes.ts'
import { ContextSessionPool, type AgentPresetsLike, type AgentRegistryLike } from '../server/exec/agent-runtime.ts'
import { createSessionExecutor } from '../server/exec/session.ts'
import { createSubagentExecutor, type SubagentsLike } from '../server/exec/subagent.ts'
import { ExecutorSet } from '../server/executor.ts'
import { LiveInboundRegistry } from '../server/inbound-registry.ts'
import type { A2aDomain, InboundServerRecord, TaskStore } from '../server/store.ts'
import type { AgentSkill } from '../protocol.ts'
import type { GateInput, GateResult } from '../server/a2a-server.ts'
import type { InboundTaskDecision } from '../events.ts'

/** Web-server slice the manager registers instance routes on. */
export interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    handler(...args: unknown[]): unknown
  }): () => void
}

/** Host service slices one manager needs. */
export interface InboundManagerHost {
  readonly ctx: Context
  readonly webServer: WebServerLike
  readonly domain: A2aDomain
  readonly store: TaskStore
  readonly logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
  readonly tools?: { get(name: string): { readonly name: string; readonly description?: string } | undefined }
  readonly agents?: AgentRegistryLike
  readonly agentPresets?: AgentPresetsLike
  readonly subagents?: SubagentsLike
  readonly resolveDefaultModel?: () => { readonly provider?: string; readonly model?: string }
  readonly sessionCwd: string
  readonly defaultBaseUrl: string
  readonly subagentProvider: string
}

/** One live inbound instance's runtime handle. */
export interface LiveInboundServer {
  readonly id: string
  readonly record: InboundServerRecord
  readonly card: ReturnType<typeof buildCard>
  readonly server: A2AServer
  readonly routes: A2aRoutes
  readonly inbound: LiveInboundRegistry
  readonly executors: ExecutorSet
  dispose(): void
}

function refuseExecutor(reason: string) {
  return {
    name: 'refuse',
    async execute(): Promise<{ parts: { text: string }[] }> {
      throw new Error(`a2a: ${reason}; refusing inbound task`)
    },
  }
}

/** Assemble one inbound instance from a persisted record. */
function assemble(record: InboundServerRecord, host: InboundManagerHost): LiveInboundServer {
  const skills: readonly AgentSkill[] = record.skills
  const card = buildCard({
    baseUrl: host.defaultBaseUrl,
    endpointPath: record.endpointPath,
    name: record.name,
    description: record.description,
    version: record.version,
    skills,
    ...(record.authTokenEnv !== undefined && process.env[record.authTokenEnv] !== undefined
      ? { authToken: process.env[record.authTokenEnv]! }
      : {}),
  })

  // One preset-bound session pool per instance.
  const sessionPool = host.agents
    ? new ContextSessionPool(host.agents, {
      cwd: host.sessionCwd,
      ...(host.agentPresets !== undefined ? { agentPresets: host.agentPresets } : {}),
      ...(record.preset !== undefined ? { presetId: () => record.preset } : {}),
      // `?.()` yields `{ provider?, model? } | undefined`, matching the
      // AgentRuntimeOptions.resolveAgentOptions signature under
      // exactOptionalPropertyTypes (a bare `host.resolveDefaultModel` would
      // be a possibly-undefined function, whose return does not admit `| undefined`).
      resolveAgentOptions: () => host.resolveDefaultModel?.(),
    })
    : undefined
  const sessionExecutor = sessionPool ? createSessionExecutor(sessionPool) : refuseExecutor('no agent loop mounted')
  const subagentExecutor = sessionPool !== undefined && host.subagents !== undefined
    ? createSubagentExecutor({ pool: sessionPool, subagents: host.subagents, provider: host.subagentProvider })
    : undefined
  const executors = new ExecutorSet({ chat: 'session' }, sessionExecutor, subagentExecutor)

  const inbound = new LiveInboundRegistry()
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
    const decided = await host.ctx.waterfall('a2a/inbound-task', decision, async (d) => d)
    host.logger.info(`[a2a:${record.id}] inbound skill=${decided.skill} rejected=${decided.rejected?.reason ?? 'no'}`)
    if (decided.rejected !== undefined) return { ok: false, reason: decided.rejected.reason }
    return { ok: true }
  }

  const server = new A2AServer({
    card,
    store: host.store,
    executors,
    ...(card.securitySchemes !== undefined ? { authToken: 'configured' } : {}),
    gate,
    onInbound: (facts) => inbound.note({
      method: facts.method,
      ...(facts.source !== undefined ? { source: facts.source } : {}),
      taskIds: facts.taskIds,
      streaming: facts.streaming,
    }),
    onTaskSettled: (taskId) => {
      host.logger.info(`[a2a:${record.id}] task settled ${taskId}`)
      inbound.settle(taskId)
    },
  })
  const routes = new A2aRoutes(host.webServer as never, server)

  return {
    id: record.id,
    record,
    card,
    server,
    routes,
    inbound,
    executors,
    dispose: () => {
      routes.dispose()
      void executors.disposeAll().catch(() => {})
    },
  }
}

/** Persisted-instance store over the inbound_servers table. */
export class DomainInboundStore {
  private static KEY(id: string): string {
    return `in:${id}`
  }

  constructor(private readonly table: {
    get(key: string): string | undefined
    put(key: string, value: string): Promise<void>
    entries?(): IterableIterator<[string, string]>
    keys?(): IterableIterator<string>
  }) {}

  list(): InboundServerRecord[] {
    const out: InboundServerRecord[] = []
    const entries = this.table.entries
    if (entries === undefined) return out
    for (const [key, raw] of entries()) {
      if (!key.startsWith('in:')) continue
      const parsed = safeParse(raw)
      if (parsed !== undefined) out.push(parsed)
    }
    return out
  }

  get(id: string): InboundServerRecord | undefined {
    const raw = this.table.get(DomainInboundStore.KEY(id))
    return raw === undefined ? undefined : safeParse(raw)
  }

  async save(record: InboundServerRecord): Promise<void> {
    await this.table.put(DomainInboundStore.KEY(record.id), JSON.stringify(record))
  }

  async remove(id: string): Promise<void> {
    await this.table.put(DomainInboundStore.KEY(id), '')
  }
}

function safeParse(raw: string): InboundServerRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as InboundServerRecord
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || !Array.isArray(parsed.skills)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Manages the live set of inbound server instances. */
export class InboundServerManager {
  private readonly live = new Map<string, LiveInboundServer>()

  constructor(
    private readonly host: InboundManagerHost,
  ) {}

  /** Assemble every persisted enabled instance (boot). */
  boot(records: readonly InboundServerRecord[]): void {
    for (const record of records) {
      try {
        const live = assemble(record, this.host)
        this.live.set(record.id, live)
        if (record.enabled) live.routes.enable()
      } catch (err) {
        this.host.logger.error(`[a2a:${record.id}] failed to assemble: ${String((err as Error).message)}`)
      }
    }
  }

  list(): readonly LiveInboundServer[] {
    return [...this.live.values()]
  }

  get(id: string): LiveInboundServer | undefined {
    return this.live.get(id)
  }

  /** Enable/disable an instance's routes. */
  setEnabled(id: string, enabled: boolean): { readonly ok: boolean; readonly message: string } {
    const live = this.live.get(id)
    if (live === undefined) return { ok: false, message: `inbound server ${id} not found` }
    if (enabled) live.routes.enable()
    else live.routes.disable()
    return { ok: true, message: `inbound server ${id} ${enabled ? 'enabled' : 'disabled'}` }
  }

  /** Remove and dispose an instance. */
  remove(id: string): { readonly ok: boolean; readonly message: string } {
    const live = this.live.get(id)
    if (live === undefined) return { ok: false, message: `inbound server ${id} not found` }
    live.dispose()
    this.live.delete(id)
    return { ok: true, message: `inbound server ${id} removed` }
  }

  /** Dispose every instance. */
  disposeAll(): void {
    for (const live of this.live.values()) live.dispose()
    this.live.clear()
  }
}

export type { AgentSkill }
