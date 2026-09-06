/**
 * Inbound server manager: owns every inbound A2A server instance. Each
 * instance binds one agent preset (its session pool is composed from that
 * preset), advertises creator-declared skills, and serves its own endpoint and
 * AgentCard route. Instances are persisted in the `inbound_servers` domain
 * table and assembled on boot; the manager owns route registration and the
 * full lifecycle (add/enable/disable/update/remove) driven from the GUI and
 * facade, and disposes every instance's environment on teardown.
 *
 * Skill declaration: the stored `skills` list is exactly what the creator
 * declared. When a creator leaves it empty at creation time, the default skill
 * derives from the bound preset's display name (else the built-in `chat`
 * skill), per the v1.0 design — the v0.2 tool white-list derivation is gone.
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
import type { TaskStore, InboundServerRecord } from '../server/store.ts'
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
  readonly tasks: TaskStore
  readonly logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
  readonly agents?: AgentRegistryLike
  readonly agentPresets?: AgentPresetsLike
  readonly subagents?: SubagentsLike
  readonly sessionCwd: string
  readonly defaultBaseUrl: string
  readonly subagentProvider: string
  /** Resolve the deployment's default model options (may be undefined). */
  readonly resolveDefaultModel?: () => { readonly provider?: string; readonly model?: string } | undefined
  /** Allocate a fresh stable instance id. */
  readonly newId: () => string
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
  readonly endpointPath: string
  readonly cardPath: string
  dispose(): void
}

/** Creator input for a new (or updated) inbound instance. */
export interface InboundCreateInput {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly endpointPath?: string
  readonly preset?: string
  readonly authTokenEnv?: string
  /** Declared skills; empty defaults to the preset name (or `chat`). */
  readonly skills?: readonly AgentSkill[]
  readonly enabled?: boolean
}

export interface OpResult {
  readonly ok: boolean
  readonly message: string
}

function refuseExecutor(reason: string) {
  return {
    name: 'refuse',
    async execute(): Promise<{ parts: { text: string }[] }> {
      throw new Error(`a2a: ${reason}; refusing inbound task`)
    },
  }
}

/** Default skkill when a creator declares none: the preset display name. */
export function defaultSkillFor(
  skills: readonly AgentSkill[] | undefined,
  presetName: string | undefined,
): readonly AgentSkill[] {
  if (skills !== undefined && skills.length > 0) return skills
  if (presetName !== undefined && presetName.length > 0) {
    return [{ id: 'chat', name: presetName, description: `Compose inbound sessions from the "${presetName}" agent preset.`, tags: ['preset'] }]
  }
  return [{ id: 'chat', name: 'chat', description: 'Conversational assistance over a DSH agent session.', tags: ['chat'] }]
}

