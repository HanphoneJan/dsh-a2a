# Testing

Test strategy for `@hanphone/dsh-a2a`, the layers that catch what, and how to
run them. The short version: **a plugin can pass every stub test and still be
broken against the real harness.** The layers below exist so that a harness
contract change fails a test before it reaches a release.

**English** · [中文](testing.zh.md)

## Why this exists

`0.3.6` shipped with the inbound executor handing the agent a message whose
`source` was `{ kind: 'plugin', plugin: 'a2a' }` (fixed in `0.3.7`). The
in-memory `session.append`
check only requires `source.kind` to be a non-empty string, so all 110 stub
tests passed. The JSONL v4 encoder, which only runs in a real composition,
refuses `kind: 'plugin'`:

```text
SessionFormatError: format v4 message requires a producer-owned source kind
    at packages/session/session-format-v3-to-v4/src/message-sources.ts
```

The write failed in the session handle's background flush, the agent loop
contained the driver error, and every inbound task settled with `(no reply)`.
Nothing in `pnpm typecheck` or `pnpm test` could see it. The mirror check and
the real-persistence integration test were added to close exactly that gap.

## Layers

| Layer | Lives in | Catches | Needs a harness checkout |
|---|---|---|---|
| Mirror check | `tests/types/mirrors.typecheck.ts` | Structural mirrors drifting from real `@deepseek-ai/dsh-*` types | yes (project references) |
| Unit / composition | `tests/unit`, `tests/composition` | Protocol framing, routes, stores, registries, `apply()` wiring over stub host services | no |
| Real-persistence integration | `tests/integration/persistence.spec.ts` | Durable session codec, agent-loop contract, inbox sources — the bug class above | yes (source graph) |
| Profile e2e | `scripts/e2e-a2a.mjs` | A released artifact against two real harness instances: manifest/mount, routes, discovery, JSON-RPC, tool registration, model → tool → remote agent | yes (built artifacts) |

## Commands

```sh
pnpm typecheck        # host (tsc -b) + client + mirror check
pnpm test             # vitest run: unit + composition + integration
pnpm test:integration # only the real-persistence suite
pnpm build            # tsc + tsdown + browser bundle -> lib/
pnpm test:e2e         # hermetic two-instance A2A smoke (needs a built plugin)
pnpm test:all         # typecheck + test + build + test:e2e
```

`pnpm test:e2e` needs:

- a built plugin (`pnpm build`) — it fails fast with a clear message if
  `lib/index.js` is missing;
- a sibling `../deepseek-harness` checkout (`DSH_A2A_HARNESS_DIR` overrides)
  whose host artifacts are built (`pnpm install && pnpm run build`);
- nothing else: the model is the harness's own mock LLM server.

`DSH_A2A_KEEP=1` keeps the two temp homes and child processes for debugging.

## The e2e flow

`scripts/e2e-a2a.mjs` is hermetic and deterministic:

1. Two temp Harness homes (`a` and `b`) get a `web` profile (and `headless` for
   `a`) whose bundle list mounts the built plugin directly; no registry, no
   user home.
2. Each home starts a scripted mock LLM server
   (`@deepseek-ai/dsh-llm-mock-server`), and `dsh web` is pointed at it with
   `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`.
3. **Inbound:** create an inbound server on B, fetch its AgentCard, POST
   `SendMessage`, assert the artifact is the mock's text.
4. **Outbound:** create an outbound connection on A to B and assert it reports
   `connected` with at least one tool.
5. **Round trip:** stop A's web instance, run A's `headless` profile against a
   mock scripted to call `a2a__b__chat`, and assert stdout is B's reply.
6. Tear down both homes and every child process.

## Adding a test

- **Behavior change** → a unit/`composition` test that fails without it, per
  `AGENTS.md`.
- **New host contract surface** (a new runtime service, a message shape, a
  storage field) → extend the mirror check if it has a structural mirror, and
  add a real-persistence or e2e assertion if it is only observable end to end.
- **New e2e step** → add it to `scripts/e2e-a2a.mjs` and keep it offline: the
  mock LLM server is the only model allowed in the default run.

## CI

`.github/workflows/ci.yml` runs `check` (typecheck + tests) on every push and
pull request, and `e2e` against the pinned harness version on pull requests.
The scheduled nightly run and manual dispatch cover the full matrix of harness
versions the peer ranges claim (`0.2.1-rc.2`, `0.2.1-alpha.2`, `0.1.7-rc.2`).
Widen the matrix in the same change that widens `peerDependencies`.
