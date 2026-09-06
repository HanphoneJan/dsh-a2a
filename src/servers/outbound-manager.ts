/**
 * Outbound server manager: owns every outbound A2A connection instance. Each
 * instance is one connected remote: its own AgentCard URL, auth env, timeout,
 * creator-declared name, and an optional agent-preset binding. Enabled
 * instances map their remote skills to `a2a__<name>__<skill>` model tools;
 * the manager supports add/enable/disable/remove/refresh from the GUI and
 * persists each instance in the `outbound_servers` domain table.
 *
 * The `preset` field names the agent preset this DSH would compose its local
 * hand-off session with when driving that remote. P0 connects skills to tools
 * and manages the connection; the hand-off session composition behind `preset`
 * is a documented extension point (the outbound tools currently call the
 * remote directly).
 * @module dsh-a2a/servers/outbound-manager
 */

import { OutboundAgentRegistry, type AgentStore, type OutboundAgentView } from '../outbound/registry.ts'
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

/** An `AgentStore` bound to one outbound server instance's table key. */
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

/** Manages the live set of outbound connection instances. */
export class OutboundServerManager {
  private readonly registries = new Map<string, OutboundAgentRegistry>()

  constructor(
    private readonly host: OutboundManagerHost,
    /** Table-backed store (persistence sink) for each instance's records. */
    private readonly sink: { get(key: string): string | undefined; put(key: string, value: string): Promise<void> },
  ) {}

  private keyFor(id: string): string {
    return `out:${id}`
  }

  private makeRegistry(record: OutboundServerRecord): OutboundAgentRegistry {
    return new OutboundAgentRegistry({
      registrar: { register: (def) => this.host.registrar.register(def) },
      store: new ServerAgentStore(this.sink, this.keyFor(record.id)),
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
  boot(records: readonly OutboundServerRecord[]): void {
    for (const record of records) {
      try {
        const registry = this.makeRegistry(record)
        this.registries.set(record.id, registry)
        if (record.enabled) registry.loadAll()
      } catch (err) {
        this.host.onError(`[a2a:out:${record.id}] failed to boot: ${String((err as Error).message)}`)
      }
    }
  }

  views(): readonly OutboundAgentView[] {
    return [...this.registries.values()].flatMap((r) => r.list())
  }

  get(id: string): OutboundAgentRegistry | undefined {
    return this.registries.get(id)
  }

  /** Add and connect a new outbound instance. */
  async add(record: OutboundServerRecord): Promise<{ readonly ok: boolean; readonly message: string }> {
    if (this.registries.has(record.id)) return { ok: false, message: `outbound server ${record.id} already exists` }
    const registry = this.makeRegistry(record)
    this.registries.set(record.id, registry)
    if (record.enabled) {
      const result = await registry.add(this.toSpec(record))
      return result
    }
    return { ok: true, message: `outbound server "${record.name}" added (disabled)` }
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ readonly ok: boolean; readonly message: string }> {
    const registry = this.registries.get(id)
    if (registry === undefined) return { ok: false, message: `outbound server ${id} not found` }
    const view = registry.list()[0]
    if (view === undefined) return { ok: false, message: `outbound server ${id} has no live/known agent` }
    return registry.setEnabled(view.id, enabled)
  }

  async remove(id: string): Promise<{ readonly ok: boolean; readonly message: string }> {
    const registry = this.registries.get(id)
    if (registry === undefined) return { ok: false, message: `outbound server ${id} not found` }
    const view = registry.list()[0]
    if (view !== undefined) await registry.remove(view.id)
    await registry.disposeAll()
    this.registries.delete(id)
    return { ok: true, message: `outbound server ${id} removed` }
  }

  async refresh(id: string): Promise<{ readonly ok: boolean; readonly message: string }> {
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