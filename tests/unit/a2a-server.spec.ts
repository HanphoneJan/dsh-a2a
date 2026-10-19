/**
 * Inbound A2A server unit tests: JSON-RPC dispatch, policy gate rejection,
 * bearer auth, task settling, cancel, and the SSE stream framing.
 * @module dsh-a2a/tests/unit/a2a-server.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { A2AServer, type A2AServerOptions, type GateInput, type GateResult } from '../../src/server/a2a-server.ts'
import type { ExecutorSet } from '../../src/server/executor.ts'
import type { A2aExecutor } from '../../src/server/executor.ts'
import { MemoryTaskStore } from '../../src/server/store.ts'
import { A2aMetrics } from '../../src/server/metrics.ts'
import { A2A_ERROR_CODES, A2A_METHODS, Role, TaskState, type AgentCard, type Part } from '../../src/protocol.ts'
import { A2AClient } from '../../src/outbound/calls.ts'

/** AgentCard with a stable JSON-RPC endpoint. */
const card: AgentCard = {
  name: 'test-agent',
  description: 'test',
  version: '0.1.0',
  supportedInterfaces: [{ url: 'http://127.0.0.1:3000/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  skills: [{ id: 'chat' }],
}

function executor(parts: readonly Part[] = [{ text: 'done' }]): A2aExecutor & { args: unknown } {
  const call = vi.fn(async () => ({ parts }))
  return {
    name: 'session',
    execute: call,
    get args() {
      return call.mock.calls[0]?.[0]
    },
  }
}

function fakeExecutorSet(exec: A2aExecutor): ExecutorSet {
  return { resolve: () => exec, disposeAll: async () => {} } as unknown as ExecutorSet
}

function makeServer(opts: Partial<A2AServerOptions> = {}): A2AServer {
  const store = opts.store ?? new MemoryTaskStore()
  const exec = executor()
  const gate = opts.gate ?? (async (): Promise<GateResult> => ({ ok: true }))
  return new A2AServer({
    card,
    store,
    executors: opts.executors ?? fakeExecutorSet(exec),
    gate,
    ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
    ...(opts.taskTimeoutMs !== undefined ? { taskTimeoutMs: opts.taskTimeoutMs } : {}),
    ...(opts.requestsPerMinute !== undefined ? { requestsPerMinute: opts.requestsPerMinute } : {}),
    ...(opts.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: opts.maxConcurrentTasks } : {}),
    ...(opts.metrics !== undefined ? { metrics: opts.metrics } : {}),
  })
}

const sendMessage = { jsonrpc: '2.0', id: 1, method: A2A_METHODS.sendMessage, params: { message: { messageId: 'm1', role: 'user', parts: [{ text: 'hello' }] } } }

describe('A2AServer.handle', () => {
  it('serves the AgentCard at the well-known path', async () => {
    const server = makeServer()
    const res = await server.handle({ method: 'GET', url: '/.well-known/agent-card.json' }, '')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).name).toBe('test-agent')
  })

  it('404s unknown GET paths', async () => {
    const server = makeServer()
    const res = await server.handle({ method: 'GET', url: '/nope' }, '')
    expect(res.status).toBe(404)
  })

  it('rejects anonymous requests when auth is configured', async () => {
    const server = makeServer({ authToken: 'secret' })
    const res = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    expect(res.status).toBe(401)
    expect(res.headers?.['WWW-Authenticate']).toBe('Bearer')
  })

  it('accepts requests carrying the configured bearer token', async () => {
    const server = makeServer({ authToken: 'secret' })
    const res = await server.handle({ method: 'POST', url: '/a2a', headers: { authorization: 'Bearer secret' } }, JSON.stringify(sendMessage))
    expect(res.status).toBe(200)
    const task = JSON.parse(res.body).result.task
    expect(task.id).toMatch(/^a2a-/)
    expect(task.status.state).toBe(TaskState.COMPLETED)
  })

  it('routes SendMessage through the policy gate and rejects vetoed skills', async () => {
    const server = makeServer({
      gate: async (input: GateInput): Promise<GateResult> =>
        input.skill === 'chat' ? { ok: true } : { ok: false, reason: `unknown skill "${input.skill}"` },
    })
    const res = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: A2A_METHODS.sendMessage,
      params: { message: { messageId: 'm2', role: 'user', parts: [{ text: 'hi' }], metadata: { skill: 'coding' } } },
    }))
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe(-32602) // INVALID_PARAMS
    expect(body.error.message).toMatch(/unknown skill/)
  })

  it('rejects malformed JSON with INVALID_REQUEST', async () => {
    const server = makeServer()
    const res = await server.handle({ method: 'POST', url: '/a2a' }, '{broken')
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe(-32600)
  })

  it('returns TASK_NOT_FOUND for an unknown task id', async () => {
    const server = makeServer()
    const res = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 2, method: A2A_METHODS.getTask, params: { id: 'a2a-nope' },
    }))
    expect(JSON.parse(res.body).error.code).toBe(-32001)
  })
})

