/**
 * Shared agent machinery for the inbound executors: one DSH agent session per
 * A2A context (create, or resume a persisted one), serialized turns, and
 * optional agent-preset composition so a spawned session actually carries
 * tools. Adapted from the createDshAgentExecutor pattern pioneered by
 * dsh-a2a (MIT).
 * @module dsh-a2a/server/exec/agent-runtime
 */

import type { Context } from '@deepseek-ai/cordis'

/** The slice of a live DSH `Agent` this runtime drives (structural mirror). */
export interface LiveAgent {
  readonly session: { deriveMessages(): readonly AgentMessage[] }
  send(message: AgentUserMessage, target: 'next-turn', wakeup: boolean): void
  whenIdle(): Promise<void>
  cancel(cause: string): void
}

/** One derived history message. */
export interface AgentMessage {
  readonly role: 'user' | 'assistant'
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** One user message handed to the agent. */
export interface AgentUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: { readonly kind: 'plugin'; readonly plugin: string }
}

/** Owned agent plus its capability disposer (structural mirror of AgentHandle). */
export interface AgentHandle {
  readonly agent: LiveAgent
  dispose(): Promise<void>
}

/** Structural slice of `ctx.agents` this runtime calls. */
export interface AgentRegistryLike {
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
    readonly agentOptions?: { readonly provider?: string; readonly model?: string; readonly maxTokens?: number }
    readonly setup?: (agentCtx: unknown) => void | Promise<void>
  }): Promise<AgentHandle>
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: { readonly provider?: string; readonly model?: string; readonly maxTokens?: number }
    readonly setup?: (agentCtx: unknown) => void | Promise<void>
  }): Promise<AgentHandle>
}

/** Structural slice of `ctx.agentPresets` (preset roster). */
export interface AgentPresetsLike {
  resolve(id?: string): Promise<{ readonly id: string; readonly name?: string }>
  mount(agentCtx: unknown, id: string): Promise<unknown>
  /** Standing scope key of a preset's mount (no agent required; undefined = default preset). */
  standingKeyFor?(id?: string): Promise<unknown>
}

/** One skill-catalogue row as `ctx.skills.list()` returns it. */
export interface SkillRowLike {
  readonly name: string
  readonly description?: string
  readonly whenToUse?: string
  readonly invocation?: { readonly modelInvocable?: boolean }
}

/** Structural slice of `ctx.skills` (the skill registry). */
export interface SkillsLike {
  list(options: { readonly scope?: unknown }): Promise<readonly SkillRowLike[]>
}

/** Structural slice of `ctx.credentials` (env-var-name credential refs). */
export interface CredentialsLike {
  /** Resolve one env-var name to its current value (layered, per call). */
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
  /** Store/overwrite a value for an env-var name in the managed layer. */
  set(ref: string, value: string): Promise<void>
  /** Clear a stored value for an env-var name. */
  unset(ref: string): Promise<void>
}

/** Runtime options shared by the executors. */
export interface AgentRuntimeOptions {
  /** Absolute cwd frozen into each spawned session's durable header. */
  readonly cwd: string
  /** Optional per-task model resolution (reads the deployment default). */
  readonly resolveAgentOptions?: () => { readonly provider?: string; readonly model?: string; readonly maxTokens?: number } | undefined
  /** Preset roster; when present every spawned session joins the default preset. */
  readonly agentPresets?: AgentPresetsLike
  /** When set, every spawned session joins THIS preset id instead of the deployment default. */
  readonly presetId?: () => string | undefined
  /** Once-per-context hook after the first prompt lands (cosmetic naming). */
  readonly onSessionOpened?: (info: { readonly sessionId: string; readonly contextId: string; readonly firstPrompt: string }) => void | Promise<void>
}

/**
 * Per-context session pool: one live DSH agent per A2A contextId, created or
 * resumed through the registry, turns serialized per context, every session
 * disposeable on teardown.
 */
