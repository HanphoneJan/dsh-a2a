/**
 * JSON-RPC + SSE framing unit tests.
 * @module dsh-a2a/tests/unit/jsonrpc.spec
 */

import { describe, expect, it } from 'vitest'
import {
  methodNotFound,
  parseRpc,
  rpcError,
  rpcSuccess,
  sseData,
  sseEvent,
} from '../../src/jsonrpc.ts'

describe('parseRpc', () => {
  it('accepts a well-formed 2.0 request', () => {
    const rpc = parseRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }))
    expect(rpc?.method).toBe('SendMessage')
    expect(rpc?.id).toBe(1)
  })

  it('rejects malformed JSON, non-objects, and non-2.0 bodies', () => {
    expect(parseRpc('not-json')).toBeUndefined()
    expect(parseRpc('42')).toBeUndefined()
    expect(parseRpc(JSON.stringify({ jsonrpc: '1.0', method: 'x' }))).toBeUndefined()
    expect(parseRpc(JSON.stringify({ jsonrpc: '2.0' }))).toBeUndefined()
  })
})

describe('response builders', () => {
  it('normalizes an absent id to null', () => {
    expect(rpcSuccess(undefined, { ok: true })).toEqual({ jsonrpc: '2.0', id: null, result: { ok: true } })
    expect(rpcError(undefined, -32000, 'nope')).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'nope' } })
  })

  it('omits data from an error when absent', () => {
    const err = rpcError(1, -1, 'm')
    expect('data' in err.error).toBe(false)
    const withData = rpcError(1, -1, 'm', { extra: true })
    expect(withData.error.data).toEqual({ extra: true })
  })

  it('builds method-not-found errors', () => {
    expect(methodNotFound('Nope').error.code).toBe(-32601)
  })
})

describe('SSE framing', () => {
  it('emits a data frame with a blank line separator', () => {
    expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n')
  })

  it('emits a named event frame', () => {
    expect(sseEvent('statusUpdate', { state: 'WORKING' })).toBe('event: statusUpdate\ndata: {"state":"WORKING"}\n\n')
  })
})
