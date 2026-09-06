# dsh-a2a Architecture

Agent2Agent (A2A) Protocol v1.0 dual-end plugin for DeepSeek Harness.

**English** · [中文](architecture.zh.md)

This reference describes the shipped plugin. The original design discussion
(Chinese, v0.2) lives in [design.md](design.md); the `implemented` Agent Note
for the wiring lives in the harness checkout.

## Overview

The plugin mounts as one Cordis row, id `a2a`, on any DSH profile that mounts
the standard host services. It has three moving parts:

```
┌─ HTTP surface (profile webServer) ─────────────────────────────────────┐
│  GET  /.well-known/agent-card.json   → AgentCard (derived, live identity)│
│  POST /a2a                           → A2A JSON-RPC (SendMessage, …)     │
│  POST /a2a (Accept: text/event-stream) → SSE task streaming              │
│  GET/POST /a2a/api                   → loopback-only GUI dashboard API    │
└────────────────────────────────────────────────────────────────────────┘
┌─ Host halves ──────────────────────────────────────────────────────────┐
│  inbound:  TaskStore → a2a/inbound-task gate → ExecutorSet → SSE         │
│            InboundRegistry (peer tracking) + identity (persisted card)   │
│  outbound: AgentCard registry (durable) → A2AClient → ctx.tools tools    │
│  service:  ctx.a2a facade (shared by /a2a command + /a2a/api)            │
└────────────────────────────────────────────────────────────────────────┘
┌─ Browser half ─────────────────────────────────────────────────────────┐
│  settings.section "A2A 连接" (React) → fetch /a2a/api                  │
│  server toggle · identity edit/onboarding · agents · inbound peers · tasks│
└────────────────────────────────────────────────────────────────────────┘
```

## Design decisions

Recorded decisions (the "final decisions" of the design doc, now shipped):

1. **Protocol layer implemented directly** — JSON-RPC/SSE are hand-written,
   not built on an official A2A JS SDK, to keep conformance control.
2. **Package identity** — `@hanphone/dsh-a2a`, installed via `dsh plugin add`
   (npm or a local tarball).
3. **Dual-end P0** — both the inbound server and the outbound client are
   first-class.
4. **Install-and-use** — both halves are enabled by default after install;
   either can be turned off from the GUI dashboard.
5. **GUI-managed operations** — server toggle, service identity, outbound
   agent CRUD, inbound peer monitoring, and task view/cancel all live in the
   Settings dashboard; editing `cordis.patch.yml` remains the reserve path.

## Inbound half

### AgentCard derivation and identity

`deriveSkills(tools, { ids, exclude })` reads the live `ctx.tools` registry:

- every configured `ids` entry must resolve to a registered tool — a missing
  referent fails the derivation loudly with all missing ids listed;
- the built-in `chat` skill is always present;
- `exclude` removes ids after derivation (defense in depth).

The card's **identity** (name/description/version) comes from the persisted
`identity` record in the `a2a` domain when present, otherwise from the
composition defaults. Editing the identity from the dashboard rebuilds the
card (preserving the endpoint URL and security scheme) and swaps it onto the
server via `A2AServer.setCard`; routes re-read `server.card` per request, so
the change is visible immediately. The identity survives restarts (domain
backed).

### Task lifecycle

```
POST /a2a (SendMessage)
  → parseRpc (JSON-RPC 2.0, A2A-Version, authorization)
  → server.ensureTask(message)
      contextId + skill (metadata.skill ?? 'chat')
      → store.create → taskId a2a-<uuid>, state SUBMITTED (persisted eagerly)
  → gate(input)
      skill allow-list
      ctx.waterfall('a2a/inbound-task', decision)   # veto/audit
  → runTask(record)
      WORKING → executor.execute(...)               # events → store + SSE
      resolved → artifact 'result' → COMPLETED
      rejected → FAILED with executor error
  → cancel path: CancelTask / facade → abort signal → CANCELED
```

SubscribeToTask / SendStreamingMessage deliver a catch-up status frame on
subscribe, then stream updates and the terminal task.

### Inbound connection monitoring

