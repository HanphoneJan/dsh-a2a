/**
 * Identity unit tests: persisted-identity read/write + card rebuild preserves
 * the endpoint URL and security scheme while swapping name/description/version.
 * @module dsh-a2a/tests/unit/identity.spec
 */

import { describe, expect, it } from 'vitest'
import { buildCard } from '../../src/server/card.ts'
import { rebuildCardWithIdentity } from '../../src/server/identity.ts'

function sampleCard() {
  return buildCard({
    baseUrl: 'http://127.0.0.1:3080',
    endpointPath: '/a2a',
    name: 'Old Name',
    description: 'Old description',
    version: '0.1.0',
    skills: [{ id: 'chat', name: 'chat', description: 'built-in' }],
    authToken: 'secret',
  })
}

describe('rebuildCardWithIdentity', () => {
  it('swaps identity fields and keeps the endpoint URL', () => {
    const card = sampleCard()
    const rebuilt = rebuildCardWithIdentity(card, { name: 'New Name', description: 'New description', version: '0.2.0' }, card.skills ?? [])
    expect(rebuilt.name).toBe('New Name')
    expect(rebuilt.description).toBe('New description')
    expect(rebuilt.version).toBe('0.2.0')
    expect(rebuilt.supportedInterfaces?.[0]?.url).toBe('http://127.0.0.1:3080/a2a')
    expect(rebuilt.skills?.map((s) => s.id)).toEqual(['chat'])
  })

  it('preserves the security scheme when present', () => {
    const card = sampleCard()
    const rebuilt = rebuildCardWithIdentity(card, { name: 'X', description: 'D', version: '1.0.0' }, [])
    expect(rebuilt.securitySchemes).toBeDefined()
    expect(rebuilt.securityRequirements).toBeDefined()
  })

  it('drops the scheme when the source card had none', () => {
    const plain = buildCard({
      baseUrl: 'http://127.0.0.1:3080',
      endpointPath: '/a2a',
      name: 'n', description: 'd', version: '1',
      skills: [],
    })
    const rebuilt = rebuildCardWithIdentity(plain, { name: 'X', description: 'D', version: '1.0.0' }, [])
    expect(rebuilt.securitySchemes).toBeUndefined()
  })
})