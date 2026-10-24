# dsh-a2a Architecture

Agent2Agent (A2A) Protocol v1.0.1 dual-end plugin for DeepSeek Harness.

**English** · [中文](architecture.zh.md)

This reference describes the shipped plugin: its managers, executors, routes,
storage and security boundaries. Vocabulary is defined in
[concepts.md](guide/concepts.md), wire details in
[reference/http-api.md](reference/http-api.md), and the test layers in
[testing.md](testing.md).

## Overview

The plugin mounts as one Cordis row, id `a2a`, on any DSH profile that mounts
the standard host services. Its core abstraction is the **server instance**: a
reusable frame — endpoint + identity/skill advertisement + preset binding +
auth — materialized once per inbound direction and once per outbound
connection.

```
┌─ GUI (browser, settings.section "A2A 连接") ────────────────────────────┐
│  inbound server instances (create/preset/skills/auth/start/stop/edit)   │
│  outbound server instances (create/URL/preset/auth/timeout/start/stop)  │
│  tasks (per-instance view/cancel) · inbound peers · sessions            │
└───────────────────────────────────────┬─────────────────────────────────┘
                                        │ loopback-only /a2a/api
┌─ Host plane ──────────────────────────▼─────────────────────────────────┐
│  InboundServerManager    per instance: preset-bound session pool +      │
│                           A2AServer + A2aRoutes (own endpoint + card)   │
│  OutboundServerManager   per instance: OutboundAgentRegistry (own agent │
│                           store) + remote A2AClient + tools             │
│  A2aDomain (tasks/contexts/agents/identity/inbound_servers/             │
│            outbound_servers) · ctx.a2a facade                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## Design

1. **Protocol layer implemented directly** — JSON-RPC/SSE are hand-written
   against the official A2A v1.0.1 spec: PascalCase methods (`SendMessage`, …),
   `TASK_STATE_*` / `ROLE_*` enums, the full `AgentCard` structure
   (`supportedInterfaces`, `capabilities`, `securitySchemes`, `skills`), and
   the spec error-code table.
2. **Package identity** — `@hanphone/dsh-a2a`, installed via `dsh plugin add`
   (npm or a local tarball).
3. **Multi-instance, GUI-managed** — instances are created, edited, started and
   stopped from the Settings dashboard; they persist in the `a2a` domain, not in
   plugin config. The plugin `Config` carries only host-level defaults
   (`baseUrl`, `subagentProvider`, `defaultTimeoutMs`).
4. **Preset-bound instances** — every instance is bound to one concrete roster
   preset (the GUI lists id/name/description and defaults to
   `agentPresets.defaultId`). An inbound instance's preset composes every
   session that executes its tasks. An outbound instance's preset is persisted
   metadata for a future local hand-off session; tools call the remote directly
   today.
5. **Skill declarations derive from the preset** — an inbound instance's
   AgentCard skills are the model-invocable entries of that preset's skill
   directory: `agentPresets.standingKeyFor(preset)` gives the standing scope
   key, and `ctx.skills.list({ scope })` returns the catalogue that preset
   agent sees (preset layer + deployment global). `invocation.modelInvocable
   === false` entries are filtered. A missing skills service falls back to a
   built-in `chat` skill so minimal compositions stay exercisable.

## Protocol surface

Methods: `SendMessage` (idempotent by `messageId`, continuable by `taskId`),
`SendStreamingMessage` (SSE with assistant/tool deltas and event ids),
`GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask` (SSE with in-process
`Last-Event-ID` replay), and `GetExtendedAgentCard`. Push-notification methods
are declared and answer `PushNotificationNotSupported` at the method level.
Serialization follows ADR-001 ProtoJSON; transport checks the `A2A-Version`
header; errors use the spec code table. The full method table, task states and
error codes are in [reference/http-api.md](reference/http-api.md#2-a2a-endpoints).

## Inbound half

### InboundServerManager

`InboundServerManager` owns the live set. Each persisted `InboundServerRecord`
(`inbound_servers` table) becomes one live instance at boot:

- a preset-bound `ContextSessionPool` (when `agents` is mounted) — sessions
  are composed from `record.preset` via `agentPresets.resolve` + `mount`;
- an `A2AServer` on a `ScopedTaskStore` over the shared domain store, with its
  own endpoint (`/a2a/<id>`) and card route (`/a2a/<id>/agent-card.json`);
- an `A2aRoutes` registration (enable/disable), an `ExecutorSet`
  (session/subagent), and a `LiveInboundRegistry` for peer monitoring.

The manager owns the full lifecycle: `add` (persist + assemble + enable),
`update` (persist + rebuild card + swap), `setEnabled` (route enable/disable),
`remove` (dispose + unpersist). Skills are derived per instance from its
preset's skill directory; the built-in `chat` fallback keeps minimal
compositions exercisable. The gate's declared-skill allow list is exactly that
derived list, so remote skill calls always resolve inside the instance's preset
session. Task access is scoped by `serverId`: `GetTask`/`ListTasks`/`CancelTask`/
`SubscribeToTask` cannot see another instance's tasks, and context bindings plus
derived session ids are namespaced by instance id so two instances can reuse the
same client `contextId` safely. Each task also has a configurable execution
timeout and the instance has request/body/concurrency limits.

### Task lifecycle

```
POST /a2a/<id> (SendMessage)
  → parseRpc (JSON-RPC 2.0, A2A-Version, authorization per instance)
  → server.ensureTask(message)
      contextId + skill (metadata.skill ?? 'chat'); task records its serverId
      → store.create → taskId a2a-<uuid>, SUBMITTED (persisted eagerly)
  → gate(input)
      declared-skill allow list (per instance)
      ctx.waterfall('a2a/inbound-task', decision)   # veto/audit
  → runTask(record)
      WORKING → executor.execute(...)               # events → store + SSE
      resolved → artifact 'result' → COMPLETED
      rejected → FAILED with executor error
  → cancel path: CancelTask / facade → abort signal → CANCELED