The `InboundRegistry` (in-memory) is fed by the server's `onInbound` hook on
every JSON-RPC request / SSE open, keyed by the socket source address. Each
peer tracks first/last seen, task count, active task ids, and streaming
state; settled tasks leave the active set. `closePeer(id)` cancels the peer's
active tasks through the facade and drops the record. The dashboard lists
these peers and offers the close control; the registry is process-local (peer
records are ephemeral by design — they describe live connections).

### Executors

```ts
interface A2aExecutor {
  execute(task, opts: { signal, onEvent }): Promise<{ parts: Part[] }>
}
```

- **session** — one DSH session per `contextId`; result = settled reply.
- **subagent** — delegates to `ctx.subagents`, streams tool-call artifacts as
  `artifact` events; result = final message + step-list artifact.

`config.server.executors: { <skillId>: 'session' | 'subagent' }`, defaulting
to `session`. Without an agent loop the server still answers with a readable
refusal.

### Task store

Tasks live in the `a2a` storage domain (`DomainFacility.open` → `Domain` →
typed `KvTable`), JSON-encoded records, tables `tasks`, `contexts`, `agents`,
`identity`. Writes go through the domain's write chain; `DomainTaskStore`
keeps a write-chain-visible live view so synchronous readers see their own
writes.

## Outbound half

### Registry

The `agents` table persists `OutboundAgentRecord`s. At boot `loadAll()`
restores them and connects every enabled agent; declared `config.client.agents`
seed store-absent names (persisted records keep their runtime state — a
disabled agent stays disconnected, a removed agent is not resurrected).

### Tools

For each connected agent, `registerAgentTools` maps every advertised skill to
a model tool `a2a__<name>__<skill>` (normalized, collision-hashed). Executing
the tool runs `A2AClient.sendMessage` with a stable per-caller contextId and
returns the settled task's text; `FAILED` throws a readable `A2AError`,
`INPUT_REQUIRED`/`AUTH_REQUIRED` are surfaced as text.

## GUI dashboard

- **Browser half** (`src/client/`) — a React plugin registered as a
  `settings.section` ("A2A 连接") through `ctx.slots.inject` (the slot is
  declared at runtime by `ui-settings-general`), loaded by the DSH web shell
  via `window.__ModuleLoader__` (`lib/client.js`, externals from the browser
  module table).
- **Loopback API** (`/a2a/api`) — GET returns a snapshot (server state,
  identity, tasks, agents, inbound peers); POST dispatches control actions
  (server.enable/disable, identity.update, agent add/remove/enable/disable/
  refresh, inbound.close, task.cancel). Non-loopback callers get 403. Both
  halves share the same `ctx.a2a` facade, so GUI and `/a2a` command cannot
  disagree.

## Security model

- Inbound bearer token is an **env-var name** (`authTokenEnv`), resolved at
  boot; never stored as plaintext in config.
- The GUI dashboard API is **loopback-only**; remote peers cannot drive it.
- The AgentCard advertises only the scheme declaration, never the token value.

## Storage backend note

The default composition routes the `a2a` domain through the JSON backend.
The design's SQLite requirement can be met by routing the domain to
`storage-sqlite` in the same patch layer. The full REAL-composition boot
(SQLite + LLM-backed agent loop via loader-smoke) remains P1.

## Independent project

The package is deliberately **not** a workspace member of the harness
checkout: it keeps its own `package.json` and dependency graph,
`@deepseek-ai/*` as peer dependencies, and `zod` as its only own runtime
dependency. It typechecks the harness source graph through project references
to built `lib/types` declarations; a fresh checkout must build the host
aggregate first.

## P1 / explicitly-not-doing

- push notifications;
- `INPUT_REQUIRED` ↔ approval flow;
- passive outbound result injection;
- OAuth 2.0 / per-client credentials, gRPC binding;
- an interoperability conformance suite;
- persisted inbound-peer history (peers are live-connection records by
  design).

## Tests

- `tests/unit/` — protocol constants, JSON-RPC/SSE framing, card derivation
  and identity rebuild, store (incl. write-chain visibility regressions),
  executor resolution, A2A server (dispatch, gate, auth, cancel, streaming),
  inbound registry, outbound client and registry (stubbed fetch), dashboard
  API.
- `tests/composition/` — boots `apply()` on a real Cordis `Context` with stub
  host services: assembly, route registration, the skill gate,
  `a2a/inbound-task` vetoes, task persistence, outbound tool registration.