describe('A2AServer task control', () => {
  it('aborts a running task and settles it CANCELED', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow: A2aExecutor = {
      name: 'session',
      execute: vi.fn(async (input) => {
        await gate
        expect(input.signal.aborted).toBe(true)
        return { parts: [] }
      }),
    }
    const store = new MemoryTaskStore()
    const server = makeServer({ store, executors: fakeExecutorSet(slow) })
    const pending = server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    // Wait (deterministically) until the inbound request has created the task.
    let record = store.list()[0]
    for (let i = 0; i < 200 && record === undefined; i++) {
      await new Promise((r) => setTimeout(r, 1))
      record = store.list()[0]
    }
    expect(record).toBeDefined()
    server.abort(record!.taskId)
    release()
    const res = await pending
    const body = JSON.parse(res.body)
    expect(body.result.task.status.state).toBe(TaskState.CANCELED)
  })

  it('cancelTask via JSON-RPC rejects terminal tasks', async () => {
    const server = makeServer()
    const done = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    const taskId = JSON.parse(done.body).result.task.id
    const again = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 3, method: A2A_METHODS.cancelTask, params: { id: taskId },
    }))
    expect(JSON.parse(again.body).error.code).toBe(-32002) // TASK_CANCEL_NOT_ALLOWED
  })
})

