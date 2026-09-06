/**
 * AgentCard assembly for the inbound half: skills are DERIVED from the live
 * tool registry by an explicit id list (never invented), plus a built-in
 * `chat` skill so a fresh install is immediately exercisable end-to-end.
 * @module dsh-a2a/server/card
 */

import {
  type AgentCard,
  type AgentInterface,
  type AgentSkill,
} from '../protocol.ts'

/** Structural slice of `ctx.tools` used for derivation. */
export interface ToolGetter {
  get(name: string): { readonly name: string; readonly description?: string } | undefined
}

/** Derivation policy for inbound skills. */
export interface CardSkillPolicy {
  /** Tool ids (as registered on ctx.tools) exposed as inbound skills. */
  readonly ids: readonly string[]
  /** Ids to remove after derivation (defense in depth). */
  readonly exclude: readonly string[]
}

/**
 * Derive the inbound skill list from the live tool registry.
 *
 * Every configured id must resolve to a registered tool — a missing referent
 * fails the derivation loudly (the plugin's misconfiguration contract) with
 * all missing ids listed. The built-in `chat` skill is always present so the
 * server answers before any tool is exposed.
 *
 * @param tools - the tool registry getter.
 * @param policy - explicit-id derivation policy.
 * @returns the derived skills, `chat` first, configured tools after, excludes applied.
 */
export function deriveSkills(tools: ToolGetter, policy: CardSkillPolicy): AgentSkill[] {
  const excluded = new Set(policy.exclude)
  const skills: AgentSkill[] = [
    {
      id: 'chat',
      name: 'chat',
      description: 'Conversational assistance over a DSH agent session.',
      tags: ['chat'],
    },
  ]
  const missing: string[] = []
  for (const id of policy.ids) {
    if (excluded.has(id)) continue
    const tool = tools.get(id)
    if (tool === undefined) {
      missing.push(id)
      continue
    }
    skills.push({
      id,
      name: id,
      description: tool.description ?? `Expose the DSH tool \`${id}\` over A2A.`,
      tags: ['tool'],
    })
  }
  if (missing.length > 0) {
    throw new Error(`dsh-a2a: server.skills.ids reference unregistered tools: ${missing.join(', ')}`)
  }
  return skills
}

/** Identity options for the advertised AgentCard. */
export interface CardOptions {
  readonly baseUrl: string
  readonly endpointPath: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly skills: readonly AgentSkill[]
  /** Present when inbound bearer auth is configured (env-resolved). */
  readonly authToken?: string
}

/** Assemble the AgentCard advertised by this DSH. */
export function buildCard(options: CardOptions): AgentCard {
  const iface: AgentInterface = {
    url: `${options.baseUrl.replace(/\/$/, '')}${options.endpointPath}`,
    protocolBinding: 'JSONRPC',
    protocolVersion: '1.0',
  }
  return {
    name: options.name,
    description: options.description,
    version: options.version,
    provider: { url: 'https://deepseek.com', organization: 'DeepSeek' },
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: options.skills,
    supportedInterfaces: [iface],
    ...(options.authToken !== undefined
      ? {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Shared bearer token' } },
        securityRequirements: [{ bearerAuth: [] }],
      }
      : {}),
  }
}