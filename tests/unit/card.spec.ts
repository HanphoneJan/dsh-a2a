/**
 * AgentCard assembly unit tests: declared skill passthrough, endpoint join,
 * bearer security advertisement, and preset-derived skill declaration — the
 * v1.0 "the preset decides its skills" model (derivePresetSkills in the
 * inbound manager).
 * @module dsh-a2a/tests/unit/card.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { buildCard } from '../../src/server/card.ts'
import { chatFallbackSkills, derivePresetSkills } from '../../src/servers/inbound-manager.ts'
import type { AgentPresetsLike, SkillRowLike, SkillsLike } from '../../src/server/exec/agent-runtime.ts'

function fakePresets(overrides: Partial<AgentPresetsLike> = {}): AgentPresetsLike {
  const scope = { agentPreset: 'standard' }
  return {
    resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard', name: '标准模式' })),
    mount: vi.fn(async () => undefined),
    standingKeyFor: vi.fn(async (id?: string) => (id === undefined ? scope : { agentPreset: id })),
    ...overrides,
  }
}

function fakeSkills(rows: readonly SkillRowLike[]): SkillsLike {
  return { list: vi.fn(async () => rows) }
}

describe('derivePresetSkills (preset-derived declarations, "everything is a plugin")', () => {
  it('advertises model-invocable catalogue entries of the preset scope', async () => {
    const skills = fakeSkills([
      { name: 'web-search', description: 'Search the web', invocation: { modelInvocable: true } },
      { name: 'bash', description: 'Run a command' },
      { name: 'internal', description: 'hidden', invocation: { modelInvocable: false } },
    ])
    const derived = await derivePresetSkills(fakePresets(), skills, 'standard')
    expect(derived.map((s) => s.id)).toEqual(['web-search', 'bash'])
    expect(derived[0]).toMatchObject({ id: 'web-search', name: 'web-search', description: 'Search the web' })
  })

  it('falls back to the built-in chat skill without a skills service', async () => {
    const derived = await derivePresetSkills(fakePresets(), undefined, 'standard')
    expect(derived).toEqual(chatFallbackSkills())
  })

  it('falls back to chat when the catalogue is empty or the mount fails', async () => {
    expect(await derivePresetSkills(fakePresets(), fakeSkills([]), 'standard')).toEqual(chatFallbackSkills())
    const broken = fakePresets({
      standingKeyFor: vi.fn(async () => { throw new Error('preset broken') }),
    })
    expect(await derivePresetSkills(broken, fakeSkills([{ name: 'x', description: 'd' }]), 'standard')).toEqual(chatFallbackSkills())
  })

  it('falls back to chat when the preset roster offers no standing mount', async () => {
    const derived = await derivePresetSkills(fakePresets({ standingKeyFor: undefined }), fakeSkills([{ name: 'x', description: 'd' }]), 'standard')
    expect(derived).toEqual(chatFallbackSkills())
  })
})

describe('buildCard', () => {
  const base = {
    baseUrl: 'http://127.0.0.1:3000/',
    endpointPath: '/a2a',
    name: 'My Agent',
    description: 'desc',
    version: '0.1.0',
    skills: [{ id: 'chat' }],
  }

  it('joins baseUrl and endpointPath without a double slash', () => {
    const card = buildCard(base)
    expect(card.supportedInterfaces?.[0]?.url).toBe('http://127.0.0.1:3000/a2a')
  })

  it('advertises no security schemes without auth', () => {
    const card = buildCard(base)
    expect(card.securitySchemes).toBeUndefined()
    expect(card.securityRequirements).toBeUndefined()
  })

  it('advertises a bearer scheme when auth is configured', () => {
    const card = buildCard({ ...base, authToken: 'secret' })
    // Official AgentCard security object shape (§8 sample + §4.5).
    expect(card.securitySchemes?.bearer).toMatchObject({
      httpAuthSecurityScheme: { scheme: 'bearer', description: 'Shared bearer token' },
    })
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: ['bearer'] } } }])
  })

  it('carries the declared skills verbatim onto the card', () => {
    const skills = [{ id: 'code', name: 'Code', description: 'Write code', tags: ['dev'] }]
    const card = buildCard({ ...base, skills })
    expect(card.skills).toEqual(skills)
  })
})