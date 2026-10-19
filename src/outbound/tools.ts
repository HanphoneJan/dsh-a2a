/**
 * Outbound half: register one remote agent's skills as model-facing tools on
 * `ctx.tools`. Tool names are `a2a__<agent>__<skill>` normalized to the DSH
 * function-name contract (≤64 chars, collision hash), mirroring the naming
 * rule of dsh-mcp-client. An agent advertising zero skills registers nothing.
 * Each tool propagates the caller's abort signal, streams the remote turn when
 * the remote supports it, and exposes an optional taskId so an interrupted
 * remote task can be continued.
 * @module dsh-a2a/outbound/tools
 */

import { Role, partsToText, type AgentSkill, type Message, type Part, type StreamResponse, type Task } from '../protocol.ts'
import { A2AError, type A2AClient } from './calls.ts'
import type { A2aMetrics } from '../server/metrics.ts'

/** Structural slice of `ctx.tools` used for registration. */
export interface ToolRegistrar {
  register(definition: unknown): (() => void) | void
}

/** Optional per-skill presentation overrides. */
export interface SkillOverride {
  readonly name?: string
  readonly description?: string
}

export interface AgentToolsOptions {
  readonly agentName: string
  readonly client: A2AClient
  /** Tool prefix; default 'a2a'. */
  readonly toolPrefix?: string
  /**
   * Resolve the remote conversation contextId for one calling local agent
   * (stable per caller, so multi-turn tool use is one remote conversation).
   */
  readonly contextFor: (agentId: string | undefined) => string
  /** Skill ids that must not be registered as tools. */
  readonly disabledSkills?: readonly string[]
  /** Per-skill name/description overrides. */
  readonly skillOverrides?: Readonly<Record<string, SkillOverride>>
  /** Stable outbound instance id for metrics/audit. */
  readonly serverId?: string
  readonly metrics?: A2aMetrics
}

export interface RegisteredTool {
  readonly name: string
  dispose(): void
}

function normalizeToolName(raw: string): string {
  const norm = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  if (norm.length > 0 && /^[A-Za-z0-9_-]+$/.test(norm)) return norm
  let hash = 0
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0
  return `_${hash.toString(16)}`
}

/** Register one tool per advertised skill; empty skills register nothing. */
export function registerAgentTools(registrar: ToolRegistrar, opts: AgentToolsOptions): RegisteredTool[] {
  const prefix = opts.toolPrefix ?? 'a2a'
  const disabled = new Set(opts.disabledSkills ?? [])
  const skills = (opts.client.card.skills ?? []).filter((skill) => !disabled.has(skill.id))
  const out: RegisteredTool[] = []
  for (const skill of skills) {
    const override = opts.skillOverrides?.[skill.id]
    const raw = `${prefix}__${opts.agentName}__${skill.id}`
    const name = normalizeToolName(raw)
    let toolName = name
    if (out.some((t) => t.name === toolName)) {
      let hash = 0
      for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0
      toolName = `${name.slice(0, 56)}_${hash.toString(16)}`
    }
    const dispose = registrar.register(makeTool(toolName, opts, skill, override))
    if (dispose) out.push({ name: toolName, dispose })
  }
  return out
}

function makeTool(
  name: string,
  opts: AgentToolsOptions,
  skill: Pick<AgentSkill, 'id' | 'name' | 'description' | 'examples'>,
  override: SkillOverride | undefined,
): unknown {
  const description = [
    override?.description ?? skill.description,
    ...(skill.examples?.length ? [`Examples: ${skill.examples.join(' | ')}`] : []),
  ].filter(Boolean).join('\n')

  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task or instruction to send to the remote agent.',
        },
        taskId: {
          type: 'string',
          description: 'Continue an existing interrupted remote task (use the id reported by a previous INPUT_REQUIRED/AUTH_REQUIRED result).',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { prompt: string; taskId?: string }, exec: { signal?: AbortSignal; agent?: { id?: string } }): Promise<string> {
      const contextId = opts.contextFor(exec.agent?.id)
      const message: Message = {
        messageId: crypto.randomUUID(),
        role: Role.USER,
        ...(args.taskId !== undefined && args.taskId.length > 0
          ? { taskId: args.taskId }
          : { contextId }),
        parts: [{ text: args.prompt }],
      }
      const started = Date.now()
      try {
        const task = await opts.client.sendMessage(message, {
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
          stream: true,
          onEvent: (_frame: StreamResponse) => { /* the tool returns final text */ },
        })
        opts.metrics?.recordOutbound(opts.serverId, skill.id, true, Date.now() - started)
        return textOf(task)
      } catch (err) {
        opts.metrics?.recordOutbound(opts.serverId, skill.id, false, Date.now() - started, (err as Error).message)
        throw err
      }
    },
  }
}

/** Render a settled/interrupted task as tool text (INPUT_REQUIRED surfaced, not thrown). */
function textOf(task: Task): string {
  const output = partsToText(task.artifacts?.flatMap((a) => a.parts ?? []))
  if (task.status.state === 'TASK_STATE_FAILED') {
    throw new A2AError(-32000, `Remote agent task failed: ${output || partsToText(task.status.message?.parts) || 'no detail'}`)
  }
  if (task.status.state === 'TASK_STATE_INPUT_REQUIRED' || task.status.state === 'TASK_STATE_AUTH_REQUIRED') {
    const ask = partsToText(task.status.message?.parts) || output || 'agent awaits input'
    return `[remote agent ${task.status.state} task=${task.id}] ${ask}`
  }
  return output || '(remote agent returned no output)'
}

export type { Part }
