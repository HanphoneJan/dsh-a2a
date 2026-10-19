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
import type { AgentUserMessage } from '../../src/server/exec/agent-runtime.ts'

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
