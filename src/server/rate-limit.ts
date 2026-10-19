/**
 * Small in-memory rate limiter for one inbound A2A instance. Sliding-window
 * counters keyed by request source (or a stable fallback) keep a public
 * endpoint from being flooded and are intentionally process-local: this plugin
 * has no distributed quota store.
 * @module dsh-a2a/server/rate-limit
 */

export interface RateLimitDecision {
  readonly ok: boolean
  /** Milliseconds until the caller may retry; zero when allowed. */
  readonly retryAfterMs: number
}

/** Sliding-window request limiter. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): RateLimitDecision {
    if (this.limit <= 0) return { ok: true, retryAfterMs: 0 }
    const cutoff = now - this.windowMs
    const previous = this.hits.get(key) ?? []
    const recent = previous.filter((at) => at > cutoff)
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now
      this.hits.set(key, recent)
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.windowMs - now) }
    }
    recent.push(now)
    this.hits.set(key, recent)
    // Opportunistic cleanup: bounded by the number of live callers in a window.
    if (this.hits.size > 1024) {
      for (const [entry, times] of this.hits) {
        if (times.every((at) => at <= cutoff)) this.hits.delete(entry)
      }
    }
    return { ok: true, retryAfterMs: 0 }
  }
}
