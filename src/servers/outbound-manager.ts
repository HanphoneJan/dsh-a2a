/**
 * Outbound server manager: owns every outbound A2A connection instance. Each
 * instance is one connected remote — its own AgentCard URL, auth env, timeout,
 * creator-declared name, and an optional agent-preset binding. Each live
 * instance is one `OutboundAgentRegistry` with an isolated per-instance agent
 * store; enabled instances map their remote skills to `a2a__<name>__<skill>`
 * model tools. The manager owns the full lifecycle (add/enable/disable/remove/
 * refresh) driven from the GUI and facade, persists each instance in the
 * `outbound_servers` domain table, and disposes every connection on teardown.
 *
 * The `preset` field names the agent preset this DSH would compose its local
 * hand-off session with when driving that remote. P0 connects skills to tools
 * and manages the connection; the hand-off session composition behind `preset`
 * is a documented extension point (the outbound tools currently call the
 * remote directly) and the value is persisted metadata surfaced to the GUI.
 * @module dsh-a2a/servers/outbound-manager
 */

import { OutboundAgentRegistry, type AgentStore } from '../outbound/registry.ts'
import type { OutboundAgentRecord, OutboundServerRecord } from '../server/store.ts'

/** Tool-registrar slice (structural `ctx.tools.register`). */
export interface ToolRegistrar {
  register(def: unknown): (() => void) | void
}

/** Host slices one manager needs. */
export interface OutboundManagerHost {
  readonly registrar: ToolRegistrar
  readonly tokenOf: (env: string | undefined) => string | undefined
  readonly onError: (message: string) => void
  readonly defaultTimeoutMs: number
}

export interface OpResult {
  readonly ok: boolean
  readonly message: string
}

/** One outbound instance as the GUI/facade reads it. */
export interface OutboundServerView {
  readonly id: string
  readonly name: string
  readonly agentCardUrl: string
  readonly preset?: string
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly state: 'connected' | 'disconnected' | 'failed'
  readonly skillCount: number
  readonly toolCount: number
  readonly lastError?: string
}

/** An `AgentStore` bound to one outbound server instance's agents-table key. */
export class ServerAgentStore implements AgentStore {
  constructor(
    private readonly table: {
      get(key: string): string | undefined
      put(key: string, value: string): Promise<void>
    },
    private readonly key: string,
  ) {}

  list(): OutboundAgentRecord[] {
    const raw = this.table.get(this.key)
    if (raw === undefined || raw === '') return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as OutboundAgentRecord[]) : []
    } catch {
      return []
    }
  }

  async save(records: readonly OutboundAgentRecord[]): Promise<void> {
    await this.table.put(this.key, JSON.stringify(records))
  }
}

/** Persisted-instance store over the outbound_servers table. */
export class DomainOutboundStore {
  private static KEY(id: string): string {
    return `out:${id}`
  }

  constructor(private readonly table: {
    get(key: string): string | undefined
    put(key: string, value: string): Promise<void>
    entries?(): IterableIterator<[string, string]>
  }) {}

  list(): OutboundServerRecord[] {
    const out: OutboundServerRecord[] = []
    const entries = this.table.entries
    if (entries === undefined) return out
    for (const [key, raw] of entries()) {
      if (!key.startsWith('out:')) continue
      const parsed = safeParse(raw)
      if (parsed !== undefined) out.push(parsed)
    }
    return out
  }

  get(id: string): OutboundServerRecord | undefined {
    const raw = this.table.get(DomainOutboundStore.KEY(id))
    return raw === undefined ? undefined : safeParse(raw)
  }

  async save(record: OutboundServerRecord): Promise<void> {
    await this.table.put(DomainOutboundStore.KEY(record.id), JSON.stringify(record))
  }

  async remove(id: string): Promise<void> {
    await this.table.put(DomainOutboundStore.KEY(id), '')
  }
}

function safeParse(raw: string): OutboundServerRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as OutboundServerRecord
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || typeof parsed.agentCardUrl !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Creator input for a new outbound instance (id optional; manager allocates). */
export interface OutboundCreateInput {
  readonly id?: string
  readonly name: string
  readonly agentCardUrl: string
  readonly bearerTokenEnv?: string
  readonly preset?: string
  readonly enabled?: boolean
  readonly timeoutMs?: number
}

/** Manages the live set of outbound connection instances. */
export class OutboundServerManager {
  private readonly registries = new Map<string, OutboundAgentRegistry>()

  constructor(
    private readonly host: OutboundManagerHost,
    /** Persistence sink for each instance's agent records (the `agents` table). */
    private readonly agentSink: { get(key: string): string | undefined; put(key: string, value: string): Promise<void> },
    /** Persisted OutboundServerRecord store (the `outbound_servers` table). */
    private readonly records: DomainOutboundStore,
    /** Allocate a fresh stable instance id. */
    private readonly newId: () => string,
  ) {}

  /** The host default connection timeout (what a minimal record falls back to). */
  get defaultTimeoutMs(): number {
    return this.host.defaultTimeoutMs
  }

  private agentKeyFor(id: string): string {
    return `out:${id}`
  }

