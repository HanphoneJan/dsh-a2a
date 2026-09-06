/**
 * The `ctx.a2a` service facade: the thin read/control surface commands, the
 * GUI API, and other plugins use. Registered as a Cordis Service so the key
 * disappears with the plugin fiber.
 * @module dsh-a2a/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** A result with a user-facing message. */
export interface OpResult {
  readonly ok: boolean
  readonly message: string
}

/** Agent-preset roster row shown in the instance pickers. */
export interface PresetView {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Whether this preset is the deployment default when none is named. */
  readonly isDefault?: boolean
}

/** A skill declaration as the GUI reads it. */
export interface SkillView {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One inbound server instance, as the GUI/facade reads it. */
export interface InboundServerView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly endpointPath: string
  readonly preset?: string
  readonly authTokenEnv?: string
  readonly cardPath: string
  readonly cardUrl?: string
  readonly enabled: boolean
  readonly skills: readonly SkillView[]
}

/** One outbound server instance, as the GUI/facade reads it. */
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

/** Creator input for an inbound server instance. */
export interface InboundCreateInput {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly endpointPath?: string
  /** Preset id; absent = the deployment default. Skills derive from it. */
  readonly preset?: string
  readonly authTokenEnv?: string
  readonly enabled?: boolean
}

/** Creator input for an outbound server instance. */
export interface OutboundCreateInput {
  readonly id?: string
  readonly name: string
  readonly agentCardUrl: string
  readonly bearerTokenEnv?: string
  readonly preset?: string
  readonly enabled?: boolean
  readonly timeoutMs?: number
}

/** The implementation the facade delegates to (owned by the plugin assembly). */
export interface A2AServiceImpl {
  status(): unknown
  /** Agent-preset roster for the GUI pickers. */
  presets(): Promise<PresetView[]>
  // ── inbound server instances ────────────────────────────────────────
  listInboundServers(): InboundServerView[]
  createInboundServer(input: InboundCreateInput): Promise<OpResult>
  removeInboundServer(id: string): Promise<OpResult>
  setInboundServerEnabled(id: string, enabled: boolean): Promise<OpResult>
  updateInboundServer(id: string, patch: { name?: string; description?: string; version?: string; endpointPath?: string; preset?: string; authTokenEnv?: string }): Promise<OpResult>
  // ── outbound server instances ───────────────────────────────────────
  listOutboundServers(): OutboundServerView[]
  createOutboundServer(input: OutboundCreateInput): Promise<OpResult>
  removeOutboundServer(id: string): Promise<OpResult>
  setOutboundServerEnabled(id: string, enabled: boolean): Promise<OpResult>
  refreshOutboundServer(id: string): Promise<OpResult>
  // ── tasks ───────────────────────────────────────────────────────────
  getTask(taskId: string): unknown
  listTasks(): unknown
  cancelTask(taskId: string): Promise<OpResult>
  // ── inbound peer monitoring (per instance) ──────────────────────────
  inbounds(): unknown
  closeInbound(peerId: string): Promise<OpResult>
}

/** The service other plugins read as `ctx.a2a`. */
export class A2AService extends Service {
  constructor(
    ctx: Context,
    private readonly impl: A2AServiceImpl,
  ) {
    super(ctx, 'a2a')
  }

  status(): unknown {
    return this.impl.status()
  }

  async presets(): Promise<PresetView[]> {
    return this.impl.presets()
  }

  listInboundServers(): InboundServerView[] {
    return this.impl.listInboundServers()
  }

  async createInboundServer(input: InboundCreateInput): Promise<OpResult> {
    return this.impl.createInboundServer(input)
  }

  async removeInboundServer(id: string): Promise<OpResult> {
    return this.impl.removeInboundServer(id)
  }

  async setInboundServerEnabled(id: string, enabled: boolean): Promise<OpResult> {
    return this.impl.setInboundServerEnabled(id, enabled)
  }

  async updateInboundServer(id: string, patch: { name?: string; description?: string; version?: string; endpointPath?: string; preset?: string; authTokenEnv?: string }): Promise<OpResult> {
    return this.impl.updateInboundServer(id, patch)
  }

  listOutboundServers(): OutboundServerView[] {
    return this.impl.listOutboundServers()
  }

  async createOutboundServer(input: OutboundCreateInput): Promise<OpResult> {
    return this.impl.createOutboundServer(input)
  }

  async removeOutboundServer(id: string): Promise<OpResult> {
    return this.impl.removeOutboundServer(id)
  }

  async setOutboundServerEnabled(id: string, enabled: boolean): Promise<OpResult> {
    return this.impl.setOutboundServerEnabled(id, enabled)
  }

  async refreshOutboundServer(id: string): Promise<OpResult> {
    return this.impl.refreshOutboundServer(id)
  }

  getTask(taskId: string): unknown {
    return this.impl.getTask(taskId)
  }

  listTasks(): unknown {
    return this.impl.listTasks()
  }

  async cancelTask(taskId: string): Promise<OpResult> {
    return this.impl.cancelTask(taskId)
  }

  inbounds(): unknown {
    return this.impl.inbounds()
  }

  async closeInbound(peerId: string): Promise<OpResult> {
    return this.impl.closeInbound(peerId)
  }
}
