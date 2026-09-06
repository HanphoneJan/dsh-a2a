/**
 * Outbound half: register one remote agent's skills as model-facing tools on
 * `ctx.tools`. Tool names are `a2a__<agent>__<skill>` normalized to the DSH
 * function-name contract (≤64 chars, collision hash), mirroring the naming
 * rule of dsh-mcp-client. An agent advertising zero skills registers nothing.
 * @module dsh-a2a/client/tools
 */

import { Role, partsToText, type AgentSkill, type Message, type Part } from '../protocol.ts'
import { A2AError, type A2AClient } from './calls.ts'

/** Structural slice of `ctx.tools` used for registration. */
export interface ToolRegistrar {
  register(definition: unknown): (() => void) | void
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
  const skills = opts.client.card.skills ?? []
  const out: RegisteredTool[] = []
  for (const skill of skills) {
    const raw = `${prefix}__${opts.agentName}__${skill.id}`
    const name = normalizeToolName(raw)
    let toolName = name
    if (out.some((t) => t.name === toolName)) {
      let hash = 0
      for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0
      toolName = `${name.slice(0, 56)}_${hash.toString(16)}`
    }
    const dispose = registrar.register(makeTool(toolName, opts.client, skill, opts.contextFor))
    if (dispose) out.push({ name: toolName, dispose })
  }
  return out
}

function makeTool(
  name: string,
  client: A2AClient,
  skill: Pick<AgentSkill, 'id' | 'name' | 'description' | 'examples'>,
  contextFor: (agentId: string | undefined) => string,
): unknown {
  const description = [
    skill.description,
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
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { prompt: string }, exec: { signal?: AbortSignal; agent?: { id?: string } }): Promise<string> {
      const message: Message = {
        messageId: crypto.randomUUID(),
        role: Role.USER,
        contextId: contextFor(exec.agent?.id),
        parts: [{ text: args.prompt }],
      }
      const task = await client.sendMessage(message)
      return textOf(task.artifacts, task.status.state, task.status.message?.parts)
    },
  }
}

/** Render a settled task's output as tool text (INPUT_REQUIRED surfaced, not thrown). */
function textOf(
  artifacts: readonly { readonly parts?: readonly Part[] }[] | undefined,
  state: string,
  statusParts: readonly Part[] | undefined,
): string {
  const output = partsToText(artifacts?.flatMap((a) => a.parts ?? []))
  if (state === 'FAILED') {
    throw new A2AError(-32000, `Remote agent task failed: ${output || partsToText(statusParts) || 'no detail'}`)
  }
  if (state === 'INPUT_REQUIRED' || state === 'AUTH_REQUIRED') {
    const ask = partsToText(statusParts) || output || 'agent awaits input'
    return `[remote agent ${state}] ${ask}`
  }
  return output || '(remote agent returned no output)'
}