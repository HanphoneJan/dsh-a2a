# dsh-a2a Architecture

Agent2Agent (A2A) Protocol v1.0 dual-end plugin for DeepSeek Harness.

This document is the English architecture reference; the original design
discussion (Chinese, v0.2) lives in [design.md](design.md). Current scope is
P0 as defined there.

## Overview

The plugin mounts as one Cordis row, id `a2a`, on any DSH profile that mounts
the standard host services. It has three moving parts:

```
┌─ HTTP surface (profile webServer) ─────────────────────────────────────┐
│  GET  /.well-known/agent-card.json   → AgentCard (derived from tools)  │
│  POST /a2a                           → A2A JSON-RPC (SendMessage, ...)  │
│  POST /a2a (Accept: text/event-stream) → SSE task streaming            │
│  GET/POST /a2a/api                   → loopback-only GUI dashboard API  │
└────────────────────────────────────────────────────────────────────────┘
┌─ Host halves ──────────────────────────────────────────────────────────┐
│  inbound:  TaskStore → a2a/inbound-task gate → ExecutorSet → SSE        │
│  outbound: AgentCard registry (durable) → A2AClient → ctx.tools tools   │
│  service:  ctx.a2a facade (shared by /a2a command + /a2a/api)           │
└────────────────────────────────────────────────────────────────────────┘
┌─ Browser half ─────────────────────────────────────────────────────────┐
│  settings.section "A2A 连接" (React) → fetch /a2a/api                  │
└────────────────────────────────────────────────────────────────────────┘
```

## Design decisions

Recorded decisions (the "final decisions" of the design doc, now shipped):

1. **Protocol layer implemented directly** — JSON-RPC/SSE are hand-written,
   not built on an official A2A JS SDK, to keep conformance control.
2. **Package identity** — `@hanphone/dsh-a2a`, installed via `dsh plugin add`
   (npm or a local tarball).
3. **Dual-end P0** — both the inbound server and the outbound client are
   first-class; no single-end shrink.
4. **Install-and-use** — both halves are enabled by default after install;
   the user can turn either off from the GUI dashboard.
5. **GUI-managed operations** — server toggle, outbound agent CRUD, and task
   view/cancel all live in the Settings dashboard; editing
   `cordis.patch.yml` remains supported as the reserve path.

## Inbound half

### AgentCard derivation

`deriveSkills(tools, { ids, exclude })` reads the live `ctx.tools` registry:

- every configured `ids` entry must resolve to a registered tool — a missing
  referent fails the derivation loudly (the "misconfiguration fails loud"
  contract) with all missing ids listed;
- the built-in `chat` skill is always present, so a fresh install answers
  before any tool is exposed;
- `exclude` removes ids after derivation (defense in depth).

`buildCard()` assembles the AgentCard with the advertised base URL +
`endpointPath`, the derived skills, and — when an inbound bearer token is
configured through `authTokenEnv` — `securitySchemes`/`securityRequirements`.

### Task lifecycle

```
POST /a2a (SendMessage)
  → parseRpc (JSON-RPC 2.0, A2A-Version, authorization)
  → server.ensureTask(message)
      contextId (client or generated) + skill (metadata.skill ?? 'chat')
      → store.create → taskId a2a-<uuid>, state SUBMITTED (persisted eagerly)
  → gate(input)
      skill allow-list
      ctx.waterfall('a2a/inbound-task', decision)
        listeners may reject → task stays REJECTED-shaped for the caller
        built-in audit log line per decision
  → runTask(record)
      state WORKING → executor.execute({ taskId, contextId, skill, prompt, signal })
        executor events (status/artifact) → store updates + SSE frames
      resolved → appendArtifact('result') → state COMPLETED
      rejected → state FAILED with the executor error message
  → cancel path: CancelTask / facade cancel → abort signal → CANCELED
```

SubscribeToTask/SendStreamingMessage deliver a catch-up status frame on
subscribe (the initial WORKING frame races the subscription), then stream
updates and the terminal task.

### Executors

The executor seam is internal (not a public registry):

