/**
 * Inbound session observation and views: which A2A contexts have a live
 * per-context DSH session, and where they are streaming. The LIVE half of the
 * session layer is a per-instance registry fed by the A2A server's SSE
 * lifecycle hooks (open subscriptions per task); everything else — task
 * counts, timestamps, running/idle status — is DERIVED from the shared task
 * store. That split is deliberate: a composition without an agent loop (no
 * session pool) still renders the session table from task records — degraded,
 * never crashing — while stream-open observations only exist where an A2A
 * server is actually mounted.
 *
 * Views are aggregated by `(serverId, contextId)` (one row per inbound
 * instance conversation), because the session id is a pure function of both
 * (`ContextSessionPool.sessionIdFor`). Two instances may therefore reuse the
 * same client-chosen contextId without sharing a session.
 * @module dsh-a2a/server/session-registry
 */

import type { TaskRecord } from './store.ts'
import { isTerminal } from '../protocol.ts'
import { ContextSessionPool } from './exec/agent-runtime.ts'

/** One aggregated inbound session view (per A2A contextId). */
export interface SessionView {
  readonly contextId: string
  /** DSH session id backing this context (`a2a-<contextId>`, stable). */
  readonly sessionId: string
  /** Inbound instance that handled this context's most recent task. */
  readonly serverId?: string
  readonly serverName?: string
  /** Agent preset composing this context's sessions. */
  readonly preset?: string
  /** running = at least one non-terminal task; idle otherwise. */
  readonly status: 'running' | 'idle'
  /** Total tasks this context has produced (all states). */
  readonly taskCount: number
  /** Tasks still in flight (SUBMITTED / WORKING). */
  readonly activeCount: number
  readonly firstSeen: string
  readonly lastSeen: string
  /** True while at least one SSE subscription is open for this context's tasks. */
  readonly streaming: boolean
  /** True while a live session-pool handle exists for this context. */
  readonly live: boolean
}

/** Per-instance live observation: open SSE subscriptions, counted per task. */
export class ContextSessionRegistry {
  // Task ids never repeat (each SendMessage creates a fresh record), so a
  // plain count per task covers concurrent subscribers on the same task.
  private readonly streamCounts = new Map<string, number>()

  noteStreamOpen(taskId: string): void {
    this.streamCounts.set(taskId, (this.streamCounts.get(taskId) ?? 0) + 1)
  }

  noteStreamClose(taskId: string): void {
    const current = this.streamCounts.get(taskId)
    if (current === undefined) return
    if (current <= 1) this.streamCounts.delete(taskId)
    else this.streamCounts.set(taskId, current - 1)
  }

  streamingOpenCount(taskId: string): number {
    return this.streamCounts.get(taskId) ?? 0
  }

  /** Drop all observations (instance teardown / swap). */
  clear(): void {
    this.streamCounts.clear()
  }
}

/** The slice of a live inbound instance the aggregation reads (structural). */
export interface SessionInstanceLike {
  readonly id: string
  readonly name: string
  // `| undefined` made explicit so a source declaring `preset: string | undefined`
  // (required key, possibly undefined) satisfies this under exactOptionalPropertyTypes.
  readonly preset?: string | undefined
  readonly sessions: ContextSessionRegistry
  /** Live per-context session pool; absent = no agent loop mounted. */
  readonly sessionPool?: {
    has(contextId: string): boolean
    messages?(contextId: string): readonly unknown[]
  } | undefined
}

/**
 * Build per-context session views from the shared task store and the live
 * inbound instances. Rows exist whenever the context has task records, so the
 * table survives restarts and agent-less compositions (degraded: no live
 * handles, no stream observation); only in-memory state resets on restart.
 */
export function aggregateSessionViews(
  tasks: readonly TaskRecord[],
  instances: readonly SessionInstanceLike[],
): SessionView[] {
  const byContext = new Map<string, TaskRecord[]>()
  for (const task of tasks) {
    const key = `${task.serverId ?? ''}\u0000${task.contextId}`
    const list = byContext.get(key)
    if (list === undefined) byContext.set(key, [task])
    else list.push(task)
  }
  const byId = new Map(instances.map((i) => [i.id, i]))
  const rows: SessionView[] = []
  for (const contextTasks of byContext.values()) {
    let latest = contextTasks[0]!
    let firstSeen = latest.createdAt
    let lastSeen = latest.updatedAt
    let activeCount = 0
    for (const task of contextTasks) {
      if (task.createdAt < firstSeen) firstSeen = task.createdAt
      if (task.updatedAt > lastSeen) {
        lastSeen = task.updatedAt
        latest = task
      }
      if (!isTerminal(task.state)) activeCount += 1
    }
    const instance = byId.get(latest.serverId ?? '')
    const streaming = contextTasks.some((task) => {
      const owner = byId.get(task.serverId ?? '')
      if (owner !== undefined) return owner.sessions.streamingOpenCount(task.taskId) > 0
      // Legacy/unattributed tasks have no instance id; retain the old
      // cross-instance observation so pre-upgrade rows still render.
      return instances.some((candidate) => candidate.sessions.streamingOpenCount(task.taskId) > 0)
    })
    const live = instance?.sessionPool?.has(latest.contextId) === true
      || (latest.serverId === undefined && instances.some((candidate) => candidate.sessionPool?.has(latest.contextId) === true))
    const row: SessionView = {
      contextId: latest.contextId,
      sessionId: ContextSessionPool.sessionIdFor(latest.contextId, latest.serverId),
      status: activeCount > 0 ? 'running' : 'idle',
      taskCount: contextTasks.length,
      activeCount,
      firstSeen,
      lastSeen,
      streaming,
      live,
      ...(latest.serverId !== undefined ? { serverId: latest.serverId } : {}),
      ...(instance !== undefined ? { serverName: instance.name } : {}),
      ...(instance?.preset !== undefined ? { preset: instance.preset } : {}),
    }
    rows.push(row)
  }
  // Most recently active first, matching the peer table ordering.
  return rows.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
}