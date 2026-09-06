/**
 * Inbound connection registry: which remote peers are talking to this DSH's
 * A2A server. Fed by the A2A server's `onInbound` hook (every JSON-RPC
 * request / SSE open), surfaced through the dashboard API, and disconnectable
 * (`closePeer` cancels the peer's active tasks and drops the record).
 * @module dsh-a2a/server/inbound-registry
 */

/** One live inbound connection (observed peer). */
export interface InboundPeerRecord {
  /** Stable per-process id (random). */
  readonly id: string
  /** Short display label derived from the request source. */
  readonly label: string
  /** Source socket address, when visible ("127.0.0.1:54321"). */
  readonly source: string | null
  /** First-seen ISO timestamp. */
  readonly firstSeen: string
  /** Last-activity ISO timestamp. */
  readonly lastSeen: string
  /** Number of tasks this peer created or continued. */
  readonly taskCount: number
  /** Ids of tasks still running for this peer. */
  readonly activeTaskIds: readonly string[]
  /** True while at least one streaming (SSE) connection is open. */
  readonly streaming: boolean
}

/** Control and observation contract the dashboard API and facade use. */
export interface InboundRegistry {
  list(): readonly InboundPeerRecord[]
  /** Cancel a peer's active tasks and remove its record. */
  closePeer(peerId: string): { readonly ok: boolean; readonly message: string }
  /** Active task ids of one peer (the facade cancels them on close). */
  activeTasksOf(peerId: string): readonly string[]
}

/** Mutable tracking state behind one peer record. */
interface PeerState {
  readonly id: string
  readonly label: string
  readonly source: string | null
  readonly firstSeen: string
  lastSeen: string
  taskCount: number
  readonly active: Set<string>
  streamingCount: number
}

function newPeerId(): string {
  return `peer-${crypto.randomUUID()}`
}

/** In-memory inbound peer registry. */
export class LiveInboundRegistry implements InboundRegistry {
  private readonly peers = new Map<string, PeerState>()

  private findBySource(source: string | null): PeerState | undefined {
    if (source === null) return undefined
    for (const peer of this.peers.values()) {
      if (peer.source === source) return peer
    }
    return undefined
  }

  /** Observe one inbound event: method, source, task ids, streaming flag. */
  note(input: { readonly method: string; readonly source?: string; readonly taskIds: readonly string[]; readonly streaming: boolean }): void {
    const now = new Date().toISOString()
    const source = input.source ?? null
    let peer = this.findBySource(source)
    if (peer === undefined) {
      peer = {
        id: newPeerId(),
        label: source ?? 'unknown',
        source,
        firstSeen: now,
        lastSeen: now,
        taskCount: 0,
        active: new Set<string>(),
        streamingCount: 0,
      }
      this.peers.set(peer.id, peer)
    }
    peer.lastSeen = now
    peer.taskCount += input.taskIds.length
    for (const id of input.taskIds) peer.active.add(id)
    if (input.streaming) peer.streamingCount += 1
  }

  /** A task settled: drop it from every peer's active set. */
  settle(taskId: string): void {
    for (const peer of this.peers.values()) {
      if (peer.active.delete(taskId)) peer.lastSeen = new Date().toISOString()
    }
  }

  /** Decrement streaming count when an SSE connection closes. */
  endStream(source?: string): void {
    const peer = this.findBySource(source ?? null)
    if (peer !== undefined && peer.streamingCount > 0) {
      peer.streamingCount -= 1
      peer.lastSeen = new Date().toISOString()
    }
  }

  list(): readonly InboundPeerRecord[] {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      source: p.source,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
      taskCount: p.taskCount,
      activeTaskIds: [...p.active],
      streaming: p.streamingCount > 0,
    })).sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
  }

  closePeer(peerId: string): { readonly ok: boolean; readonly message: string } {
    const peer = this.peers.get(peerId)
    if (peer === undefined) return { ok: false, message: `inbound peer ${peerId} not found` }
    this.peers.delete(peerId)
    return { ok: true, message: `inbound peer ${peer.label} closed` }
  }

  activeTasksOf(peerId: string): readonly string[] {
    return [...(this.peers.get(peerId)?.active ?? [])]
  }
}