```ts
interface A2aExecutor {
  execute(task, opts: { signal, onEvent }): Promise<{ parts: Part[] }>
}
```

- **session** — one DSH session per `contextId`; same conversation, serial;
  result = the session's settled reply.
- **subagent** — delegates to `ctx.subagents` (default provider
  `in-process`), streams tool-call artifacts as `artifact` events; result =
  final message + a step-list artifact.

Skill ↔ executor binding: `config.server.executors: { <skillId>: 'session' |
'subagent' }`, defaulting to `session`. Without an agent loop the server
still answers, with a readable refusal.

### Task store

Tasks live in the `a2a` storage domain (`DomainFacility.open` → `Domain` →
typed `KvTable`), JSON-encoded records, three tables: `tasks`, `contexts`,
`agents`. Writes go through the domain's write chain; `DomainTaskStore` keeps
a write-chain-visible live view so synchronous readers see their own writes.

## Outbound half

### Registry

The `agents` table persists `OutboundAgentRecord`s (id, name, agentCardUrl,
bearerTokenEnv, enabled, timeoutMs). At boot, `loadAll()` restores them and
connects every enabled agent; declared `config.client.agents` seed
store-absent names (persisted records keep their runtime state — a disabled
agent stays disconnected, a removed agent is not resurrected).

### Tools

For each connected agent, `registerAgentTools` maps every advertised skill to
a model tool named `a2a__<name>__<skill>` (normalized to the DSH function-name
contract, collision-hashed). Executing the tool runs `A2AClient.sendMessage`
with a stable per-caller contextId and returns the settled task's text;
`FAILED` throws a readable `A2AError`, `INPUT_REQUIRED`/`AUTH_REQUIRED` are
surfaced as text.

## GUI dashboard

- **Browser half** (`src/client/`) — a React plugin registered as a
  `settings.section` ("A2A 连接"), loaded by the DSH web shell through
  `window.__ModuleLoader__` (`lib/client.js`, externals resolved from the
  browser module table).
- **Loopback API** (`/a2a/api`) — GET returns a snapshot (server state,
  tasks, agents); POST dispatches control actions (server.enable/disable,
  agent add/remove/enable/disable/refresh, task.cancel). Non-loopback callers
  get 403. Both halves share the same `ctx.a2a` facade, so GUI and `/a2a`
  command cannot disagree.

## Security model

- Inbound bearer token is an **env-var name** (`authTokenEnv`), resolved at
  boot; never stored as plaintext in config.
- The GUI dashboard API is **loopback-only**; remote peers cannot drive it.
- The plugin never exposes the token value in the AgentCard — only the
  scheme declaration.

## Storage backend note

The default composition routes the `a2a` domain through the JSON backend.
The design's SQLite requirement can be met by routing the domain to
`storage-sqlite` and inserting the backend row in the same patch layer (see
README). The full REAL-composition boot (SQLite + LLM-backed agent loop via
loader-smoke) remains P1.

## Independent project

The package is deliberately **not** a workspace member of the harness
checkout: it keeps its own `package.json` and dependency graph,
`@deepseek-ai/*` as peer dependencies, and `zod` as its only own runtime
dependency. It typechecks against the harness source graph through project
references to built `lib/types` declarations. A fresh checkout must build the
host aggregate first.

## P1 / explicitly-not-doing

- push notifications;
- `INPUT_REQUIRED` ↔ approval flow;
- passive outbound result injection;
- dashboard UI beyond the settings page (a standalone panel);
- OAuth 2.0 / per-client credentials, gRPC binding;
- interoperability conformance suite.

## Tests

- `tests/unit/` — protocol constants, JSON-RPC/SSE framing, card derivation,
  store (including write-chain visibility regressions), executor resolution,
  the A2A server (dispatch, gate, auth, cancel, streaming), the outbound
  client and registry (stubbed fetch), the dashboard API.
- `tests/composition/` — boots `apply()` on a real Cordis `Context` with stub
  host services: assembly, route registration, the skill gate,
  `a2a/inbound-task` vetoes, task persistence, outbound tool registration.