/**
 * Compile-time mirror check.
 *
 * `src/server/exec/agent-runtime.ts` deliberately declares structural mirrors
 * of the harness runtime types instead of importing them, so a change to the
 * host contract cannot be caught by the ordinary build. This file closes that
 * gap for the part that shipped a runtime bug: the inbound message's `source`.
 *
 * The v4 session codec refuses the retired shared `plugin` source kind, and
 * the only place that was visible was the durable encoder at runtime. The
 * mirror's `source` must therefore satisfy the real `UserMessage['source']`,
 * with the plugin's own source kind declared the way the harness's
 * merge-extensible `MessageSourceMap` expects.
 *
 * The whole message is not asserted: the mirror intentionally types `id` as a
 * plain `string` rather than the branded `MessageId` to stay structurally
 * decoupled, and that looseness has no runtime consequence.
 *
 * This file emits nothing; `tsconfig.types.json` compiles it for its errors.
 * @module dsh-a2a/tests/types/mirrors.typecheck
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentUserMessage, LiveAgent } from '../../src/server/exec/agent-runtime.ts'

// The plugin owns its source kind. The harness's `MessageSourceMap` is
// merge-extensible, so a producer declares its own member here rather than
// reusing the retired `plugin` catch-all that the v4 codec rejects.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'a2a': { kind: 'a2a' }
  }
}

/**
 * If the mirror's `source` drifts back to `{ kind: 'plugin' }` (or to any kind
 * the harness no longer accepts), this assignment stops compiling.
 */
export const mirroredSource: UserMessage['source'] = null as unknown as AgentUserMessage['source']

/**
 * The mirror's session slice (including `id`) must accept a real Session.
 * `deriveMessages` is widened to plain-string block types, which a real
 * Message[] satisfies.
 */
export const mirroredSession: LiveAgent['session'] = null as unknown as Pick<Session, 'id' | 'deriveMessages'>

/** The trace listener consumes these exact fields from real session events. */
export const mirroredToolCall: { readonly callId: unknown; readonly name: unknown; readonly arguments: unknown } =
  null as unknown as Extract<SessionEvent, { type: 'tool/call' }>['data']

export const mirroredToolResult: { readonly message?: { readonly toolCallId?: unknown; readonly isError?: unknown } } =
  null as unknown as Pick<Extract<SessionEvent, { type: 'tool/result' }>['data'], 'message'>
