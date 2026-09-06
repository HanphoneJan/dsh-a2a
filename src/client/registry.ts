/**
 * Outbound agent registry: the persisted list of connected remote agents,
 * their connection state, and the tool-registration disposers for each live
 * connection. Loaded at boot, mutations persist through the agent store.
 * @module dsh-a2a/client/registry
 */

import { A2AClient } from './calls.ts'
import { registerAgentTools, type ToolRegistrar } from './tools.ts'
import { type OutboundAgentRecord } from '../server/store.ts'

/** User-supplied agent spec (from config or the /a2a command). */
export interface OutboundAgentSpec {
  readonly name: string
  readonly agentCardUrl: string
  readonly bearerTokenEnv?: string
  readonly enabled?: boolean
  readonly timeoutMs?: number
}

export interface OutboundAgentView {
  readonly id: string
  readonly name: string
  readonly agentCardUrl: string
  readonly enabled: boolean
  readonly state: 'connected' | 'disconnected' | 'failed'
  readonly skillCount: number
  readonly toolCount: number
  readonly lastError?: string
}

/** Durable store for the registry records. */
export interface AgentStore {
  list(): OutboundAgentRecord[]
  save(records: readonly OutboundAgentRecord[]): Promise<void>
}

/** In-memory agent store (tests and minimal embeddings). */
export class MemoryAgentStore implements AgentStore {
  private records: OutboundAgentRecord[] = []

  constructor(initial: readonly OutboundAgentRecord[] = []) {
    this.records = [...initial]
  }

  list(): OutboundAgentRecord[] {
    return [...this.records]
  }

  async save(records: readonly OutboundAgentRecord[]): Promise<void> {
    this.records = [...records]
  }
}

/** Domain-backed agent store: one JSON array under the `agents` table key. */
export class DomainAgentStore implements AgentStore {
  private static readonly KEY = 'records'

  constructor(private readonly table: { get(key: string): string | undefined; put(key: string, value: string): Promise<void> }) {}

  list(): OutboundAgentRecord[] {
    const raw = this.table.get(DomainAgentStore.KEY)
    if (raw === undefined) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as OutboundAgentRecord[]) : []
    } catch {
      return []
    }
  }

  async save(records: readonly OutboundAgentRecord[]): Promise<void> {
    await this.table.put(DomainAgentStore.KEY, JSON.stringify(records))
  }
}

export interface RegistryOptions {
  readonly registrar: ToolRegistrar
  readonly store: AgentStore
  readonly toolPrefix?: string
  readonly defaultTimeoutMs?: number
  /** Resolve a bearer token from an env-var name; undefined when unset. */
  readonly tokenOf: (env: string | undefined) => string | undefined
  readonly onError?: (message: string) => void
}

interface LiveConnection {
  readonly record: OutboundAgentRecord
  readonly client: A2AClient
  readonly disposers: readonly { dispose(): void }[]
  readonly skillCount: number
}

/** A list of remote agents, each with live tool registrations when enabled. */
export class OutboundAgentRegistry {
  private readonly live = new Map<string, LiveConnection>()
  private readonly views = new Map<string, OutboundAgentView>()
  private seedRecords: OutboundAgentRecord[] | undefined

  constructor(private readonly opts: RegistryOptions) {}

  /** Load persisted records and connect every enabled agent (background). */
  loadAll(): void {
    const records = this.opts.store.list()
    this.seedRecords = records
    for (const record of records) {
      if (record.enabled) void this.connectRecord(record).catch((err: unknown) => {
        this.opts.onError?.(`[a2a] failed to connect "${record.name}": ${(err as Error).message}`)
      })
    }
  }

  /**
   * Seed configured agents that the persisted store does not know yet. The
   * store is the runtime state: an existing record (enabled or disabled,
   * present or removed) keeps its state — a disabled agent stays
   * disconnected and a removed one is not resurrected. Only specs with a name
   * absent from the store (and not already live this boot) connect and
   * persist.
   * @param specs - declared agents from the profile config.
   */
  async seed(specs: readonly OutboundAgentSpec[]): Promise<void> {
    const known = new Set(this.opts.store.list().map((r) => r.name))
    for (const connection of this.live.values()) known.add(connection.record.name)
    for (const spec of specs) {
      if (known.has(spec.name)) continue
      const result = await this.add(spec)
      if (result.ok) known.add(spec.name)
      else this.opts.onError?.(`[a2a] seed agent "${spec.name}": ${result.message}`)
    }
  }

  list(): OutboundAgentView[] {
    return [...this.views.values()]
  }

  /** Add and connect an agent, persisting the record on success. */
  async add(spec: OutboundAgentSpec): Promise<{ ok: boolean; message: string }> {
    const record: OutboundAgentRecord = {
      id: `agent-${crypto.randomUUID()}`,
      name: spec.name,
      agentCardUrl: spec.agentCardUrl,
      ...(spec.bearerTokenEnv ? { bearerTokenEnv: spec.bearerTokenEnv } : {}),
      enabled: spec.enabled ?? true,
      timeoutMs: spec.timeoutMs ?? this.opts.defaultTimeoutMs ?? 60_000,
      lastCardAt: null,
    }
    try {
      await this.connectRecord(record)
    } catch (err) {
      this.views.set(record.id, {
        id: record.id,
        name: record.name,
        agentCardUrl: record.agentCardUrl,
        enabled: record.enabled,
        state: 'failed',
        skillCount: 0,
        toolCount: 0,
        lastError: (err as Error).message,
      })
      return { ok: false, message: `failed to connect to ${record.agentCardUrl}: ${(err as Error).message}` }
    }
    this.persist(record)
    return { ok: true, message: `agent "${record.name}" connected` }
  }

