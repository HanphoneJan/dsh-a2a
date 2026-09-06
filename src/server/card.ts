/**
 * AgentCard assembly for the inbound half: identity and skill DECLARATION at
 * the instance level. The skill list is exactly the creator-declared
 * `AgentSkill[]` stored on the inbound server instance — no derivation from
 * the live tool registry (the v0.2 white-list mechanism is removed). The
 * advertised card is a pure function of the instance record plus its base URL
 * and endpoint path.
 * @module dsh-a2a/server/card
 */

import {
  type AgentCard,
  type AgentInterface,
  type AgentSkill,
} from '../protocol.ts'

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
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: true, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: options.skills,
    supportedInterfaces: [iface],
    ...(options.authToken !== undefined
      ? {
        securitySchemes: {
          bearer: {
            httpAuthSecurityScheme: { scheme: 'bearer', description: 'Shared bearer token' },
          },
        },
        securityRequirements: [{ schemes: { bearer: { list: ['bearer'] } } }],
      }
      : {}),
  }
}