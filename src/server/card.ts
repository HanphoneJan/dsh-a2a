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
  type AgentExtension,
  type AgentInterface,
  type AgentSkill,
} from '../protocol.ts'
import { traceExtension } from './trace.ts'

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
  /** Advertised input media types; defaults to text/plain. */
  readonly inputModes?: readonly string[]
  /** Advertised output media types; defaults to text/plain. */
  readonly outputModes?: readonly string[]
  /** Advertise the optional trace extension (instance policy allows it). */
  readonly trace?: boolean
  /** Extra extensions to advertise alongside the built-in trace extension. */
  readonly extensions?: readonly AgentExtension[]
}

/** Assemble the AgentCard advertised by this DSH. */
export function buildCard(options: CardOptions): AgentCard {
  const iface: AgentInterface = {
    url: `${options.baseUrl.replace(/\/$/, '')}${options.endpointPath}`,
    protocolBinding: 'JSONRPC',
    protocolVersion: '1.0',
  }
  const extensions = [
    ...(options.trace === true ? [traceExtension()] : []),
    ...(options.extensions ?? []),
  ]
  return {
    name: options.name,
    description: options.description,
    version: options.version,
    provider: { url: 'https://deepseek.com', organization: 'DeepSeek' },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: true,
      stateTransitionHistory: false,
      ...(extensions.length > 0 ? { extensions } : {}),
    },
    defaultInputModes: [...(options.inputModes ?? ['text/plain'])],
    defaultOutputModes: [...(options.outputModes ?? ['text/plain'])],
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