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
}