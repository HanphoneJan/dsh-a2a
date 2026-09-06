/**
 * JSON-RPC 2.0 helpers and SSE framing for the A2A binding. Transport-agnostic:
 * the A2AServer consumes these, and the HTTP route layer only maps requests to
 * `handle` / `handleStream` and bytes back.
 * @module dsh-a2a/jsonrpc
 */

import {
  A2A_ERROR_CODES,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from './protocol.ts'

/** Parse a request body into a JSON-RPC request, or undefined on malformed input. */
export function parseRpc(body: string): JsonRpcRequest | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const rpc = value as Partial<JsonRpcRequest>
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return undefined
  return rpc as JsonRpcRequest
}

/** Build a JSON-RPC error response object. */
export function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

/** Build a JSON-RPC success response object. */
export function rpcSuccess(id: string | number | null | undefined, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

/** Invalid-method error for the SSE path (no request id on the wire). */
export function methodNotFound(method: string): JsonRpcError {
  return rpcError(null, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method ${method}`)
}

/** One data frame of an SSE stream. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** One named event frame of an SSE stream (e.g. `event: error`). */
export function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}