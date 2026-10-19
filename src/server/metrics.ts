/**
 * Structured observability for the A2A plugin: process-local counters plus a
 * bounded audit ring. Metrics answer "how many / how long / how many failed";
 * audit answers "who called what and what happened". Both are exposed through
 * the dashboard API and `ctx.a2a`; they are intentionally not a metrics backend
 * or a durable audit log.
 * @module dsh-a2a/server/metrics
 */

import { TaskState } from '../protocol.ts'

/** One bounded audit entry. */
export interface AuditEvent {
  readonly at: string
  readonly kind: string
  readonly serverId?: string
  readonly taskId?: string
  readonly method?: string
  readonly source?: string
  readonly detail?: string
}

/** Per-instance counters. */
export interface ServerMetrics {
  requests: number
  authFailures: number
  tasksCreated: number
  tasksCompleted: number
  tasksFailed: number
  tasksCanceled: number
  tasksInterrupted: number
  taskDurationMs: number
  outboundCalls: number
  outboundErrors: number
  outboundDurationMs: number
}

/** Whole-plugin metric snapshot. */
export interface MetricsSnapshot {
  readonly startedAt: string
  readonly uptimeMs: number
  readonly requests: number
  readonly authFailures: number
  readonly tasks: {
    readonly created: number
    readonly completed: number
    readonly failed: number
    readonly canceled: number
    readonly interrupted: number
    readonly avgDurationMs: number
    readonly maxDurationMs: number
  }
  readonly outbound: {
    readonly calls: number
    readonly errors: number
    readonly avgDurationMs: number
  }
  readonly byServer: Readonly<Record<string, ServerMetrics>>
  readonly audit: readonly AuditEvent[]
}

function emptyServer(): ServerMetrics {
  return {
    requests: 0,
    authFailures: 0,
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksCanceled: 0,
    tasksInterrupted: 0,
    taskDurationMs: 0,
    outboundCalls: 0,
    outboundErrors: 0,
    outboundDurationMs: 0,
  }
}

/** Process-local metrics and audit collector. */
export class A2aMetrics {
  private readonly startedAt = new Date()
  private readonly servers = new Map<string, ServerMetrics>()
  private readonly auditRing: AuditEvent[] = []
  private readonly maxAudit: number
  private totalRequests = 0
  private totalAuthFailures = 0
  private totalTasks = 0
  private totalCompleted = 0
  private totalFailed = 0
  private totalCanceled = 0
  private totalInterrupted = 0
  private totalTaskDuration = 0
  private maxTaskDuration = 0
  private totalOutboundCalls = 0
  private totalOutboundErrors = 0
  private totalOutboundDuration = 0

  constructor(maxAudit = 200) {
    this.maxAudit = maxAudit
  }

  private server(serverId: string | undefined): ServerMetrics | undefined {
    if (serverId === undefined) return undefined
    let metrics = this.servers.get(serverId)
    if (metrics === undefined) {
      metrics = emptyServer()
      this.servers.set(serverId, metrics)
    }
    return metrics
  }

  recordRequest(serverId: string | undefined, method: string, source?: string): void {
    this.totalRequests += 1
    const server = this.server(serverId)
    if (server !== undefined) server.requests += 1
    this.recordAudit({ kind: 'inbound.request', ...(serverId !== undefined ? { serverId } : {}), method, ...(source !== undefined ? { source } : {}) })
  }

  recordAuthFailure(serverId: string | undefined, method: string, source?: string): void {
    this.totalAuthFailures += 1
    const server = this.server(serverId)
    if (server !== undefined) server.authFailures += 1
    this.recordAudit({ kind: 'inbound.auth.failure', ...(serverId !== undefined ? { serverId } : {}), method, ...(source !== undefined ? { source } : {}) })
  }

  recordTaskCreated(serverId: string | undefined, taskId: string): void {
    this.totalTasks += 1
    const server = this.server(serverId)
    if (server !== undefined) server.tasksCreated += 1
    this.recordAudit({ kind: 'task.created', ...(serverId !== undefined ? { serverId } : {}), taskId })
  }

  recordTaskSettled(serverId: string | undefined, taskId: string, state: TaskState, durationMs: number): void {
    const server = this.server(serverId)
    if (server !== undefined) {
      if (state === TaskState.COMPLETED) server.tasksCompleted += 1
      else if (state === TaskState.FAILED) server.tasksFailed += 1
      else if (state === TaskState.CANCELED) server.tasksCanceled += 1
      else if (state === TaskState.INPUT_REQUIRED || state === TaskState.AUTH_REQUIRED) server.tasksInterrupted += 1
      server.taskDurationMs += durationMs
    }
    if (state === TaskState.COMPLETED) this.totalCompleted += 1
    else if (state === TaskState.FAILED) this.totalFailed += 1
    else if (state === TaskState.CANCELED) this.totalCanceled += 1
    else if (state === TaskState.INPUT_REQUIRED || state === TaskState.AUTH_REQUIRED) this.totalInterrupted += 1
    this.totalTaskDuration += durationMs
    this.maxTaskDuration = Math.max(this.maxTaskDuration, durationMs)
    this.recordAudit({ kind: 'task.settled', ...(serverId !== undefined ? { serverId } : {}), taskId, detail: `${state} in ${durationMs}ms` })
  }

  recordOutbound(serverId: string | undefined, skill: string, ok: boolean, durationMs: number, error?: string): void {
    this.totalOutboundCalls += 1
    this.totalOutboundDuration += durationMs
    if (!ok) this.totalOutboundErrors += 1
    const server = this.server(serverId)
    if (server !== undefined) {
      server.outboundCalls += 1
      server.outboundDurationMs += durationMs
      if (!ok) server.outboundErrors += 1
    }
    this.recordAudit({
      kind: ok ? 'outbound.call' : 'outbound.error',
      ...(serverId !== undefined ? { serverId } : {}),
      detail: `${skill} in ${durationMs}ms${error !== undefined ? `: ${error}` : ''}`,
    })
  }

  recordAudit(event: Omit<AuditEvent, 'at'>): void {
    this.auditRing.push({ at: new Date().toISOString(), ...event })
    if (this.auditRing.length > this.maxAudit) this.auditRing.splice(0, this.auditRing.length - this.maxAudit)
  }

  snapshot(): MetricsSnapshot {
    const settled = this.totalCompleted + this.totalFailed + this.totalCanceled + this.totalInterrupted
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Date.now() - this.startedAt.getTime(),
      requests: this.totalRequests,
      authFailures: this.totalAuthFailures,
      tasks: {
        created: this.totalTasks,
        completed: this.totalCompleted,
        failed: this.totalFailed,
        canceled: this.totalCanceled,
        interrupted: this.totalInterrupted,
        avgDurationMs: settled === 0 ? 0 : Math.round(this.totalTaskDuration / settled),
        maxDurationMs: this.maxTaskDuration,
      },
      outbound: {
        calls: this.totalOutboundCalls,
        errors: this.totalOutboundErrors,
        avgDurationMs: this.totalOutboundCalls === 0 ? 0 : Math.round(this.totalOutboundDuration / this.totalOutboundCalls),
      },
      byServer: Object.fromEntries([...this.servers.entries()].map(([id, value]) => [id, { ...value }])),
      audit: [...this.auditRing],
    }
  }
}