describe('A2AServer.handleStream', () => {
  it('streams status + artifact frames to a terminal task', async () => {
    let proceed!: () => void
    const started = new Promise<void>((r) => { proceed = r })
    const streaming: A2aExecutor = {
      name: 'session',
      execute: vi.fn(async (_input, { onEvent }) => {
        await started
        onEvent({ type: 'status', state: TaskState.WORKING, message: 'thinking' })
        onEvent({ type: 'artifact', artifactId: 'step', parts: [{ text: 'mid' }] })
        return { parts: [{ text: 'done' }] }
      }),
    }
    const server = makeServer({ executors: fakeExecutorSet(streaming) })
    const frames: string[] = []
    const done = server.handleStream(
      { method: 'POST', url: '/a2a' },
      JSON.stringify({
        jsonrpc: '2.0', id: 4, method: A2A_METHODS.sendStreamingMessage,
        params: { message: { messageId: 'm3', role: 'user', parts: [{ text: 'hi' }] } },
      }),
      (frame) => frames.push(frame),
    )
    // Let the handler reach the executor's await, then proceed with the run.
    await new Promise((r) => setTimeout(r, 5))
    proceed()
    const result = await done
    expect(result.status).toBe(200)
    const joined = frames.join('\n')
    expect(joined).toContain('statusUpdate')
    expect(joined).toContain('artifactUpdate')
    expect(joined).toContain('"task"')
  })

  it('rejects a second stream method with the error event', async () => {
    const server = makeServer()
    const frames: string[] = []
    await server.handleStream(
      { method: 'POST', url: '/a2a' },
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'Nope', params: {} }),
      (frame) => frames.push(frame),
    )
    expect(frames[0]).toContain('"error"')
    expect(frames[0]).toContain('-32601')
  })
})
describe('inbound isolation and lifecycle hardening', () => {
  it('scopes list/get/cancel to the instance that owns the task', async () => {
    const base = new MemoryTaskStore()
    const a = makeServer({ store: base, serverId: 'a' })
    const b = makeServer({ store: base, serverId: 'b' })
    const sent = await b.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    const taskId = JSON.parse(sent.body).result.task.id as string

    const listed = await a.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 10, method: A2A_METHODS.listTasks, params: {},
    }))
    expect(JSON.parse(listed.body).result.tasks).toEqual([])

    const got = await a.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 11, method: A2A_METHODS.getTask, params: { id: taskId },
    }))
    expect(JSON.parse(got.body).error.code).toBe(-32001)

    const canceled = await a.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 12, method: A2A_METHODS.cancelTask, params: { id: taskId },
    }))
    expect(JSON.parse(canceled.body).error.code).toBe(-32001)

    const owner = await b.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 13, method: A2A_METHODS.getTask, params: { id: taskId },
    }))
    expect(JSON.parse(owner.body).result.id).toBe(taskId)
  })

  it('replays a duplicate messageId instead of executing twice', async () => {
    const execute = vi.fn(async () => ({ parts: [{ text: 'done' }] }))
    const server = makeServer({ executors: fakeExecutorSet({ name: 'session', execute }) })
    const body = JSON.stringify(sendMessage)
    const first = await server.handle({ method: 'POST', url: '/a2a' }, body)
    const second = await server.handle({ method: 'POST', url: '/a2a' }, body)
    expect(JSON.parse(second.body).result.task.id).toBe(JSON.parse(first.body).result.task.id)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('continues an INPUT_REQUIRED task by taskId and rejects terminal continuation', async () => {
    let calls = 0
    const executor: A2aExecutor = {
      name: 'session',
      async execute() {
        calls += 1
        return calls === 1
          ? { parts: [{ text: 'need input' }], state: TaskState.INPUT_REQUIRED, statusMessage: 'give me more' }
          : { parts: [{ text: 'finished' }] }
      },
    }
    const server = makeServer({ executors: fakeExecutorSet(executor) })
    const first = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))).body).result.task
    expect(first.status.state).toBe(TaskState.INPUT_REQUIRED)
    const continuation = {
      jsonrpc: '2.0', id: 20, method: A2A_METHODS.sendMessage,
      params: { message: { messageId: 'm-cont', taskId: first.id, contextId: first.contextId, role: 'user', parts: [{ text: 'more' }] } },
    }
    const second = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(continuation))).body).result.task
    expect(second.id).toBe(first.id)
    expect(second.status.state).toBe(TaskState.COMPLETED)
    const terminal = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      ...continuation,
      id: 21,
      params: { message: { ...continuation.params.message, messageId: 'm-after' } },
    }))
    expect(JSON.parse(terminal.body).error.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION)
  })

  it('maps a task timeout to FAILED', async () => {
    const hung: A2aExecutor = {
      name: 'session',
      execute: () => new Promise(() => {}),
    }
    const server = makeServer({ executors: fakeExecutorSet(hung), taskTimeoutMs: 20 })
    const res = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    const task = JSON.parse(res.body).result.task
    expect(task.status.state).toBe(TaskState.FAILED)
    expect(task.status.message.parts[0].text).toMatch(/execution budget/)
  })

  it('filters and cursor-pages ListTasks', async () => {
    const store = new MemoryTaskStore()
    for (const state of [TaskState.COMPLETED, TaskState.FAILED, TaskState.WORKING]) {
      const record = store.create({ contextId: 'ctx', skill: 'chat', parts: [], remotePeerId: null })
      store.setState(record.taskId, state)
    }
    const server = makeServer({ store })
    const first = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 30, method: A2A_METHODS.listTasks, params: { pageSize: 2, includeArtifacts: true },
    }))
    const page1 = JSON.parse(first.body).result
    expect(page1.tasks).toHaveLength(2)
    expect(page1.nextPageToken).not.toBe('')
    const second = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 31, method: A2A_METHODS.listTasks, params: { pageSize: 2, pageToken: page1.nextPageToken },
    }))
    expect(JSON.parse(second.body).result.tasks).toHaveLength(1)
    const failed = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 32, method: A2A_METHODS.listTasks, params: { status: TaskState.FAILED },
    }))
    expect(JSON.parse(failed.body).result.tasks).toHaveLength(1)
    expect(JSON.parse(failed.body).result.tasks[0].status.state).toBe(TaskState.FAILED)
  })

  it('records structured task and request metrics', async () => {
    const metrics = new A2aMetrics()
    const server = makeServer({ metrics })
    await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    const snapshot = metrics.snapshot()
    expect(snapshot.requests).toBe(1)
    expect(snapshot.tasks.created).toBe(1)
    expect(snapshot.tasks.completed).toBe(1)
    expect(snapshot.audit.some((event) => event.kind === 'task.settled')).toBe(true)
  })

  it('rate-limits repeated requests per source', async () => {
    const server = makeServer({ requestsPerMinute: 1 })
    const req = { method: 'POST', url: '/a2a', socket: { remoteAddress: '127.0.0.1', remotePort: 99 } }
    const first = await server.handle(req, JSON.stringify(sendMessage))
    expect(first.status).toBe(200)
    const second = await server.handle(req, JSON.stringify(sendMessage))
    expect(second.status).toBe(429)
    expect(second.headers?.['Retry-After']).toBeDefined()
  })
})

