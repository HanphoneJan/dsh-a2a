/**
 * Outbound client tests: AgentCard discovery and JSON-RPC calls over a
 * stubbed fetch, including auth, polling, and timeout paths.
 * @module dsh-a2a/tests/unit/calls.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { A2AClient, A2AError } from '../../src/outbound/calls.ts'
import { A2A_ERROR_CODES, A2A_METHODS, Role, TaskState, type AgentCard } from '../../src/protocol.ts'

const card: AgentCard = {
  name: 'remote',
  description: 'Remote agent',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'https://remote.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  skills: [{ id: 'chat' }],
}

/** Build a fetch stub serving the card on GET and scripted JSON-RPC on POST. */
function stubFetch(posts: Array<(body: unknown) => unknown>): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let tail: ((body: unknown) => unknown) | undefined
  const fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    if (init?.method !== 'POST') {
      return new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(String(init.body))
    // Polling re-issues the same request shape; once the script is exhausted,
    // repeat the last response so multi-poll runs stay deterministic.
    const next = posts.shift()
    if (next !== undefined) tail = next
    const result = (tail ?? (() => ({ error: { code: -32603, message: 'unscripted call' } })))(body)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, calls }
}

function terminalTask(id: string, state: TaskState = TaskState.COMPLETED) {
  return { id, contextId: 'c', status: { state, timestamp: new Date().toISOString() }, artifacts: [{ artifactId: 'result', parts: [{ text: 'yes' }] }] }
}

describe('A2AClient.connect', () => {
  it('fetches and validates the AgentCard, then picks the JSON-RPC interface', async () => {
    const { fetch, calls } = stubFetch([])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    expect(client.card.name).toBe('remote')
    expect(calls[0]?.url).toBe('https://remote.example/card.json')
  })

  it('throws INVALID_AGENT_RESPONSE on an HTTP error', async () => {
    const fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch
    await expect(A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch }))
      .rejects.toMatchObject({ code: A2A_ERROR_CODES.INVALID_AGENT_RESPONSE })
  })

  it('throws INVALID_AGENT_RESPONSE on a card missing name/skills', async () => {
    const fetch = (async () => new Response(JSON.stringify({ version: '1' }), { status: 200 })) as typeof fetch
    await expect(A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch }))
      .rejects.toMatchObject({ code: A2A_ERROR_CODES.INVALID_AGENT_RESPONSE })
  })
})

describe('A2AClient.sendMessage', () => {
  it('returns a terminal task without polling', async () => {
    const { fetch } = stubFetch([() => ({ result: terminalTask('a2a-1') })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    const task = await client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] })
    expect(task.id).toBe('a2a-1')
    expect(task.status.state).toBe(TaskState.COMPLETED)
  })

  it('polls a non-terminal task until it settles', async () => {
    const { fetch } = stubFetch([
      () => ({ result: terminalTask('a2a-2', TaskState.WORKING) }),
      () => ({ result: terminalTask('a2a-2', TaskState.COMPLETED) }),
    ])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, timeoutMs: 5000 })
    const task = await client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] })
    expect(task.status.state).toBe(TaskState.COMPLETED)
  })

  it('surfaces a remote JSON-RPC error with its code', async () => {
    const { fetch } = stubFetch([() => ({ error: { code: A2A_ERROR_CODES.TASK_NOT_FOUND, message: 'nope' } })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    await expect(client.sendMessage({ messageId: 'm', role: Role.USER, parts: [] }))
      .rejects.toMatchObject({ code: A2A_ERROR_CODES.TASK_NOT_FOUND })
  })

  it('throws A2AError on a 401 response', async () => {
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('unauthorized', { status: 401 })
      return new Response(JSON.stringify(card), { status: 200 })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    await expect(client.sendMessage({ messageId: 'm', role: Role.USER, parts: [] }))
      .rejects.toMatchObject({ code: -32040 })
  })

  it('times out when the task never settles', async () => {
    const { fetch } = stubFetch([() => ({ result: terminalTask('a2a-3', TaskState.WORKING) })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, timeoutMs: 50 })
    await expect(client.sendMessage({ messageId: 'm', role: Role.USER, parts: [] }))
      .rejects.toMatchObject({ code: -32000, message: /did not settle/ })
  })
})

