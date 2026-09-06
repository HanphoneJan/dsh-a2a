/**
 * AgentCard derivation unit tests: explicit id-list filter, missing-referent
 * failure, built-in chat skill, and bearer security advertisement.
 * @module dsh-a2a/tests/unit/card.spec
 */

import { describe, expect, it } from 'vitest'
import { buildCard, deriveSkills, type ToolGetter } from '../../src/server/card.ts'

function fakeTools(get: Map<string, { description?: string }>): ToolGetter {
  return { get: (name) => get.get(name) }
}

describe('deriveSkills', () => {
  it('always includes the built-in chat skill first', () => {
    const skills = deriveSkills(fakeTools(new Map()), { ids: [], exclude: [] })
    expect(skills.map((s) => s.id)).toEqual(['chat'])
  })

  it('derives id-listed tools and applies excludes last', () => {
    const tools = fakeTools(new Map([
      ['tool_bash', { description: 'Run a command' }],
      ['tool_fs', {}],
    ]))
    const skills = deriveSkills(tools, { ids: ['tool_bash', 'tool_fs', 'tool_web'], exclude: ['tool_web'] })
    const ids = skills.map((s) => s.id)
    expect(ids).toEqual(['chat', 'tool_bash', 'tool_fs'])
    expect(skills.find((s) => s.id === 'tool_bash')?.description).toBe('Run a command')
  })

  it('fails loudly naming every unregistered id', () => {
    const tools = fakeTools(new Map([]))
    expect(() => deriveSkills(tools, { ids: ['missing_a', 'missing_b'], exclude: [] }))
      .toThrow(/missing_a, missing_b/)
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
})