/** Assemble one live instance from a persisted record. */
function assemble(record: InboundServerRecord, host: InboundManagerHost): LiveInboundServer {
  const skills: readonly AgentSkill[] = record.skills
  const endpointPath = record.endpointPath
  const cardPath = `${endpointPath.replace(/\/$/, '')}/agent-card.json`
  const card = buildCard({
    baseUrl: host.defaultBaseUrl,
    endpointPath,
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
      // exactOptionalPropertyTypes.
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
    store: host.tasks,
    executors,
    ...(card.securitySchemes !== undefined ? { authToken: 'configured' } : {}),
    cardPath,
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
  const routes = new A2aRoutes(host.webServer, server, cardPath)

  return {
    id: record.id,
    record,
    card,
    server,
    routes,
    inbound,
    executors,
    endpointPath,
    cardPath,
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
    // Call through the table (method `this` stays bound); the real KvTable's
    // `entries()` reads instance state.
    for (const [key, raw] of entries.call(this.table)) {
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
    private readonly store: DomainInboundStore,
  ) {}

  /** Assemble every persisted enabled instance (boot). */
  boot(): void {
    for (const record of this.store.list()) {
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

  /** Resolve the display name of a preset id (undefined when unnamed/absent). */
  private async presetDisplayName(preset: string | undefined): Promise<string | undefined> {
    if (preset === undefined || this.host.agentPresets === undefined) return undefined
    try {
      const resolved = await this.host.agentPresets.resolve(preset)
      return resolved.name ?? resolved.id
    } catch {
      return undefined
    }
  }

  /** Create, persist, and assemble a new inbound instance. */
  async add(input: InboundCreateInput): Promise<OpResult & { readonly id?: string }> {
    const id = this.newId(input.name)
    if (this.live.has(id)) return { ok: false, message: `inbound server ${id} already exists` }
    const presetName = await this.presetDisplayName(input.preset)
    const record: InboundServerRecord = {
      id,
      name: input.name,
      description: input.description,
      version: input.version,
      endpointPath: input.endpointPath ?? `/a2a/${id}`,
      ...(input.preset !== undefined ? { preset: input.preset } : {}),
      ...(input.authTokenEnv !== undefined ? { authTokenEnv: input.authTokenEnv } : {}),
      skills: [...defaultSkillFor(input.skills, presetName)],
      enabled: input.enabled ?? true,
    }
    try {
      const live = assemble(record, this.host)
      await this.store.save(record)
      this.live.set(id, live)
      if (record.enabled) live.routes.enable()
      return { ok: true, message: `inbound server "${record.name}" created`, id }
    } catch (err) {
      return { ok: false, message: `failed to create inbound server: ${String((err as Error).message)}` }
    }
  }

  /** Persist, rebuild, and apply a patch onto a live instance. */
  async update(id: string, patch: Partial<Pick<InboundServerRecord, 'name' | 'description' | 'version' | 'endpointPath' | 'preset' | 'authTokenEnv' | 'skills'>>): Promise<OpResult> {
    const live = this.live.get(id)
    const stored = this.store.get(id)
    if (live === undefined || stored === undefined) return { ok: false, message: `inbound server ${id} not found` }
    const next: InboundServerRecord = {
      ...stored,
      name: patch.name ?? stored.name,
      description: patch.description ?? stored.description,
      version: patch.version ?? stored.version,
      endpointPath: patch.endpointPath ?? stored.endpointPath,
      ...(patch.preset !== undefined ? { preset: patch.preset } : {}),
      ...(patch.authTokenEnv !== undefined ? { authTokenEnv: patch.authTokenEnv } : {}),
      skills: patch.skills ?? stored.skills,
      enabled: stored.enabled,
    }
    try {
      await this.store.save(next)
      const replaced = assemble(next, this.host)
      // Preserve the route registration state while swapping runtime halves.
      const wasEnabled = live.routes.active
      live.dispose()
      this.live.set(id, replaced)
      if (wasEnabled || next.enabled) replaced.routes.enable()
      return { ok: true, message: `inbound server ${id} updated` }
    } catch (err) {
      return { ok: false, message: `failed to update inbound server: ${String((err as Error).message)}` }
    }
  }

  /** Enable/disable an instance's routes. */
  setEnabled(id: string, enabled: boolean): OpResult {
    const live = this.live.get(id)
    if (live === undefined) return { ok: false, message: `inbound server ${id} not found` }
    if (enabled) live.routes.enable()
    else live.routes.disable()
    const stored = this.store.get(id)
    if (stored !== undefined) {
      void this.store.save({ ...stored, enabled }).catch(() => {})
    }
    return { ok: true, message: `inbound server ${id} ${enabled ? 'enabled' : 'disabled'}` }
  }

  /** Remove, dispose, and unpersist an instance. */
  async remove(id: string): Promise<OpResult> {
    const live = this.live.get(id)
    if (live === undefined) return { ok: false, message: `inbound server ${id} not found` }
    live.dispose()
    this.live.delete(id)
    await this.store.remove(id)
    return { ok: true, message: `inbound server ${id} removed` }
  }

  /** Dispose every instance. */
  disposeAll(): void {
    for (const live of this.live.values()) live.dispose()
    this.live.clear()
  }

  private newId(seed: string): string {
    const slug = seed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server'
    return `${slug}-${this.host.newId()}`
  }
}

export type { AgentSkill }