export class ContextSessionPool {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly agents: AgentRegistryLike,
    private readonly opts: AgentRuntimeOptions,
  ) {}

  /** Session id derived from the A2A context id (stable across restarts). */
  static sessionIdFor(contextId: string): string {
    return `a2a-${contextId}`
  }

  /** Get or open the live agent for a context; errors propagate. */
  async agentFor(contextId: string): Promise<{ readonly agent: LiveAgent; readonly sessionId: string; readonly justOpened: boolean }> {
    const sessionId = ContextSessionPool.sessionIdFor(contextId)
    const existing = this.handles.get(contextId)
    if (existing !== undefined) return { agent: existing.agent, sessionId, justOpened: false }
    const agentOptions = this.opts.resolveAgentOptions?.()
    const withModel = agentOptions ? { agentOptions } : {}
    const presets = this.opts.agentPresets
    let presetId: string | undefined
    let setup: ((agentCtx: unknown) => Promise<void>) | undefined
    if (presets !== undefined) {
      const wanted = this.opts.presetId?.() ?? undefined
      presetId = (wanted !== undefined ? await presets.resolve(wanted) : await presets.resolve()).id
      setup = async (agentCtx: unknown): Promise<void> => {
        await presets.mount(agentCtx, presetId!)
      }
    }
    const meta: { readonly cwd: string; readonly agentPreset?: string } = presetId
      ? { cwd: this.opts.cwd, agentPreset: presetId }
      : { cwd: this.opts.cwd }
    const createOptions = {
      sessionId,
      meta,
      ...withModel,
      ...(setup ? { setup } : {}),
    }
    let handle: AgentHandle
    try {
      handle = await this.agents.create(createOptions)
    } catch (err) {
      if (/already (has|owns)|persisted/i.test((err as Error).message)) {
        handle = await this.agents.resume({ resumeSessionId: sessionId, ...withModel, ...(setup ? { setup } : {}) })
      } else {
        throw err
      }
    }
    this.handles.set(contextId, handle)
    return { agent: handle.agent, sessionId, justOpened: true }
  }

  /** Run one turn on a context's session, serialized behind its tail. */
  async runTurn(contextId: string, prompt: string, signal: AbortSignal): Promise<string> {
    const { agent, sessionId, justOpened } = await this.agentFor(contextId)
    const onAbort = (): void => agent.cancel('a2a-canceled')
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const userMessage: AgentUserMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'a2a' },
    }
    agent.send(userMessage, 'next-turn', true)
    if (justOpened) {
      try {
        await this.opts.onSessionOpened?.({ sessionId, contextId, firstPrompt: prompt })
      } catch {
        // Cosmetic naming must never fail the task.
      }
    }
    await agent.whenIdle()
    return lastAssistantText(agent)
  }

  /** Dispose every live per-context session (called on plugin unload). */
  async disposeAll(): Promise<void> {
    const live = [...this.handles.values()]
    const pending = [...this.tails.values()]
    this.handles.clear()
    this.tails.clear()
    await Promise.allSettled(pending)
    await Promise.allSettled(live.map((h) => h.dispose()))
  }
}

/** Read the last assistant message's text off the derived history. */
function lastAssistantText(agent: LiveAgent): string {
  const history = agent.session.deriveMessages()
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    if (message === undefined) continue
    if (message.role === 'assistant') {
      return message.content
        .map((b) => ('text' in b && typeof b.text === 'string' ? (b.text ?? '') : ''))
        .filter(Boolean)
        .join('\n')
        .trim()
    }
  }
  return ''
}

/**
 * Probe for a readable service method via the reflection layer WITHOUT taking
 * an inject dependency (optional services). Returns undefined when the service
 * is absent or the method missing.
 */
export function probeService(ctx: Context, name: string, method: string): unknown {
  try {
    const reflect = (ctx as unknown as { reflect?: { get(n: string, strict?: boolean): unknown } }).reflect
    const svc = reflect?.get(name, true)
    if (svc !== undefined && svc !== null && typeof (svc as Record<string, unknown>)[method] === 'function') return svc
  } catch {
    // reflection unavailable or resolution threw — treat as absent
  }
  return undefined
}