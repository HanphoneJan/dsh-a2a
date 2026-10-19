/**
 * `/a2a` command parsing: create verbs consume the first argument as the real
 * name/URL (the `id` slot), not as a discarded token. Regression coverage for
 * the 0.3.7 parser bug that required a `_` placeholder.
 * @module dsh-a2a/tests/unit/commands.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { buildA2aCommand } from '../../src/commands.ts'
import type { A2AServiceImpl } from '../../src/service.ts'

function stubImpl() {
  return {
    createInboundServer: vi.fn(async () => ({ ok: true, message: 'created' })),
    createOutboundServer: vi.fn(async () => ({ ok: true, message: 'connected' })),
  } as unknown as A2AServiceImpl
}

async function run(impl: A2AServiceImpl, rawInput: string) {
  const command = buildA2aCommand(impl)
  return command.handler({ rawInput } as never)
}

describe('/a2a create parsing', () => {
  it('inbound create uses the first argument as the name', async () => {
    const impl = stubImpl()
    const result = await run(impl, 'inbound create reports standard Reporting agent')
    expect(result).toEqual({ kind: 'success', text: 'created' })
    expect(impl.createInboundServer).toHaveBeenCalledWith({
      name: 'reports',
      description: 'Reporting agent',
      version: '1.0.0',
      preset: 'standard',
    })
  })

  it('inbound create defaults description and omits an absent preset', async () => {
    const impl = stubImpl()
    await run(impl, 'inbound create reports')
    expect(impl.createInboundServer).toHaveBeenCalledWith({
      name: 'reports',
      description: 'An A2A inbound server',
      version: '1.0.0',
    })
  })

  it('inbound create omits the literal default preset', async () => {
    const impl = stubImpl()
    await run(impl, 'inbound create reports default')
    expect(impl.createInboundServer).toHaveBeenCalledWith({
      name: 'reports',
      description: 'An A2A inbound server',
      version: '1.0.0',
    })
  })

  it('inbound create without a name is a usage error', async () => {
    const impl = stubImpl()
    const result = await run(impl, 'inbound create')
    expect(result).toMatchObject({ kind: 'error' })
    expect(impl.createInboundServer).not.toHaveBeenCalled()
  })

  it('outbound create uses the first argument as the AgentCard URL', async () => {
    const impl = stubImpl()
    const url = 'https://remote.example/a2a/x/agent-card.json'
    const result = await run(impl, `outbound create ${url} remote standard`)
    expect(result).toEqual({ kind: 'success', text: 'connected' })
    expect(impl.createOutboundServer).toHaveBeenCalledWith({
      name: 'remote',
      agentCardUrl: url,
      preset: 'standard',
    })
  })

  it('outbound create defaults its name to the URL', async () => {
    const impl = stubImpl()
    const url = 'https://remote.example/a2a/x/agent-card.json'
    await run(impl, `outbound create ${url}`)
    expect(impl.createOutboundServer).toHaveBeenCalledWith({ name: url, agentCardUrl: url })
  })

  it('outbound create without a URL is a usage error', async () => {
    const impl = stubImpl()
    const result = await run(impl, 'outbound create')
    expect(result).toMatchObject({ kind: 'error' })
    expect(impl.createOutboundServer).not.toHaveBeenCalled()
  })
})
