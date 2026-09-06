/**
 * The inbound A2A server: JSON-RPC dispatch, the task lifecycle, and SSE
 * streaming. Transport-agnostic — `handle` / `handleStream` take a structural
 * request and return bytes; the HTTP binding lives in routes.ts.
 * @module dsh-a2a/server/a2a-server
 */

import {
  A2A_ERROR_CODES,
  A2A_METHODS,
  Role,
  TaskState,
  isTerminal,
  partsToText,
  type AgentCard,
  type JsonRpcRequest,
  type Message,
  type Part,
  type StreamResponse,
  type Task,
} from '../protocol.ts'
import { methodNotFound, parseRpc, rpcError, rpcSuccess } from '../jsonrpc.ts'
import type { TaskStore, TaskRecord } from './store.ts'
import type { ExecutorSet } from './executor.ts'

/** What the policy gate sees for one inbound task. */
export interface GateInput {
  readonly contextId: string
  readonly skill: string
  readonly parts: readonly Part[]
  readonly remotePeerId: string | null
}

export type GateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Observational facts about one inbound JSON-RPC request. */
export interface InboundFacts {
  readonly method: string
  readonly source?: string
  readonly taskIds: readonly string[]
  readonly streaming: boolean
}

export interface A2AServerOptions {
  readonly card: AgentCard
  readonly store: TaskStore
  readonly executors: ExecutorSet
  /** Present when inbound bearer auth is configured. */
  readonly authToken?: string
  /** Policy gate: skill allow-list + the `a2a/inbound-task` waterfall. */
  readonly gate: (input: GateInput) => Promise<GateResult>
  readonly onInbound?: (facts: InboundFacts) => void
  readonly onTaskSettled?: (taskId: string) => void
}

/** Structural request the server handles (HTTP adapter fills it). */
export interface ServerRequest {
  readonly method?: string
  readonly url?: string
  readonly headers?: Record<string, string>
  readonly socket?: { readonly remoteAddress?: string; readonly remotePort?: number }
}

export interface ServerResponseSpec {
  readonly status: number
  readonly contentType: string
  readonly body: string
  readonly headers?: Record<string, string>
}