describe('SSE reconnect replay', () => {
  it('replays events after Last-Event-ID for the same task only', async () => {
    const executor: A2aExecutor = {
      name: 'session',
      execute: async () => ({ parts: [{ text: 'partial' }], state: TaskState.INPUT_REQUIRED, statusMessage: 'more please' }),
    }
    const server = makeServer({ executors: fakeExecutorSet(executor) })
    const first = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))).body).result.task
    const frames: string[] = []
    await server.handleStream(
      { method: 'POST', url: '/a2a', headers: { 'last-event-id': '1' } },
      JSON.stringify({ jsonrpc: '2.0', id: 40, method: A2A_METHODS.subscribeToTask, params: { id: first.id } }),
      (frame) => frames.push(frame),
    )
    const joined = frames.join('\n')
    // The first frame is the current Task; replayed event ids follow.
    expect(joined).toContain('"task"')
    expect(joined).toMatch(/id: [2-9]/)
    // The snapshot already contains the artifact; replaying artifactUpdate
    // would append the same parts again on a spec client.
    expect(joined).not.toContain('artifactUpdate')
    // A cursor at the last event replays nothing beyond the initial/final Task.
    const atEnd: string[] = []
    const lastId = Math.max(...frames.map((frame) => Number.parseInt(/id: (\d+)/.exec(frame)?.[1] ?? '0', 10)))
    await server.handleStream(
      { method: 'POST', url: '/a2a', headers: { 'last-event-id': String(lastId) } },
      JSON.stringify({ jsonrpc: '2.0', id: 41, method: A2A_METHODS.subscribeToTask, params: { id: first.id } }),
      (frame) => atEnd.push(frame),
    )
    expect(atEnd.join('\n')).not.toContain('artifactUpdate')
    expect(atEnd.join('\n')).toContain('"task"')
  })
})

describe('SSE per-task routing', () => {
  it('does not leak one task\'s frames into another task\'s stream', async () => {
    const releases: Array<() => void> = []
    const executor: A2aExecutor = {
      name: 'session',
      async execute(input, { onEvent }) {
        onEvent({ type: 'artifact', artifactId: 'result', parts: [{ text: `delta-${input.prompt}` }] })
        await new Promise<void>((resolve) => releases.push(resolve))
        return { parts: [{ text: `final-${input.prompt}` }] }
      },
    }
    const server = makeServer({ executors: fakeExecutorSet(executor) })
    const framesA: string[] = []
    const framesB: string[] = []
    const stream = (id: number, text: string, frames: string[]) => server.handleStream(
      { method: 'POST', url: '/a2a' },
      JSON.stringify({
        jsonrpc: '2.0', id, method: A2A_METHODS.sendStreamingMessage,
        params: { message: { messageId: `stream-${id}`, contextId: `ctx-${id}`, role: 'user', parts: [{ text }] } },
      }),
      (frame) => frames.push(frame),
    )
    const pendingA = stream(60, 'A', framesA)
    const pendingB = stream(61, 'B', framesB)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    for (const release of releases.splice(0)) release()
    await Promise.all([pendingA, pendingB])
    const a = framesA.join('\n')
    const b = framesB.join('\n')
    expect(a).toContain('delta-A')
    expect(a).not.toContain('delta-B')
    expect(b).toContain('delta-B')
    expect(b).not.toContain('delta-A')
  })
})