  async remove(id: string): Promise<{ ok: boolean; message: string }> {
    const live = this.live.get(id)
    const view = this.views.get(id)
    if (live === undefined && view === undefined) return { ok: false, message: `agent ${id} not found` }
    for (const disposer of live?.disposers ?? []) disposer.dispose()
    this.live.delete(id)
    this.views.delete(id)
    await this.persistAll()
    return { ok: true, message: `agent ${id} removed` }
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; message: string }> {
    const live = this.live.get(id)
    const view = this.views.get(id)
    if (live === undefined && view === undefined) return { ok: false, message: `agent ${id} not found` }
    if (enabled && live === undefined) {
      const record = this.findRecord(id)
      if (record === undefined) return { ok: false, message: `agent ${id} has no persisted record` }
      try {
        await this.connectRecord(record)
      } catch (err) {
        return { ok: false, message: `failed to connect: ${(err as Error).message}` }
      }
      await this.persistAll()
      return { ok: true, message: `agent ${id} enabled` }
    }
    if (!enabled && live !== undefined) {
      for (const disposer of live.disposers) disposer.dispose()
      this.live.delete(id)
      const current = this.views.get(id)
      if (current !== undefined) {
        this.views.set(id, { ...current, enabled: false, state: 'disconnected', toolCount: 0, skillCount: 0 })
      }
      await this.persistAll()
      return { ok: true, message: `agent ${id} disabled` }
    }
    return { ok: true, message: `agent ${id} already ${enabled ? 'enabled' : 'disabled'}` }
  }

  async refresh(id: string): Promise<{ ok: boolean; message: string }> {
    const record = this.findRecord(id) ?? this.live.get(id)?.record
    if (record === undefined) return { ok: false, message: `agent ${id} not found` }
    const live = this.live.get(id)
    for (const disposer of live?.disposers ?? []) disposer.dispose()
    this.live.delete(id)
    try {
      await this.connectRecord(record)
    } catch (err) {
      return { ok: false, message: `refresh failed: ${(err as Error).message}` }
    }
    await this.persistAll()
    return { ok: true, message: `agent "${record.name}" reconnected` }
  }

  async disposeAll(): Promise<void> {
    for (const connection of this.live.values()) {
      for (const disposer of connection.disposers) disposer.dispose()
    }
    this.live.clear()
    this.views.clear()
  }

  private async connectRecord(record: OutboundAgentRecord): Promise<void> {
    const token = this.opts.tokenOf(record.bearerTokenEnv)
    const client = await A2AClient.connect(record.agentCardUrl, {
      ...(token ? { bearerToken: token } : {}),
      timeoutMs: record.timeoutMs,
    })
    const contextByAgent = new Map<string, string>()
    const fallback = `a2a-out-${crypto.randomUUID()}`
    const contextFor = (agentId: string | undefined): string => {
      const key = agentId ?? '\0fallback'
      const existing = contextByAgent.get(key)
      if (existing !== undefined) return existing
      const id = agentId ? `a2a-out-${crypto.randomUUID()}` : fallback
      contextByAgent.set(key, id)
      return id
    }
    const disposers = registerAgentTools(this.opts.registrar, {
      agentName: record.name,
      client,
      ...(this.opts.toolPrefix !== undefined ? { toolPrefix: this.opts.toolPrefix } : {}),
      contextFor,
    })
    const skillCount = client.card.skills?.length ?? 0
    this.live.set(record.id, { record, client, disposers, skillCount })
    this.views.set(record.id, {
      id: record.id,
      name: record.name,
      agentCardUrl: record.agentCardUrl,
      enabled: record.enabled,
      state: 'connected',
      skillCount,
      toolCount: disposers.length,
    })
  }

  private findRecord(id: string): OutboundAgentRecord | undefined {
    const current = () => this.opts.store.list().find((r) => r.id === id)
    return current() ?? this.seedRecords?.find((r) => r.id === id)
  }

  private persist(record: OutboundAgentRecord): void {
    const next = [...this.opts.store.list().filter((r) => r.id !== record.id), record]
    void this.opts.store.save(next).catch((err: unknown) => {
      this.opts.onError?.(`[a2a] failed to persist agent list: ${String(err)}`)
    })
  }

  private async persistAll(): Promise<void> {
    const liveRecords = [...this.live.values()].map((c) => c.record)
    const liveIds = new Set(liveRecords.map((r) => r.id))
    // Non-live known records (disabled agents) keep the store record with the
    // view's up-to-date enabled flag; removed agents (gone from live AND
    // views) are dropped so a restart does not resurrect them.
    const kept = this.opts.store.list()
      .filter((r) => !liveIds.has(r.id) && this.views.has(r.id))
      .map((r) => {
        const view = this.views.get(r.id)
        return view === undefined ? r : { ...r, enabled: view.enabled }
      })
    await this.opts.store.save([...kept, ...liveRecords])
  }
}