  private makeRegistry(record: OutboundServerRecord): OutboundAgentRegistry {
    return new OutboundAgentRegistry({
      registrar: { register: (def) => this.host.registrar.register(def) },
      store: new ServerAgentStore(this.agentSink, this.agentKeyFor(record.id)),
      toolPrefix: 'a2a',
      defaultTimeoutMs: this.host.defaultTimeoutMs,
      tokenOf: (env) => this.host.tokenOf(env),
      onError: this.host.onError,
    })
  }

  /** Record → registry spec for connecting one instance. */
  private toSpec(record: OutboundServerRecord): { name: string; agentCardUrl: string; bearerTokenEnv?: string; enabled?: boolean; timeoutMs?: number } {
    return {
      name: record.name,
      agentCardUrl: record.agentCardUrl,
      ...(record.bearerTokenEnv !== undefined ? { bearerTokenEnv: record.bearerTokenEnv } : {}),
      enabled: record.enabled,
      timeoutMs: record.timeoutMs ?? this.host.defaultTimeoutMs,
    }
  }

  /** Boot every persisted enabled instance as a connected registry. */
  boot(): void {
    for (const record of this.records.list()) {
      try {
        const registry = this.makeRegistry(record)
        this.registries.set(record.id, registry)
        if (record.enabled) registry.loadAll()
      } catch (err) {
        this.host.onError(`[a2a:out:${record.id}] failed to boot: ${String((err as Error).message)}`)
      }
    }
  }

  /** One view per live instance (enriched from its registry / record). */
  list(): readonly OutboundServerView[] {
    return [...this.registries.keys()].map((id) => this.viewFor(id)).filter((v): v is OutboundServerView => v !== undefined)
  }

  get(id: string): OutboundServerRegistryHandle | undefined {
    const registry = this.registries.get(id)
    return registry === undefined ? undefined : { id, registry }
  }

  private viewFor(id: string): OutboundServerView | undefined {
    const registry = this.registries.get(id)
    const record = this.records.get(id)
    if (registry === undefined || record === undefined) return undefined
    const agent = registry.list()[0]
    return {
      id,
      name: record.name,
      agentCardUrl: record.agentCardUrl,
      ...(record.preset !== undefined ? { preset: record.preset } : {}),
      enabled: agent?.enabled ?? record.enabled,
      timeoutMs: record.timeoutMs,
      state: agent?.state ?? 'disconnected',
      skillCount: agent?.skillCount ?? 0,
      toolCount: agent?.toolCount ?? 0,
      ...(agent?.lastError !== undefined ? { lastError: agent.lastError } : {}),
    }
  }

  /** Create, persist, and connect a new outbound instance. */
  async add(input: OutboundCreateInput): Promise<OpResult & { readonly id?: string }> {
    const record: OutboundServerRecord = {
      id: input.id ?? this.newId(),
      name: input.name,
      agentCardUrl: input.agentCardUrl,
      ...(input.bearerTokenEnv !== undefined ? { bearerTokenEnv: input.bearerTokenEnv } : {}),
      ...(input.preset !== undefined ? { preset: input.preset } : {}),
      enabled: input.enabled ?? true,
      timeoutMs: input.timeoutMs ?? this.host.defaultTimeoutMs,
    }
    if (this.registries.has(record.id)) return { ok: false, message: `outbound server ${record.id} already exists` }
    const registry = this.makeRegistry(record)
    await this.records.save(record)
    this.registries.set(record.id, registry)
    if (record.enabled) {
      const result = await registry.add(this.toSpec(record))
      return result.ok ? { ...result, id: record.id } : result
    }
    return { ok: true, message: `outbound server "${record.name}" added (disabled)`, id: record.id }
  }

  async setEnabled(id: string, enabled: boolean): Promise<OpResult> {
    const registry = this.registries.get(id)
    if (registry === undefined) return { ok: false, message: `outbound server ${id} not found` }
    const view = registry.list()[0]
    const record = this.records.get(id)
    if (record !== undefined) await this.records.save({ ...record, enabled })
    if (view === undefined) return { ok: true, message: `outbound server ${id} marked ${enabled ? 'enabled' : 'disabled'}` }
    return registry.setEnabled(view.id, enabled)
  }

  async remove(id: string): Promise<OpResult> {
    const registry = this.registries.get(id)
    if (registry === undefined) return { ok: false, message: `outbound server ${id} not found` }
    const view = registry.list()[0]
    if (view !== undefined) await registry.remove(view.id)
    await registry.disposeAll()
    this.registries.delete(id)
    await this.records.remove(id)
    return { ok: true, message: `outbound server ${id} removed` }
  }

  async refresh(id: string): Promise<OpResult> {
    const registry = this.registries.get(id)
    if (registry === undefined) return { ok: false, message: `outbound server ${id} not found` }
    const view = registry.list()[0]
    if (view === undefined) return { ok: false, message: `outbound server ${id} has no connected agent` }
    return registry.refresh(view.id)
  }

  async disposeAll(): Promise<void> {
    for (const registry of this.registries.values()) await registry.disposeAll()
    this.registries.clear()
  }
}

/** Handle to one live outbound connection (registry + derived view). */
export interface OutboundServerRegistryHandle {
  readonly id: string
  readonly registry: OutboundAgentRegistry
}