```

`SubscribeToTask` / `SendStreamingMessage` deliver a catch-up status frame on
subscribe, then stream updates and the terminal task.

### Executors

- **session** — one DSH session per `contextId`, composed from the instance's
  preset; result = settled reply.
- **subagent** — delegates to `ctx.subagents`, streams tool-call artifacts as
  `artifact` events. Without an agent loop the server answers with a readable
  refusal.

### Inbound session layer (per contextId)

The session layer makes per-context DSH sessions observable and reclaimable
without touching the A2A protocol surface (which only knows tasks + contextId).

- **Binding** — the first time a context's session opens, the pool's
  `onSessionOpened` hook (fires exactly on `justOpened`) persists the
  `contextId → sessionId` binding through `TaskStore.setContextSession`
  (memory-first, so the domain's write-chain stays visible). A durability
  failure is logged and never fails an in-flight task.
- **Views** — `SessionView` rows are aggregated by `contextId` from the shared
  task store (counts, running/idle, first/last activity) folded over live
  observations: per-instance `ContextSessionRegistry` streaming counts (fed by
  `A2AServer` SSE open/close hooks) and pool handle presence. Data-source
  priority is live-first with task-store derivation as fallback: a composition
  without an agent loop still renders the session table from task records, and
  rows survive restarts as degraded (no handles/streaming) because tasks are
  durable.
- **Reclamation** — `cancelSessionTasks(contextId)` aborts every non-terminal
  task of the context through `A2AServer.abort`; `closeSession(contextId)`
  additionally disposes the context's live handle(s) via
  `ContextSessionPool.disposeContext`. **Close is an in-memory resource
  release, not a conversation tombstone** — the next task on the same
  `contextId` re-opens a fresh handle through `agentFor` and is never refused.
  Whether the reopened DSH session resumes persisted history is host behavior
  outside this plugin's control.
- **Attribution** — each `A2AServer` stamps its instance id onto the task
  records it creates (`TaskStore.create.serverId`), so a session row (and the
  task list's source column) names the inbound instance.

The facade exposes `listSessions` / `cancelSessionTasks` / `closeSession`;
sessions also ride the `status()` snapshot (`sessions` field) and the loopback
API (`session.cancel` / `session.close`).

### Task store and domain

Tasks and bindings live in the `a2a` storage domain (`DomainFacility.open` →
`Domain` → typed `KvTable`), JSON-encoded records. The table list is in
[concepts.md](guide/concepts.md#9-identity-storage-and-sessions).
`DomainTaskStore` keeps a write-chain-visible live view so synchronous readers
see their own writes.

## Outbound half

### OutboundServerManager

`OutboundServerManager` owns the live set of connections. Each persisted
`OutboundServerRecord` (`outbound_servers` table) becomes one
`OutboundAgentRegistry` at boot, with an isolated per-instance `AgentStore`
(`agents` table, keyed `out:<id>`). The manager owns the full lifecycle:
`add` (persist + connect), `setEnabled`, `refresh`, `remove` (dispose +
unpersist), and exposes a `viewFor` that folds the registry view + the record
(the GUI reads `OutboundServerView` including the `preset`).

### Tools

For each connected instance, `registerAgentTools` maps enabled advertised
skills to a model tool `a2a__<name>__<skill>` (normalized, collision-hashed;
per-skill enable/disable and name/description overrides are persisted on the
instance). Executing the tool sends an A2A message with a stable per-caller
contextId, streams when the remote card supports it, propagates the caller's
abort (sending `CancelTask` once the task id is known), retries transient
transport/5xx failures, and accepts `taskId` to continue an interrupted remote
task. Connections refresh their AgentCard automatically on the configured
interval.

## GUI dashboard

The browser half (`src/client/`) is a React plugin registered as a
`settings.section` ("A2A 连接") through `ctx.slots.inject`, loaded by the DSH
web shell via the client bundle. It reads and writes the loopback-only
`/a2a/api` route; the host half feeds it snapshots of inbound/outbound server
views, tasks, peers, sessions, the preset roster, and the update answer. The
GUI, the `/a2a` command, and `ctx.a2a` consumers share the same facade
implementation. Panel layout and actions are documented in
[operations.md](guide/operations.md#2-the-panel) and
[reference/http-api.md](reference/http-api.md#1-dashboard-api).

## Security model

The GUI writes bearer tokens through the harness credentials service
(`ctx.credentials.set` → managed `.env`/credential store, directory `0o700`);
each instance record keeps only an auto-generated env-var name
(`A2A_INBOUND_<id>` / `A2A_OUTBOUND_<id>`). Runtime resolution
(`resolveAuthToken`) layers credentials → process environment per operation, so
externally exported env vars keep working. A token value never lands in the
`a2a` domain, plugin config, or the AgentCard, and the GUI never echoes it
back. The dashboard API is loopback-only; remote peers cannot drive it. See
[concepts.md](guide/concepts.md#10-security-model) for the full model.

## Independent project

The package is deliberately **not** a workspace member of the harness
checkout: it keeps its own `package.json` and dependency graph,
`@deepseek-ai/*` as peer dependencies, and `zod` as its only own runtime
dependency. It typechecks the harness source graph through project references
to built `lib/types` declarations; a fresh checkout must build the host
aggregate first.

## Non-goals

Architectural work this plugin deliberately does not do:

- push-notification delivery (method-level declaration only);
- the outbound preset hand-off session composition seam;
- OAuth 2.0 / per-client credentials, gRPC binding;
- an interoperability conformance suite (spec audit + cross-tests instead);
- persisted inbound-peer history or session recovery — peers and sessions are
  live, in-memory records; the durable task store is the only history.

The user-facing limit list is in
[reference/http-api.md](reference/http-api.md#4-current-limits).
