/**
 * Outbound client tests: AgentCard discovery and JSON-RPC calls over a
 * stubbed fetch, including auth, polling, and timeout paths.
 * @module dsh-a2a/tests/unit/calls.spec
 */

import { describe, expect, it } from 'vitest'
import { A2AClient, A2AError } from '../../src/client/calls.ts'
import { A2A_ERROR_CODES, A2A_METHODS, TaskState, type AgentCard } from '../../src/protocol.ts'

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

  it('throws AGENT_CARD_NOT_FOUND on an HTTP error', async () => {
    const fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch
    await expect(A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch }))
      .rejects.toMatchObject({ code: A2A_ERROR_CODES.AGENT_CARD_NOT_FOUND })
  })

  it('throws AGENT_CARD_SIGNATURE_INVALID on a card missing name/description', async () => {
    const fetch = (async () => new Response(JSON.stringify({ version: '1' }), { status: 200 })) as typeof fetch
    await expect(A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch }))
      .rejects.toMatchObject({ code: A2A_ERROR_CODES.AGENT_CARD_SIGNATURE_INVALID })
  })
})

describe('A2AClient.sendMessage', () => {
  it('returns a terminal task without polling', async () => {
    const { fetch } = stubFetch([() => ({ result: terminalTask('a2a-1') })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    const task = await client.sendMessage({ messageId: 'm', role: 'user', parts: [{ text: 'hi' }] })
    expect(task.id).toBe('a2a-1')
    expect(task.status.state).toBe(TaskState.COMPLETED)
  })

  it('polls a non-terminal task until it settles', async () => {
    const { fetch } = stubFetch([
      () => ({ result: terminalTask('a2a-2', TaskState.WORKING) }),
      () => ({ result: terminalTask('a2a-2', TaskState.COMPLETED) }),
    ])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, timeoutMs: 5000 })
    const task = await client.sendMessage({ messageId: 'm', role: 'user', parts: [{ text: 'hi' }] })
    expect(task.status.state).toBe(TaskState.COMPLETED)
  })

  it('surfaces a remote JSON-RPC error with its code', async () => {
    const { fetch } = stubFetch([() => ({ error: { code: A2A_ERROR_CODES.UNAUTHORIZED, message: 'nope' } })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    await expect(client.sendMessage({ messageId: 'm', role: 'user', parts: [] }))
      .rejects.toMatchObject({ code: A2A_ERROR_CODES.UNAUTHORIZED })
  })

  it('throws A2AError on a 401 response', async () => {
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('unauthorized', { status: 401 })
      return new Response(JSON.stringify(card), { status: 200 })
    }) as typeof fetch
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch })
    await expect(client.sendMessage({ messageId: 'm', role: 'user', parts: [] }))
      .rejects.toMatchObject({ code: A2A_ERROR_CODES.UNAUTHORIZED })
  })

  it('times out when the task never settles', async () => {
    const { fetch } = stubFetch([() => ({ result: terminalTask('a2a-3', TaskState.WORKING) })])
    const client = await A2AClient.connect('https://remote.example/card.json', { fetchImpl: fetch, timeoutMs: 50 })
    await expect(client.sendMessage({ messageId: 'm', role: 'user', parts: [] }))
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