/** A2A JSON-RPC / SSE server over a structural request. */
export class A2AServer {
  card: AgentCard
  private readonly listeners = new Set<(frame: StreamResponse) => void>()
  private readonly waiters = new Map<string, () => void>()
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly opts: A2AServerOptions) {
    this.card = opts.card
  }

  /** Swap the served AgentCard (runtime identity edits). Routes re-read `server.card` on every request. */
  setCard(next: AgentCard): void {
    this.card = next
  }

  /**
   * Abort a running task by control path (facade /a2a task cancel): abort the
   * executor's signal, settle the task CANCELED, and wake stream waiters.
   * @returns false when the task is unknown or already terminal.
   */
  abort(taskId: string): boolean {
    const record = this.opts.store.get(taskId)
    if (record === undefined || isTerminal(record.state)) return false
    this.running.get(taskId)?.abort()
    this.opts.store.setState(taskId, TaskState.CANCELED, { code: 'canceled', text: 'Task canceled' })
    this.settle(taskId)
    return true
  }

  /** True when the request carries the configured bearer token. */
  authorized(req: ServerRequest): boolean {
    const token = this.opts.authToken
    if (!token) return true
    const header = req.headers?.['authorization'] ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match !== null && match[1] === token
  }

  /** Route one inbound HTTP request (GET card, POST JSON-RPC). */
  async handle(req: ServerRequest, body: string): Promise<ServerResponseSpec> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path === '/.well-known/agent-card.json') {
      return { status: 200, contentType: 'application/json', body: JSON.stringify(this.card) }
    }
    if (req.method !== 'POST' || path !== endpointOf(this.card)) {
      return { status: 404, contentType: 'text/plain', body: 'Not Found' }
    }
    if (!this.authorized(req)) {
      return {
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify(rpcError(null, -32040, 'Unauthorized')),
        headers: { 'WWW-Authenticate': 'Bearer' },
      }
    }
    const rpc = parseRpc(body)
    if (rpc === undefined) {
      return { status: 200, contentType: 'application/json', body: JSON.stringify(rpcError(null, A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid JSON-RPC request')) }
    }
    try {
      const result = await this.dispatch(rpc)
      const source = sourceOf(req)
      this.opts.onInbound?.({
        method: rpc.method,
        ...(source !== undefined ? { source } : {}),
        taskIds: extractTaskIds(result),
        streaming: false,
      })
      return { status: 200, contentType: 'application/json', body: JSON.stringify(rpcSuccess(rpc.id, result)) }
    } catch (err) {
      const e = err as { code?: number; message?: string; data?: unknown }
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rpcError(rpc.id, typeof e.code === 'number' ? e.code : A2A_ERROR_CODES.INTERNAL_ERROR, e.message ?? String(err), e.data)),
      }
    }
  }

  /**
   * Route one SSE request (SendStreamingMessage / SubscribeToTask). Frames are
   * pushed to `onEvent` as they happen; the caller must have checked
   * `authorized()` before writing 200 headers.
   */
  async handleStream(req: ServerRequest, body: string, onEvent: (frame: string) => void): Promise<{ readonly status: number; readonly headers?: Record<string, string> }> {
    if (req.method !== 'POST') {
      onEvent(`event: error\ndata: ${JSON.stringify({ code: 404, message: 'Not Found' })}\n\n`)
      return { status: 200 }
    }
    if (!this.authorized(req)) {
      return { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    }
    const rpc = parseRpc(body)
    if (rpc === undefined) {
      onEvent(`event: error\ndata: ${JSON.stringify({ code: A2A_ERROR_CODES.INVALID_REQUEST, message: 'Invalid JSON-RPC request' })}\n\n`)
      return { status: 200 }
    }
    if (rpc.method !== A2A_METHODS.sendStreamingMessage && rpc.method !== A2A_METHODS.subscribeToTask) {
      onEvent(`event: error\ndata: ${JSON.stringify(methodNotFound(rpc.method ?? ''))}\n\n`)
      return { status: 200 }
    }

    const params = (rpc.params ?? {}) as { message?: Message; id?: string }
    let record: TaskRecord | undefined
    if (rpc.method === A2A_METHODS.sendStreamingMessage) {
      if (params.message === undefined) {
        onEvent(`event: error\ndata: ${JSON.stringify({ code: A2A_ERROR_CODES.INVALID_PARAMS, message: 'Missing message' })}\n\n`)
        return { status: 200 }
      }
      const gateOutcome = await this.opts.gate(gateInputFrom(params.message, this.remotePeerOf(req)))
      if (!gateOutcome.ok) {
        onEvent(`event: error\ndata: ${JSON.stringify({ code: -32000, message: gateOutcome.reason })}\n\n`)
        return { status: 200 }
      }
      record = this.ensureTask(params.message, this.remotePeerOf(req))
      this.noteInbound(req, rpc.method, [record.taskId], true)
      // Kick off execution; frames flow through the shared listener set.
      void this.runTask(record)
    } else {
      const id = params.id
      if (id === undefined) {
        onEvent(`event: error\ndata: ${JSON.stringify({ code: A2A_ERROR_CODES.INVALID_PARAMS, message: 'Missing task id' })}\n\n`)
        return { status: 200 }
      }
      record = this.opts.store.get(id)
      this.noteInbound(req, rpc.method, id ? [id] : [], true)
      if (record === undefined) {
        onEvent(`event: error\ndata: ${JSON.stringify({ code: A2A_ERROR_CODES.TASK_NOT_FOUND, message: `Task ${id} not found` })}\n\n`)
        return { status: 200 }
      }
    }

    const sub = (frame: StreamResponse): void => onEvent(`data: ${JSON.stringify(frame)}\n\n`)
    this.listeners.add(sub)
    try {
      // Catch the subscriber up: the initial WORKING frame may have been
      // emitted before this subscription landed, so always deliver the
      // current status first (a settled task streams its terminal state).
      const current = this.opts.store.get(record.taskId)
      if (current !== undefined) {
        sub({ statusUpdate: { taskId: record.taskId, contextId: record.contextId, status: statusOf(current) } })
      }
      await this.waitTerminal(record.taskId)
      const finalRecord = this.opts.store.get(record.taskId)
      if (finalRecord !== undefined) onEvent(`data: ${JSON.stringify({ task: toTask(finalRecord) })}\n\n`)
    } finally {
      this.listeners.delete(sub)
    }
    return { status: 200 }
  }

  /** Dispatch one JSON-RPC request; throws {code, message} on errors. */
  private async dispatch(rpc: JsonRpcRequest): Promise<unknown> {
    const method = rpc.method
    const params = (rpc.params ?? {}) as Record<string, unknown>
    switch (method) {
      case A2A_METHODS.sendMessage: {
        const message = params['message'] as Message | undefined
        if (message === undefined) throw rpcFault(A2A_ERROR_CODES.INVALID_PARAMS, 'Missing message')
        const gateOutcome = await this.opts.gate(gateInputFrom(message, null))
        if (!gateOutcome.ok) throw rpcFault(A2A_ERROR_CODES.INVALID_PARAMS, gateOutcome.reason)
        const record = this.ensureTask(message, null)
        // handle() records this inbound after dispatch with the real source.
        await this.runTask(record)
        const settled = this.opts.store.get(record.taskId)
        return toTask(settled ?? record)
      }
      case A2A_METHODS.getTask: {
        const id = params['id'] as string | undefined
        if (id === undefined) throw rpcFault(A2A_ERROR_CODES.INVALID_PARAMS, 'Missing task id')
        const record = this.opts.store.get(id)
        if (record === undefined) throw rpcFault(A2A_ERROR_CODES.TASK_NOT_FOUND, `Task ${id} not found`)
        return toTask(record)
      }
      case A2A_METHODS.listTasks: {
        return this.opts.store.list().map(toTask)
      }
      case A2A_METHODS.cancelTask: {
        const id = params['id'] as string | undefined
        if (id === undefined) throw rpcFault(A2A_ERROR_CODES.INVALID_PARAMS, 'Missing task id')
        const record = this.opts.store.get(id)
        if (record === undefined) throw rpcFault(A2A_ERROR_CODES.TASK_NOT_FOUND, `Task ${id} not found`)
        if (isTerminal(record.state)) throw rpcFault(A2A_ERROR_CODES.TASK_CANCEL_NOT_ALLOWED, `Task ${id} already in terminal state ${record.state}`)
        const controller = this.running.get(id)
        controller?.abort()
        this.opts.store.setState(id, TaskState.CANCELED, { code: 'canceled', text: 'Task canceled by caller' })
        this.settle(id)
        return toTask(this.opts.store.get(id)!)
      }
      case A2A_METHODS.getExtendedAgentCard:
        return this.card
      default:
        throw rpcFault(A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method ${method}`)
    }
  }

  /** Create (or continue) the task record for one message. */
  private ensureTask(message: Message, remotePeerId: string | null): TaskRecord {
    if (message.taskId !== undefined) {
      const existing = this.opts.store.get(message.taskId)
      if (existing !== undefined) {
        const created = this.opts.store.create({
          contextId: existing.contextId,
          skill: existing.skill,
          parts: message.parts,
          remotePeerId,
        })
        return created
      }
    }
    const contextId = message.contextId ?? crypto.randomUUID()
    const skill = (message.metadata?.['skill'] as string | undefined) ?? 'chat'
    return this.opts.store.create({ contextId, skill, parts: message.parts, remotePeerId })
  }

  /** Run one task to a terminal state, emitting status/artifact frames. */
  private async runTask(record: TaskRecord): Promise<void> {
    const controller = new AbortController()
    this.running.set(record.taskId, controller)
    this.opts.store.setState(record.taskId, TaskState.WORKING)
    this.emit({ statusUpdate: { taskId: record.taskId, contextId: record.contextId, status: statusOf(this.opts.store.get(record.taskId)!) } })
    const onEvent = this.eventSink(record.taskId, record.contextId)
    try {
      const executor = this.opts.executors.resolve(record.skill)
      const output = await executor.execute(
        {
          taskId: record.taskId,
          contextId: record.contextId,
          skill: record.skill,
          prompt: partsToText(record.parts),
          signal: controller.signal,
        },
        { onEvent },
      )
      const settled = this.opts.store.get(record.taskId)
      if (settled !== undefined && settled.state === TaskState.CANCELED) {
        // Cancel won: keep CANCELED, do not clobber with a completion.
      } else {
        this.opts.store.appendArtifact(record.taskId, { artifactId: 'result', parts: output.parts, lastChunk: true })
        this.opts.store.setState(record.taskId, TaskState.COMPLETED)
      }
    } catch (err) {
      const settled = this.opts.store.get(record.taskId)
      if (settled !== undefined && settled.state === TaskState.CANCELED) {
        // Idempotent cancel already settled the task.
      } else {
        this.opts.store.setState(record.taskId, TaskState.FAILED, { code: 'executor', text: (err as Error).message })
      }
    } finally {
      this.running.delete(record.taskId)
      const terminal = this.opts.store.get(record.taskId)
      if (terminal !== undefined) this.emit({ task: toTask(terminal) })
      this.settle(record.taskId)
      this.opts.onTaskSettled?.(record.taskId)
    }
  }

  /** Build the event sink that folds executor events into store + frames. */
  private eventSink(taskId: string, contextId: string): (ev: { readonly type: 'status' | 'artifact'; readonly state?: TaskState; readonly message?: string; readonly artifactId?: string; readonly parts?: readonly Part[]; readonly name?: string; readonly lastChunk?: boolean }) => void {
    return (ev) => {
      if (ev.type === 'status') {
        this.opts.store.setState(taskId, ev.state ?? TaskState.WORKING)
        this.emit({ statusUpdate: { taskId, contextId, status: statusOf(this.opts.store.get(taskId)!) } })
      } else if (ev.type === 'artifact' && ev.artifactId !== undefined && ev.parts !== undefined) {
        const record = this.opts.store.appendArtifact(taskId, {
          artifactId: ev.artifactId,
          ...(ev.name !== undefined ? { name: ev.name } : {}),
          parts: ev.parts,
          ...(ev.lastChunk !== undefined ? { lastChunk: ev.lastChunk } : {}),
        })
        const artifact = record.artifacts.find((a) => a.artifactId === ev.artifactId)
        if (artifact !== undefined) {
          this.emit({
            artifactUpdate: {
              taskId,
              contextId,
              artifact: {
                artifactId: artifact.artifactId,
                ...(artifact.name !== undefined ? { name: artifact.name } : {}),
                parts: artifact.parts,
              },
              ...(ev.lastChunk !== undefined ? { lastChunk: ev.lastChunk } : {}),
            },
          })
        }
      }
    }
  }

  private emit(frame: StreamResponse): void {
    for (const listener of [...this.listeners]) listener(frame)
  }

  private noteInbound(req: ServerRequest | { method: string }, method: string, taskIds: readonly string[], streaming: boolean): void {
    const source = sourceOf(req as ServerRequest)
    this.opts.onInbound?.({
      method,
      ...(source !== undefined ? { source } : {}),
      taskIds,
      streaming,
    })
  }

  private remotePeerOf(req: ServerRequest): string | null {
    const source = sourceOf(req)
    return source ? hashOf(source) : null
  }

  private async waitTerminal(taskId: string): Promise<void> {
    const current = this.opts.store.get(taskId)
    if (current !== undefined && isTerminal(current.state)) return
    await new Promise<void>((resolve) => {
      this.waiters.set(taskId, resolve)
    })
  }

  private settle(taskId: string): void {
    const waiter = this.waiters.get(taskId)
    if (waiter !== undefined) {
      this.waiters.delete(taskId)
      waiter()
    }
  }
}

/** Read the JSON-RPC endpoint path off the card's first interface. */
function endpointOf(card: AgentCard): string {
  const url = card.supportedInterfaces?.[0]?.url
  if (!url) return '/a2a'
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function sourceOf(req: ServerRequest): string | undefined {
  const s = req.socket
  if (!s?.remoteAddress) return undefined
  return `${s.remoteAddress}:${s.remotePort ?? ''}`
}

function hashOf(value: string): string {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0
  return `peer-${h.toString(16)}`
}

function gateInputFrom(message: Message, remotePeerId: string | null): GateInput {
  return {
    contextId: message.contextId ?? 'new',
    skill: (message.metadata?.['skill'] as string | undefined) ?? 'chat',
    parts: message.parts,
    remotePeerId,
  }
}

function rpcFault(code: number, message: string): { code: number; message: string; data?: unknown } {
  return { code, message }
}

function statusOf(record: TaskRecord): Task['status'] {
  return {
    state: record.state,
    timestamp: record.updatedAt,
    ...(record.error ? { message: { messageId: `a2a-status-${record.taskId}`, role: Role.AGENT, parts: [{ text: record.error.message }] } } : {}),
  }
}

function toTask(record: TaskRecord): Task {
  return {
    id: record.taskId,
    contextId: record.contextId,
    status: statusOf(record),
    artifacts: record.artifacts,
    metadata: { skill: record.skill },
  }
}

function extractTaskIds(result: unknown): readonly string[] {
  if (result === null || typeof result !== 'object') return []
  const value = result as { id?: string; task?: { id?: string } }
  if (typeof value.id === 'string') return [value.id]
  if (typeof value.task?.id === 'string') return [value.task.id]
  if (Array.isArray(result)) {
    return (result as Array<{ id?: string }>).map((t) => t.id).filter((id): id is string => typeof id === 'string')
  }
  return []
}