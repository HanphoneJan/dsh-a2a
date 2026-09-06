/**
 * AgentCard assembly unit tests: declared skill passthrough, endpoint join,
 * bearer security advertisement — the v1.0 declaration-driven card (the v0.2
 * tool white-list derivation no longer exists; see defaultSkillFor in the
 * inbound manager for the creator-empty default).
 * @module dsh-a2a/tests/unit/card.spec
 */

import { describe, expect, it } from 'vitest'
import { buildCard } from '../../src/server/card.ts'
import { defaultSkillFor } from '../../src/servers/inbound-manager.ts'

describe('defaultSkillFor (creator-empty declaration default)', () => {
  it('keeps declared skills untouched', () => {
    const declared = [{ id: 'code', name: 'Code', description: 'Write code' }]
    expect(defaultSkillFor(declared, 'ptc')).toEqual(declared)
  })

  it('defaults to the bound preset display name when skills are empty', () => {
    const skills = defaultSkillFor([], 'PTC 模式')
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ id: 'chat', name: 'PTC 模式' })
  })

  it('falls back to the built-in chat skill when there is no preset', () => {
    const skills = defaultSkillFor(undefined, undefined)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ id: 'chat', name: 'chat' })
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