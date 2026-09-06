/**
 * Executor abstraction for inbound tasks: an executor turns one task into
 * output parts while reporting status and artifact updates. The registry is
 * INTERNAL (built by the plugin from config) — public registration was cut:
 * there is no external caller yet, so the seam stays an interface with two
 * built-in implementations (session, subagent).
 * @module dsh-a2a/server/executor
 */

import type { Part, TaskState } from '../protocol.ts'

/** One update from a running executor. */
export type A2aExecutorEvent =
  | { readonly type: 'status'; readonly state: TaskState; readonly message?: string }
  | { readonly type: 'artifact'; readonly artifactId: string; readonly parts: readonly Part[]; readonly name?: string; readonly lastChunk?: boolean }

/** Input a task executor receives. */
export interface A2aExecutorInput {
  readonly taskId: string
  readonly contextId: string
  readonly skill: string
  readonly prompt: string
  readonly signal: AbortSignal
}

/** Output contract of one executor run. */
export interface A2aExecutorOutput {
  readonly parts: readonly Part[]
}

/** One inbound task executor. */
export interface A2aExecutor {
  /** Stable kind name ('session' | 'subagent'). */
  readonly name: string
  /**
   * Run one task. The executor reports progress through `opts.onEvent` and
   * must honor `opts.signal` (cancel = abort remaining work).
   */
  execute(input: A2aExecutorInput, opts: { readonly onEvent: (ev: A2aExecutorEvent) => void }): Promise<A2aExecutorOutput>
  /** Dispose resources owned by the executor (sessions, children). */
  disposeAll?(): Promise<void>
}

/** Executor kind names configurable per skill. */
export type ExecutorKind = 'session' | 'subagent'

/**
 * Skill → executor resolution. The subagent executor is absent on
 * compositions without the subagent seam; resolving a skill bound to a
 * missing kind fails loudly with a readable message.
 */
export class ExecutorSet {
  constructor(
    private readonly bySkill: Readonly<Record<string, ExecutorKind>>,
    private readonly session: A2aExecutor,
    private readonly subagent: A2aExecutor | undefined,
  ) {}

  resolve(skill: string): A2aExecutor {
    const kind = this.bySkill[skill] ?? 'session'
    if (kind === 'session') return this.session
    const subagent = this.subagent
    if (subagent === undefined) {
      throw new Error(`a2a: skill "${skill}" is bound to the subagent executor but no subagent seam is mounted`)
    }
    return subagent
  }

  async disposeAll(): Promise<void> {
    await this.session.disposeAll?.()
    await this.subagent?.disposeAll?.()
  }
}