describe('wire conformance', () => {
  it('rejects an unsupported A2A-Version', async () => {
    const server = makeServer()
    const res = await server.handle({ method: 'POST', url: '/a2a', headers: { 'a2a-version': '0.3' } }, JSON.stringify(sendMessage))
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe(A2A_ERROR_CODES.VERSION_NOT_SUPPORTED)
    expect(res.headers?.['A2A-Version']).toBe('1.0')
  })

  it('returns PUSH_NOTIFICATION_NOT_SUPPORTED for push config methods', async () => {
    const server = makeServer()
    const res = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 70, method: A2A_METHODS.createTaskPushNotificationConfig, params: {},
    }))
    expect(JSON.parse(res.body).error.code).toBe(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED)
  })

  it('includes totalSize in ListTasks and returns the SendMessage task envelope', async () => {
    const server = makeServer()
    const sent = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))).body)
    expect(sent.result.task.id).toMatch(/^a2a-/)
    const listed = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 71, method: A2A_METHODS.listTasks, params: {},
    }))).body)
    expect(listed.result.totalSize).toBe(1)
  })

  it('rejects SubscribeToTask for a terminal task', async () => {
    const server = makeServer()
    const task = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))).body).result.task
    const frames: string[] = []
    await server.handleStream(
      { method: 'POST', url: '/a2a' },
      JSON.stringify({ jsonrpc: '2.0', id: 72, method: A2A_METHODS.subscribeToTask, params: { id: task.id } }),
      (frame) => frames.push(frame),
    )
    expect(frames[0]).toContain(A2A_ERROR_CODES.UNSUPPORTED_OPERATION)
  })

  it('rate-limits by client address, not by ephemeral port', async () => {
    const server = makeServer({ requestsPerMinute: 1 })
    const first = await server.handle({ method: 'POST', url: '/a2a', socket: { remoteAddress: '127.0.0.1', remotePort: 1 } }, JSON.stringify(sendMessage))
    const second = await server.handle({ method: 'POST', url: '/a2a', socket: { remoteAddress: '127.0.0.1', remotePort: 2 } }, JSON.stringify(sendMessage))
    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
  })

  it('streams JSON-RPC result envelopes with event ids and append semantics', async () => {
    const executor: A2aExecutor = {
      name: 'session',
      async execute(_input, { onEvent }) {
        onEvent({ type: 'artifact', artifactId: 'result', parts: [{ text: 'a' }], append: true })
        onEvent({ type: 'artifact', artifactId: 'result', parts: [{ text: 'b' }], append: true })
        return { parts: [], appendResult: false }
      },
    }
    const server = makeServer({ executors: fakeExecutorSet(executor) })
    const frames: string[] = []
    await server.handleStream(
      { method: 'POST', url: '/a2a' },
      JSON.stringify({
        jsonrpc: '2.0', id: 73, method: A2A_METHODS.sendStreamingMessage,
        params: { message: { messageId: 'm-envelope', role: 'user', parts: [{ text: 'x' }] } },
      }),
      (frame) => frames.push(frame),
    )
    const artifactFrames = frames.filter((frame) => frame.includes('artifactUpdate'))
    expect(artifactFrames).toHaveLength(2)
    for (const frame of artifactFrames) {
      expect(frame).toContain('"jsonrpc":"2.0"')
      expect(frame).toContain('"id":73')
      expect(frame).toContain('"append":true')
      expect(frame).toMatch(/id: \d+/)
    }
  })
})

