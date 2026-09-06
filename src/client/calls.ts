/**
 * Outbound A2A client: AgentCard discovery plus the JSON-RPC methods the
 * tools layer needs. Sync-by-polling for P0 (each tool call waits for the
 * task to settle up to a timeout); passive result injection replaces this in
 * P1 without changing the transport.
 * @module dsh-a2a/client/calls
 */

import {
  A2A_ERROR_CODES,
  A2A_METHODS,
  isTerminal,
  type AgentCard,
  type JsonRpcResponse,
  type Message,
  type Task,
} from '../protocol.ts'

/** Error carrying the remote JSON-RPC error code. */
export class A2AError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'A2AError'
  }
}

export interface ClientOptions {
  readonly bearerToken?: string
  /** Per-call timeout in ms. Default 60000. */
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/** A connected remote A2A agent (one AgentCard endpoint). */
export class A2AClient {
  readonly card: AgentCard
  private readonly endpoint: string

  private constructor(
    card: AgentCard,
    endpoint: string,
    private readonly opts: ClientOptions,
  ) {
    this.card = card
    this.endpoint = endpoint
  }

  /** Fetch and validate an AgentCard, then connect to its JSON-RPC endpoint. */
  static async connect(agentCardUrl: string, opts: ClientOptions = {}): Promise<A2AClient> {
    const timeoutMs = opts.timeoutMs ?? 60_000
    const fetchImpl = opts.fetchImpl ?? fetch
    const response = await fetchImpl(agentCardUrl, {
      headers: {
        accept: 'application/json',
        ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new A2AError(A2A_ERROR_CODES.AGENT_CARD_NOT_FOUND, `agent card fetch failed: HTTP ${response.status}`)
    }
    const card = (await response.json()) as AgentCard
    if (typeof card.name !== 'string' || typeof card.description !== 'string') {
      throw new A2AError(A2A_ERROR_CODES.AGENT_CARD_SIGNATURE_INVALID, `invalid agent card at ${agentCardUrl}`)
    }
    const iface = card.supportedInterfaces?.find((i) => (i.protocolBinding ?? 'JSONRPC') === 'JSONRPC')
      ?? card.supportedInterfaces?.[0]
    const endpoint = iface?.url ?? card.url
    if (!endpoint) {
      throw new A2AError(A2A_ERROR_CODES.AGENT_CARD_NOT_FOUND, `agent card at ${agentCardUrl} advertises no JSON-RPC interface`)
    }
    return new A2AClient(card, endpoint, opts)
  }

  /** Send a message and wait (or poll) until the task settles. */
  async sendMessage(message: Message): Promise<Task> {
    const task = await this.call<Task>(A2A_METHODS.sendMessage, { message })
    if (isTerminal(task.status.state)) return task
    return this.pollTask(task.id)
  }

  async getTask(taskId: string): Promise<Task> {
    return this.call<Task>(A2A_METHODS.getTask, { id: taskId })
  }

  async listTasks(): Promise<Task[]> {
    return this.call<Task[]>(A2A_METHODS.listTasks, {})
  }

  async cancelTask(taskId: string): Promise<Task> {
    return this.call<Task>(A2A_METHODS.cancelTask, { id: taskId })
  }

  /** Poll a task until terminal or the overall timeout elapses. */
  private async pollTask(taskId: string): Promise<Task> {
    const budget = this.opts.timeoutMs ?? 60_000
    const deadline = Date.now() + budget
    for (;;) {
      const task = await this.getTask(taskId)
      if (isTerminal(task.status.state)) return task
      if (Date.now() >= deadline) {
        throw new A2AError(-32000, `task ${taskId} did not settle within ${budget}ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const timeoutMs = this.opts.timeoutMs ?? 60_000
    const fetchImpl = this.opts.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.opts.bearerToken ? { authorization: `Bearer ${this.opts.bearerToken}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new A2AError(-32000, `A2A call ${method} timed out after ${timeoutMs}ms`)
      }
      throw err
    }
    if (response.status === 401) {
      throw new A2AError(A2A_ERROR_CODES.UNAUTHORIZED, 'remote agent rejected credentials (401)')
    }
    if (!response.ok) {
      throw new A2AError(A2A_ERROR_CODES.INTERNAL_ERROR, `A2A call ${method} failed: HTTP ${response.status}`)
    }
    const payload = (await response.json()) as JsonRpcResponse
    if ('error' in payload) {
      const error = payload.error
      throw new A2AError(error.code, error.message)
    }
    return payload.result as T
  }
}