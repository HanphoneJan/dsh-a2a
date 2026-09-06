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
import { A2A_METHODS, TaskState, type AgentCard, type Part } from '../../src/protocol.ts'

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
    const task = JSON.parse(res.body).result
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
    expect(body.result.status.state).toBe(TaskState.CANCELED)
  })

  it('cancelTask via JSON-RPC rejects terminal tasks', async () => {
    const server = makeServer()
    const done = await server.handle({ method: 'POST', url: '/a2a' }, JSON.stringify(sendMessage))
    const taskId = JSON.parse(done.body).result.id
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
    expect(frames[0]).toContain('event: error')
    expect(frames[0]).toContain('-32601')
  })
})