describe('SendMessage configuration and history', () => {
  it('returns immediately when requested and still runs the task', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor: A2aExecutor = {
      name: 'session',
      execute: async () => { await gate; return { parts: [{ text: 'done' }] } },
    }
    const server = makeServer({ executors: fakeExecutorSet(executor) })
    const sent = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      ...sendMessage,
      params: {
        message: sendMessage.params.message,
        configuration: { returnImmediately: true },
      },
    }))).body).result.task
    expect(sent.status.state).toBe(TaskState.WORKING)
    release()
    await vi.waitFor(async () => {
      const got = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
        jsonrpc: '2.0', id: 80, method: A2A_METHODS.getTask, params: { id: sent.id },
      }))).body).result
      expect(got.status.state).toBe(TaskState.COMPLETED)
    })
  })

  it('honors GetTask historyLength', async () => {
    const server = makeServer()
    const task = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))).body).result.task
    const none = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 81, method: A2A_METHODS.getTask, params: { id: task.id, historyLength: 0 },
    }))).body).result
    expect(none.history).toBeUndefined()
    const one = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 82, method: A2A_METHODS.getTask, params: { id: task.id, historyLength: 1 },
    }))).body).result
    expect(one.history).toHaveLength(1)
    expect(one.history[0].role).toBe('ROLE_AGENT')
  })
})

describe('running-task continuation', () => {
  it('rejects a new message for a task that is still running', async () => {
    const release: { current?: () => void } = {}
    const executor: A2aExecutor = {
      name: 'session',
      execute: async () => {
        await new Promise<void>((resolve) => { release.current = resolve })
        return { parts: [{ text: 'done' }] }
      },
    }
    const server = makeServer({ executors: fakeExecutorSet(executor) })
    const pending = server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    let record = undefined as { taskId: string; contextId: string } | undefined
    // Wait for the task to start.
    for (let i = 0; i < 100 && record === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      record = (server as unknown as { opts: { store: { list(): Array<{ taskId: string; contextId: string }> } } }).opts.store.list()[0] as typeof record
    }
    const continuation = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      jsonrpc: '2.0', id: 90, method: A2A_METHODS.sendMessage,
      params: { message: { messageId: 'm-running', taskId: record!.taskId, contextId: record!.contextId, role: 'user', parts: [{ text: 'more' }] } },
    }))
    expect(JSON.parse(continuation.body).error.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION)
    release.current?.()
    await pending
  })
})

describe('Last-Event-ID replay and append', () => {
  it('never duplicates artifact text when replay frames are fed to A2AClient', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor: A2aExecutor = {
      name: 'session',
      async execute(_input, { onEvent }) {
        onEvent({ type: 'artifact', artifactId: 'result', parts: [{ text: 'a' }], append: true })
        onEvent({ type: 'artifact', artifactId: 'result', parts: [{ text: 'b' }], append: true })
        await gate
        return { parts: [], appendResult: false }
      },
    }
    const server = makeServer({ executors: fakeExecutorSet(executor) })
    const sent = JSON.parse((await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify({
      ...sendMessage,
      params: { message: sendMessage.params.message, configuration: { returnImmediately: true } },
    }))).body).result.task
    await vi.waitFor(() => {
      const task = server['opts']['store'].get(sent.id) as { artifacts: Array<{ parts: Array<{ text: string }> }> }
      expect(task.artifacts[0]?.parts.map((part) => part.text).join('')).toBe('ab')
    })

    const frames: string[] = []
    const streaming = server.handleStream(
      { method: 'POST', url: '/a2a', headers: { 'last-event-id': '1' } },
      JSON.stringify({ jsonrpc: '2.0', id: 95, method: A2A_METHODS.subscribeToTask, params: { id: sent.id } }),
      (frame) => frames.push(frame),
    )
    await vi.waitFor(() => expect(frames.join('\n')).toContain('"task"'))
    release()
    await streaming

    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify({ ...card, capabilities: { streaming: true } }), { status: 200 })
      return new Response(frames.join(''), { status: 200 })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, retries: 0 })
    const snapshots: string[] = []
    await client.sendStreamingMessage(
      { messageId: 'probe', role: Role.USER, parts: [{ text: 'probe' }] },
      {
        stream: true,
        onTask: (task) => {
          const text = (task.artifacts ?? []).flatMap((artifact) => artifact.parts ?? []).map((part) => part.text ?? '').join('')
          if (text.length > 0) snapshots.push(text)
        },
      },
    )
    expect(snapshots).not.toContain('aa')
    expect(snapshots).not.toContain('aab')
    expect(snapshots.at(-1)).toBe('ab')
  })
})
