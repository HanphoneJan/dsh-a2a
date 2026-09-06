/**
 * Durable task storage for the inbound half: one `a2a` domain over the routed
 * storage backend (the deployment picks the medium, normally SQLite). Records
 * are serialized JSON so the domain tables stay plain kv rows; the domain
 * SCHEMA_VERSION guards format evolution. A memory store keeps unit tests and
 * minimal embeddings free of a backend.
 * @module dsh-a2a/server/store
 */

import { z } from 'zod'
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import { TaskState, type Part } from '../protocol.ts'

/** One durable inbound/outbound task record. */
export interface TaskRecord {
  readonly taskId: string
  readonly contextId: string
  readonly skill: string
  readonly state: TaskState
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionId: string | null
  readonly remotePeerId: string | null
  readonly parts: readonly Part[]
  readonly artifacts: readonly { readonly artifactId: string; readonly name?: string; readonly parts: readonly Part[] }[]
  readonly executor: 'session' | 'subagent'
  readonly summary: string | null
  readonly error?: { readonly code: string; readonly message: string }
}

/** One durable context→session binding (inbound conversation ↔ DSH session). */
export interface ContextBinding {
  readonly sessionId: string
}

/** One durable outbound agent record (client registry persistence). */
export interface OutboundAgentRecord {
  readonly id: string
  readonly name: string
  readonly agentCardUrl: string
  readonly bearerTokenEnv?: string
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly lastCardAt: string | null
}

/** JSON-encoded record schema shared by every `a2a` table. */
const json = z.string()

/** The `a2a` storage domain: JSON-encoded records, one table per record kind. */
export const a2aDomainSpec = defineDomain({
  name: 'a2a',
  version: 1,
  tables: {
    tasks: domainTable<string, string>(json),
    contexts: domainTable<string, string>(json),
    agents: domainTable<string, string>(json),
  },
})

export type A2aDomainSpec = typeof a2aDomainSpec

/**
 * Serialize/deserialize helpers for the domain tables. Plain JSON round-trip
 * with shape assertions; `decodeRecord` returns undefined on any mismatch.
 */
export function encodeRecord(value: unknown): string {
  return JSON.stringify(value)
}

export function decodeRecord<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * Open the `a2a` domain on the mounted storage-domain facility and expose
 * its tables. The caller owns the returned handle and closes it on teardown.
 */
export async function openDomain(domain: DomainFacility): Promise<A2aDomain> {
  const handle = await domain.open(a2aDomainSpec)
  return new A2aDomain(handle)
}

/** A2a domain facade: typed JSON tables over the routed backend. */
export class A2aDomain {
  constructor(readonly handle: Domain<A2aDomainSpec>) {}

  get tasks(): KvTable<string, string> {
    return this.handle.table('tasks')
  }

  get contexts(): KvTable<string, string> {
    return this.handle.table('contexts')
  }

  get agents(): KvTable<string, string> {
    return this.handle.table('agents')
  }

  async close(): Promise<void> {
    await this.handle.close()
  }
}

/** Task-store contract shared by the domain-backed and memory stores. */
export interface TaskStore {
  create(input: { contextId: string; skill: string; parts: readonly Part[]; remotePeerId: string | null }): TaskRecord
  get(taskId: string): TaskRecord | undefined
  list(): TaskRecord[]
  setState(taskId: string, state: TaskState, message?: { code: string; text: string }): TaskRecord
  appendArtifact(taskId: string, artifact: { artifactId: string; name?: string; parts: readonly Part[]; lastChunk?: boolean }): TaskRecord
  setContextSession(contextId: string, sessionId: string): Promise<void>
  getContextSession(contextId: string): Promise<string | undefined>
  close(): Promise<void>
}

function now(): string {
  return new Date().toISOString()
}

function recordKey(taskId: string): string {
  return `task:${taskId}`
}

function contextKey(contextId: string): string {
  return `ctx:${contextId}`
}

/** In-memory TaskStore (unit tests, minimal embeddings). */
export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, TaskRecord>()
  private contexts = new Map<string, string>()

  create(input: { contextId: string; skill: string; parts: readonly Part[]; remotePeerId: string | null }): TaskRecord {
    const record: TaskRecord = {
      taskId: `a2a-${crypto.randomUUID()}`,
      contextId: input.contextId,
      skill: input.skill,
      state: TaskState.SUBMITTED,
      createdAt: now(),
      updatedAt: now(),
      sessionId: null,
      remotePeerId: input.remotePeerId,
      parts: input.parts,
      artifacts: [],
      executor: 'session',
      summary: null,
    }
    this.tasks.set(record.taskId, record)
    return record
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  setState(taskId: string, state: TaskState, message?: { code: string; text: string }): TaskRecord {
    const current = this.tasks.get(taskId)
    if (current === undefined) throw new Error(`task ${taskId} not found`)
    const next: TaskRecord = {
      ...current,
      state,
      updatedAt: now(),
      ...(message ? { error: { code: message.code, message: message.text } } : current.error ? { error: current.error } : {}),
    }
    this.tasks.set(taskId, next)
    return next
  }

  appendArtifact(taskId: string, artifact: { artifactId: string; name?: string; parts: readonly Part[]; lastChunk?: boolean }): TaskRecord {
    const current = this.tasks.get(taskId)
    if (current === undefined) throw new Error(`task ${taskId} not found`)
    const next: TaskRecord = {
      ...current,
      updatedAt: now(),
      artifacts: appendArtifactRecord(current.artifacts, artifact),
    }
    this.tasks.set(taskId, next)
    return next
  }

  async setContextSession(contextId: string, sessionId: string): Promise<void> {
    this.contexts.set(contextId, sessionId)
  }

  async getContextSession(contextId: string): Promise<string | undefined> {
    return this.contexts.get(contextId)
  }

  async close(): Promise<void> {}
}

