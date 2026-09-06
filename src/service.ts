/**
 * The `ctx.a2a` service facade: the thin read/control surface commands and
 * other plugins use. Registered as a Cordis Service so the key disappears
 * with the plugin fiber.
 * @module dsh-a2a/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** A result with a user-facing message. */
export interface OpResult {
  readonly ok: boolean
  readonly message: string
}

/** The implementation the facade delegates to (owned by the plugin assembly). */
export interface A2AServiceImpl {
  status(): unknown
  enableServer(enable: boolean): Promise<OpResult>
  getTask(taskId: string): unknown
  listTasks(): unknown
  cancelTask(taskId: string): Promise<OpResult>
  agents(): unknown
  addAgent(spec: { readonly name: string; readonly agentCardUrl: string; readonly bearerTokenEnv?: string }): Promise<OpResult>
  removeAgent(id: string): Promise<OpResult>
  setAgentEnabled(id: string, enabled: boolean): Promise<OpResult>
  refreshAgentCard(id: string): Promise<OpResult>
  /** Current service identity (persisted override + composition defaults). */
  identity(): unknown
  /** Persist and apply a new service identity onto the live AgentCard. */
  updateIdentity(patch: { readonly name?: string; readonly description?: string; readonly version?: string }): Promise<OpResult>
  /** Cancel an inbound peer's active tasks and drop its record. */
  closeInbound(peerId: string): Promise<OpResult>
  inbounds(): unknown
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

  async enableServer(enable: boolean): Promise<OpResult> {
    return this.impl.enableServer(enable)
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

  agents(): unknown {
    return this.impl.agents()
  }

  async addAgent(spec: { readonly name: string; readonly agentCardUrl: string; readonly bearerTokenEnv?: string }): Promise<OpResult> {
    return this.impl.addAgent(spec)
  }

  async removeAgent(id: string): Promise<OpResult> {
    return this.impl.removeAgent(id)
  }

  async setAgentEnabled(id: string, enabled: boolean): Promise<OpResult> {
    return this.impl.setAgentEnabled(id, enabled)
  }

  async refreshAgentCard(id: string): Promise<OpResult> {
    return this.impl.refreshAgentCard(id)
  }

  identity(): unknown {
    return this.impl.identity()
  }

  async updateIdentity(patch: { readonly name?: string; readonly description?: string; readonly version?: string }): Promise<OpResult> {
    return this.impl.updateIdentity(patch)
  }

  async closeInbound(peerId: string): Promise<OpResult> {
    return this.impl.closeInbound(peerId)
  }

  inbounds(): unknown {
    return this.impl.inbounds()
  }
}