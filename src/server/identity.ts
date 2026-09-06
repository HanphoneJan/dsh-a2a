/**
 * Service identity: the inbound AgentCard's name/description/version,
 * editable at runtime from the GUI dashboard and persisted in the `a2a`
 * domain's `identity` table. Skills stay derived from the live tool registry
 * (the "card derives from ctx.tools" design); identity editing builds a fresh
 * card preserving the endpoint URL and swaps it onto the server, so routes
 * and the facade see the new value immediately.
 * @module dsh-a2a/server/identity
 */

import { buildCard, type CardOptions } from './card.ts'
import type { AgentCard, AgentSkill } from '../protocol.ts'
import type { A2aDomain } from './store.ts'

/** Persisted service identity (only the card identity fields; skills derive). */
export interface A2aIdentity {
  readonly name: string
  readonly description: string
  readonly version: string
}

const IDENTITY_KEY = 'service'

function decode(raw: string | undefined): A2aIdentity | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<A2aIdentity>
    if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string' || typeof parsed.version !== 'string') {
      return undefined
    }
    return { name: parsed.name, description: parsed.description, version: parsed.version }
  } catch {
    return undefined
  }
}

function encode(value: A2aIdentity): string {
  return JSON.stringify(value)
}

/** Read the persisted identity (undefined when never configured). */
export function readIdentity(domain: A2aDomain): A2aIdentity | undefined {
  return decode(domain.identity.get(IDENTITY_KEY))
}

/** Persist a new identity (fire-and-forget like the task store writes). */
export function writeIdentity(domain: A2aDomain, identity: A2aIdentity): void {
  void domain.identity.put(IDENTITY_KEY, encode(identity)).catch((err: unknown) => {
    throw new Error(`a2a: identity persistence failed: ${String(err)}`)
  })
}

/**
 * Build the AgentCard options for a given base URL/path and the override
 * identity. `identity` (persisted) wins over the composition `defaults`; when
 * no identity is stored, the composition defaults stand.
 */
export function cardOptionsFor(
  baseUrl: string,
  endpointPath: string,
  defaults: { readonly name: string; readonly description: string; readonly version: string },
  identity: A2aIdentity | undefined,
  skills: readonly AgentSkill[],
  authToken?: string,
): CardOptions {
  return {
    baseUrl,
    endpointPath,
    name: identity?.name ?? defaults.name,
    description: identity?.description ?? defaults.description,
    version: identity?.version ?? defaults.version,
    skills,
    ...(authToken !== undefined ? { authToken } : {}),
  }
}

/**
 * Build a fresh AgentCard from an existing one plus a new identity and skill
 * list, preserving the endpoint URL (baseUrl/path) and security scheme.
 */
export function rebuildCardWithIdentity(card: AgentCard, identity: A2aIdentity, skills: readonly AgentSkill[]): AgentCard {
  return buildCard({
    baseUrl: endpointBaseOf(card),
    endpointPath: endpointPathOf(card),
    name: identity.name,
    description: identity.description,
    version: identity.version,
    skills,
    // Preserve the advertised scheme; buildCard only uses the presence (never
    // the value) to declare securitySchemes.
    ...(card.securitySchemes !== undefined ? { authToken: 'preserved-scheme' } : {}),
  })
}

function endpointBaseOf(card: AgentCard): string {
  const url = card.supportedInterfaces?.[0]?.url
  if (!url) return 'http://127.0.0.1'
  return url.replace(/\/[^/]*$/, '')
}

function endpointPathOf(card: AgentCard): string {
  const url = card.supportedInterfaces?.[0]?.url
  if (!url) return '/a2a'
  try {
    return new URL(url).pathname
  } catch {
    return '/a2a'
  }
}