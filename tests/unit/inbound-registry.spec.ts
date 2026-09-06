/**
 * Inbound registry unit tests: peer tracking (first/last seen, task counts,
 * streaming), settlement, and closePeer.
 * @module dsh-a2a/tests/unit/inbound-registry.spec
 */

import { describe, expect, it } from 'vitest'
import { LiveInboundRegistry } from '../../src/server/inbound-registry.ts'

describe('LiveInboundRegistry', () => {
  it('tracks a peer from a source address and accumulates task counts', () => {
    const registry = new LiveInboundRegistry()
    registry.note({ method: 'SendMessage', source: '127.0.0.1:55001', taskIds: ['a2a-1'], streaming: false })
    registry.note({ method: 'GetTask', source: '127.0.0.1:55001', taskIds: ['a2a-1'], streaming: false })
    const peers = registry.list()
    expect(peers).toHaveLength(1)
    expect(peers[0]!.source).toBe('127.0.0.1:55001')
    expect(peers[0]!.taskCount).toBe(2)
    expect(peers[0]!.activeTaskIds).toEqual(['a2a-1'])
    expect(peers[0]!.firstSeen).toBeDefined()
    expect(peers[0]!.lastSeen).toBeDefined()
  })

  it('marks a peer streaming while SSE connections are open', () => {
    const registry = new LiveInboundRegistry()
    registry.note({ method: 'SendStreamingMessage', source: '::1:443', taskIds: ['a2a-2'], streaming: true })
    expect(registry.list()[0]!.streaming).toBe(true)
    registry.endStream('::1:443')
    expect(registry.list()[0]!.streaming).toBe(false)
  })

  it('removes settled tasks from the active set', () => {
    const registry = new LiveInboundRegistry()
    registry.note({ method: 'SendMessage', source: '127.0.0.1:9', taskIds: ['a2a-3'], streaming: false })
    registry.settle('a2a-3')
    expect(registry.list()[0]!.activeTaskIds).toEqual([])
  })

  it('closePeer removes the record and reports which tasks it had', () => {
    const registry = new LiveInboundRegistry()
    registry.note({ method: 'SendMessage', source: '127.0.0.1:8080', taskIds: ['a2a-4'], streaming: false })
    const id = registry.list()[0]!.id
    expect(registry.activeTasksOf(id)).toEqual(['a2a-4'])
    const result = registry.closePeer(id)
    expect(result.ok).toBe(true)
    expect(registry.list()).toEqual([])
    expect(registry.closePeer(id).ok).toBe(false)
  })

  it('groups different sources as separate peers', () => {
    const registry = new LiveInboundRegistry()
    registry.note({ method: 'SendMessage', source: '10.0.0.1:1', taskIds: ['t1'], streaming: false })
    registry.note({ method: 'SendMessage', source: '10.0.0.2:2', taskIds: ['t2'], streaming: false })
    expect(registry.list()).toHaveLength(2)
  })
})