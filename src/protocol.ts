/**
 * Agent2Agent (A2A) Protocol v1.0 — types, task states, JSON-RPC methods and
 * error codes used by this plugin's JSON-RPC over HTTP binding.
 *
 * The surface mirrors the normative `a2a.proto` of the A2A project (Apache-2.0);
 * this file is the plugin's own transcription and the single source of protocol
 * truth. Bindings other than JSON-RPC over HTTP (gRPC, REST) are not provided.
 * @module dsh-a2a/protocol
 */

/** Task lifecycle states (spec `TaskState`). */
export enum TaskState {
  SUBMITTED = 'SUBMITTED',
  WORKING = 'WORKING',
  INPUT_REQUIRED = 'INPUT_REQUIRED',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
  REJECTED = 'REJECTED',
}

/** States that settle a task; a settled task no longer transitions. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELED,
  TaskState.REJECTED,
])

/** @returns whether the state settles the task. */
export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Message sender role (spec `Role`). */
export enum Role {
  USER = 'user',
  AGENT = 'agent',
}

/** One message part: text, file (bytes or uri), or structured data. */
export type Part =
  | { readonly text: string; readonly metadata?: Record<string, unknown> }
  | {
    readonly file: {
      readonly mimeType?: string
      readonly name?: string
      readonly bytes?: string
      readonly uri?: string
    }
    readonly metadata?: Record<string, unknown>
  }
  | { readonly data: unknown; readonly metadata?: Record<string, unknown> }

/** An interaction payload exchanged between agents. */
export interface Message {
  readonly messageId: string
  readonly role: Role
  readonly contextId?: string
  /** Continuation: attaches this message to an existing task's conversation. */
  readonly taskId?: string
  readonly parts: readonly Part[]
  readonly metadata?: Record<string, unknown>
}

/** Current state of a task, with an optional explanatory message. */
export interface TaskStatus {
  readonly state: TaskState
  readonly message?: Message
  readonly timestamp: string
}

/** A chunk of task output. */
export interface Artifact {
  readonly name?: string
  readonly parts: readonly Part[]
  readonly artifactId?: string
}

/** A task: the durable work unit of A2A. */
export interface Task {
  readonly id: string
  readonly contextId?: string
  readonly status: TaskStatus
  readonly artifacts?: readonly Artifact[]
  readonly history?: readonly Message[]
  readonly metadata?: Record<string, unknown>
}

/** JSON-RPC 2.0 request as used by the A2A binding. */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result: unknown
}

export interface JsonRpcErrorBody {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcError {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: JsonRpcErrorBody
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

/** A skill advertised by an agent. */
export interface AgentSkill {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly examples?: readonly string[]
  readonly inputModes?: readonly string[]
  readonly outputModes?: readonly string[]
}

export interface AgentCapabilities {
  readonly streaming?: boolean
  readonly pushNotifications?: boolean
  readonly stateTransitionHistory?: boolean
  readonly extensions?: readonly string[]
}

/** One supported interface (transport binding) of an agent. */
export interface AgentInterface {
  readonly url: string
  readonly protocolBinding?: 'JSONRPC' | 'REST' | 'gRPC' | string
  readonly protocolVersion?: string
  readonly authSchemes?: readonly string[]
}

/** Bearer-token security scheme advertised by the AgentCard. */
export interface AgentSecurityScheme {
  readonly type: 'http'
  readonly scheme: 'bearer'
  readonly description?: string
}

/** The discovery manifest of an A2A agent. */
export interface AgentCard {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly url?: string
  readonly provider?: { readonly url: string; readonly organization: string }
  readonly skills?: readonly AgentSkill[]
  readonly capabilities?: AgentCapabilities
  readonly defaultInputModes?: readonly string[]
  readonly defaultOutputModes?: readonly string[]
  readonly securitySchemes?: Record<string, AgentSecurityScheme>
  readonly securityRequirements?: readonly Record<string, readonly string[]>[]
  readonly supportedInterfaces?: readonly AgentInterface[]
  readonly custom?: Record<string, unknown>
}

/** Streamed updates during a task run (SSE payloads). */
export type StreamResponse =
  | { readonly statusUpdate: { readonly taskId: string; readonly contextId?: string; readonly status: TaskStatus } }
  | { readonly artifactUpdate: { readonly taskId: string; readonly contextId?: string; readonly artifact: Artifact; readonly lastChunk?: boolean } }
  | { readonly task: Task }
  | { readonly error: { readonly code: number; readonly message: string } }

/** A2A v1.0 JSON-RPC method names (canonical PascalCase as in a2a.proto). */
export const A2A_METHODS = {
  sendMessage: 'SendMessage',
  sendStreamingMessage: 'SendStreamingMessage',
  getTask: 'GetTask',
  listTasks: 'ListTasks',
  cancelTask: 'CancelTask',
  subscribeToTask: 'SubscribeToTask',
  getExtendedAgentCard: 'GetExtendedAgentCard',
} as const

/** JSON-RPC error codes for the A2A binding (spec §error codes). */
export const A2A_ERROR_CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32000,
  TASK_NOT_FOUND: -32001,
  TASK_CANCEL_NOT_ALLOWED: -32002,
  AGENT_CARD_NOT_FOUND: -32004,
  AGENT_CARD_SIGNATURE_INVALID: -32005,
} as const

/** Read a message's text parts as a single string (model-facing convenience). */
export function partsToText(parts: readonly Part[] | undefined): string {
  if (!parts) return ''
  return parts
    .map((p) => {
      if ('text' in p && p.text) return p.text
      if ('data' in p && p.data !== undefined) return JSON.stringify(p.data)
      if ('file' in p) return p.file.uri ?? `[file ${p.file.name ?? p.file.mimeType ?? 'binary'}]`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}