function appendArtifactRecord(
  artifacts: TaskRecord['artifacts'],
  artifact: { artifactId: string; name?: string; parts: readonly Part[] },
): TaskRecord['artifacts'] {
  const existing = artifacts.find((a) => a.artifactId === artifact.artifactId)
  if (existing) {
    return artifacts.map((a) => (a.artifactId === artifact.artifactId ? { ...a, parts: [...a.parts, ...artifact.parts] } : a))
  }
  return [...artifacts, { artifactId: artifact.artifactId, ...(artifact.name !== undefined ? { name: artifact.name } : {}), parts: artifact.parts }]
}

/** Domain-backed TaskStore (persistent; the composition path). */
export class DomainTaskStore implements TaskStore {
  // The real `KvTable.put` queues on the domain's write chain: durability
  // first, then the in-memory table updates. TaskStore's synchronous readers
  // must see their own writes immediately, so this store keeps the live view
  // in memory, seeds it from the domain's opened tables (already loaded from
  // the medium), updates it before each queued write, and never reads the
  // table back for its own writes.
  private readonly records = new Map<string, TaskRecord>()
  private readonly bindings = new Map<string, string>()

  constructor(private readonly domain: A2aDomain) {
    for (const [key, raw] of domain.tasks.entries()) {
      if (!key.startsWith('task:')) continue
      const record = decodeRecord<TaskRecord>(raw)
      if (record !== undefined) this.records.set(record.taskId, record)
    }
    for (const [key, raw] of domain.contexts.entries()) {
      if (!key.startsWith('ctx:')) continue
      const binding = decodeRecord<ContextBinding>(raw)
      if (binding !== undefined) this.bindings.set(key.slice('ctx:'.length), binding.sessionId)
    }
  }

  create(input: { contextId: string; skill: string; parts: readonly Part[]; remotePeerId: string | null }): TaskRecord {
    const record: TaskRecord = {
      taskId: `a2a-${crypto.randomUUID()}`,
      contextId: input.contextId,
      skill: input.skill,
      state: TaskState.SUBMITTED,
      createdAt: now(),
      updatedAt: now(),
      sessionId: null,
      remotePeerId: input.remotePeerId,
      parts: input.parts,
      artifacts: [],
      executor: 'session',
      summary: null,
    }
    this.records.set(record.taskId, record)
    // Persist eagerly; a failed write must fail the task, not silently lose it.
    void this.domain.tasks.put(recordKey(record.taskId), encodeRecord(record)).catch((err: unknown) => {
      throw new Error(`a2a: task persistence failed: ${String(err)}`)
    })
    return record
  }

  get(taskId: string): TaskRecord | undefined {
    return this.records.get(taskId)
  }

  list(): TaskRecord[] {
    return [...this.records.values()]
  }

  setState(taskId: string, state: TaskState, message?: { code: string; text: string }): TaskRecord {
    const current = this.records.get(taskId)
    if (current === undefined) throw new Error(`task ${taskId} not found`)
    const next: TaskRecord = withState(current, state, message, now())
    this.records.set(taskId, next)
    void this.domain.tasks.put(recordKey(taskId), encodeRecord(next)).catch((err: unknown) => {
      throw new Error(`a2a: task persistence failed: ${String(err)}`)
    })
    return next
  }

  appendArtifact(taskId: string, artifact: { artifactId: string; name?: string; parts: readonly Part[]; lastChunk?: boolean }): TaskRecord {
    const current = this.records.get(taskId)
    if (current === undefined) throw new Error(`task ${taskId} not found`)
    const next: TaskRecord = { ...current, updatedAt: now(), artifacts: appendArtifactRecord(current.artifacts, artifact) }
    this.records.set(taskId, next)
    void this.domain.tasks.put(recordKey(taskId), encodeRecord(next)).catch((err: unknown) => {
      throw new Error(`a2a: task persistence failed: ${String(err)}`)
    })
    return next
  }

  async setContextSession(contextId: string, sessionId: string): Promise<void> {
    const binding: ContextBinding = { sessionId }
    this.bindings.set(contextId, sessionId)
    await this.domain.contexts.put(contextKey(contextId), encodeRecord(binding))
  }

  async getContextSession(contextId: string): Promise<string | undefined> {
    return this.bindings.get(contextId)
  }

  async close(): Promise<void> {}
}

function withState(
  current: TaskRecord,
  state: TaskState,
  message: { code: string; text: string } | undefined,
  timestamp: string,
): TaskRecord {
  return {
    ...current,
    state,
    updatedAt: timestamp,
    ...(message ? { error: { code: message.code, message: message.text } } : {}),
  }
}