describe('A2AClient methods', () => {
  it('issues GetTask / ListTasks / CancelTask with the canonical method names', async () => {
    const seen: string[] = []
    const { fetch } = stubFetch([
      (body) => { seen.push((body as { method: string }).method); return { result: terminalTask('a2a-4') } },
      (body) => { seen.push((body as { method: string }).method); return { result: [] } },
      (body) => { seen.push((body as { method: string }).method); return { result: terminalTask('a2a-4', TaskState.CANCELED) } },
    ])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    await client.getTask('a2a-4')
    await client.listTasks()
    await client.cancelTask('a2a-4')
    expect(seen).toEqual([A2A_METHODS.getTask, A2A_METHODS.listTasks, A2A_METHODS.cancelTask])
  })
})
describe('A2AClient streaming, retry and list shape', () => {
  const streamingCard: AgentCard = { ...card, capabilities: { streaming: true } }

  it('reads a streaming SendMessage to its terminal task', async () => {
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(streamingCard), { status: 200 })
      const encoder = new TextEncoder()
      const frames = [
        { statusUpdate: { taskId: 'a2a-s', contextId: 'c', status: { state: TaskState.WORKING, timestamp: new Date().toISOString() } } },
        { artifactUpdate: { taskId: 'a2a-s', contextId: 'c', artifact: { artifactId: 'result', parts: [{ text: 'hel' }] }, lastChunk: false } },
        { artifactUpdate: { taskId: 'a2a-s', contextId: 'c', artifact: { artifactId: 'result', parts: [{ text: 'lo' }] }, lastChunk: true } },
        { task: { id: 'a2a-s', contextId: 'c', status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() }, artifacts: [{ artifactId: 'result', parts: [{ text: 'hello' }] }] } },
      ]
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    const task = await client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] }, { stream: true })
    expect(task.status.state).toBe(TaskState.COMPLETED)
    expect(task.artifacts?.[0]?.parts).toEqual([{ text: 'hello' }])
  })

  it('retries a transient GetTask failure', async () => {
    let attempts = 0
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(card), { status: 200 })
      attempts += 1
      if (attempts === 1) throw new Error('network jitter')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: terminalTask('a2a-r') }), { status: 200 })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, retries: 1, retryDelayMs: 1 })
    await expect(client.getTask('a2a-r')).resolves.toMatchObject({ id: 'a2a-r' })
    expect(attempts).toBe(2)
  })

  it('accepts the spec ListTasks response object', async () => {
    const { fetch } = stubFetch([() => ({ result: { tasks: [terminalTask('a2a-l')], nextPageToken: '', pageSize: 50 } })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    await expect(client.listTasks()).resolves.toMatchObject([{ id: 'a2a-l' }])
  })
})

describe('A2AClient cancellation propagation', () => {
  it('sends CancelTask when a polling caller aborts', async () => {
    const seen: string[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(card), { status: 200 })
      const body = JSON.parse(String(init.body)) as { method: string }
      seen.push(body.method)
      if (body.method === A2A_METHODS.sendMessage) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: terminalTask('a2a-c', TaskState.WORKING) }), { status: 200 })
      }
      if (body.method === A2A_METHODS.cancelTask) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: terminalTask('a2a-c', TaskState.CANCELED) }), { status: 200 })
      }
      // GetTask never settles; reject when the caller's signal aborts.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, timeoutMs: 5000, retries: 0 })
    const controller = new AbortController()
    const pending = client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(seen).toContain(A2A_METHODS.cancelTask))
  })
})

describe('A2A envelope and incremental artifact semantics', () => {
  it('accepts the SendMessage {task} envelope', async () => {
    const { fetch } = stubFetch([() => ({ result: { task: terminalTask('a2a-env') } })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    await expect(client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] }))
      .resolves.toMatchObject({ id: 'a2a-env' })
  })

  it('appends artifact chunks only when append is true', async () => {
    const event = (payload: unknown, id: number) => `id: ${id}\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: payload })}\n\n`
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify({ ...card, capabilities: { streaming: true } }), { status: 200 })
      const body = [
        event({ statusUpdate: { taskId: 'a2a-a', contextId: 'c', status: { state: TaskState.WORKING, timestamp: new Date().toISOString() } } }, 1),
        event({ artifactUpdate: { taskId: 'a2a-a', contextId: 'c', artifact: { artifactId: 'r', parts: [{ text: 'a' }] }, append: true } }, 2),
        event({ artifactUpdate: { taskId: 'a2a-a', contextId: 'c', artifact: { artifactId: 'r', parts: [{ text: 'b' }] }, append: true } }, 3),
        event({ statusUpdate: { taskId: 'a2a-a', contextId: 'c', status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() } } }, 4),
      ].join('')
      return new Response(body, { status: 200 })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, retries: 0 })
    const task = await client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] }, { stream: true })
    expect(task.artifacts?.[0]?.parts).toEqual([{ text: 'a' }, { text: 'b' }])
  })

  it('retries a broken stream with Last-Event-ID and consumes the missing tail', async () => {
    let posts = 0
    let lastEventHeader: string | undefined
    const event = (payload: unknown, id: number) => `id: ${id}\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: payload })}\n\n`
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify({ ...card, capabilities: { streaming: true } }), { status: 200 })
      posts += 1
      lastEventHeader = (init.headers as Record<string, string> | undefined)?.['last-event-id']
      if (posts === 1) {
        return new Response(event({
          statusUpdate: { taskId: 'a2a-r', contextId: 'c', status: { state: TaskState.WORKING, timestamp: new Date().toISOString() } },
        }, 7), { status: 200 })
      }
      return new Response(event({
        statusUpdate: { taskId: 'a2a-r', contextId: 'c', status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() } },
      }, 8), { status: 200 })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, retries: 2, retryDelayMs: 1 })
    const task = await client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] }, { stream: true })
    expect(task.status.state).toBe(TaskState.COMPLETED)
    expect(lastEventHeader).toBe('7')
  })

  it('handles message-only streams as a completed result', async () => {
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify({ ...card, capabilities: { streaming: true } }), { status: 200 })
      const frame = { message: { messageId: 'msg-1', role: Role.AGENT, parts: [{ text: 'direct' }] } }
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: frame })}\n\n`, { status: 200 })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, retries: 0 })
    const task = await client.sendMessage({ messageId: 'm', role: Role.USER, parts: [{ text: 'hi' }] }, { stream: true })
    expect(task.status.state).toBe(TaskState.COMPLETED)
    expect(task.artifacts?.[0]?.parts).toEqual([{ text: 'direct' }])
  })
})
