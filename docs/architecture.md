# dsh-a2a Architecture

Agent2Agent (A2A) Protocol v1.0.1 dual-end plugin for DeepSeek Harness.

**English** · [中文](architecture.zh.md)

This reference describes the shipped plugin. The design discussion (Chinese,
v1.0 multi-instance) lives in [design.md](design.md); the `implemented` Agent
Note for the wiring lives in the harness checkout.

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

## Design decisions

1. **Protocol layer implemented directly** — JSON-RPC/SSE are hand-written
   against the official A2A v1.0.1 spec (`.research/A2A` is authoritative):
   PascalCase methods (`SendMessage`, …), `TASK_STATE_*` / `ROLE_*` enums,
   the full `AgentCard` structure (`supportedInterfaces`, `capabilities`,
   `securitySchemes`, `skills`), and the spec error-code table.
2. **Package identity** — `@hanphone/dsh-a2a`, installed via `dsh plugin add`
   (npm or a local tarball).
3. **Multi-instance, GUI-managed (v1.0)** — instances are created, edited,
   started and stopped from the Settings dashboard; they persist in the `a2a`
   domain, not in plugin config. The plugin `Config` carries only host-level
   defaults (`baseUrl`, `subagentProvider`, `defaultTimeoutMs`).
4. **Preset-bound instances (confirmed semantics)** — an inbound instance's
   preset composes every session that executes its tasks; an outbound
   instance's preset names the composition DSH would give its local hand-off
   session when driving that remote (the runtime hand-off seam is a documented
   extension point at P0; the value is persisted metadata surfaced to the
   GUI). Every instance is bound to one concrete preset — the GUI lists only
   real roster presets (id/name/description, matching the in-app picker) and
   defaults the selection to the deployment default (`agentPresets.defaultId`).
5. **Skill declarations derive from the preset (confirmed)** — an inbound
   instance's AgentCard skills are the model-invocable entries of that
   preset's skill directory: `agentPresets.standingKeyFor(preset)` gives the
   preset's standing scope key, and `ctx.skills.list({ scope })` returns the
   catalogue that preset agent actually sees (preset layer + deployment
   global). `invocation.modelInvocable === false` entries are filtered.
   Derivation is fully automatic — the v0.2 tool white-listing and the
   creator-typed skill form are both removed; a missing skills service falls
   back to a built-in `chat` skill so minimal compositions stay exercisable.
6. **Old config is deleted, not migrated (confirmed)** — `server.enabled` /
   `client.agents` etc. are no longer read.

## Protocol surface

Methods implemented: `SendMessage` (with `return_immediately` /
`history_length` / `accepted_output_modes`), `SendStreamingMessage` (SSE),
`GetTask` (with `historyLength`), `ListTasks` (with `contextId` / `status` /
`pageSize` / `pageToken`), `CancelTask`, `SubscribeToTask` (SSE; terminal
tasks answered per spec), `GetExtendedAgentCard`. Push-notification methods
are declared and answer `PushNotificationNotSupported` at the method level.
Serialization follows ADR-001 ProtoJSON (`TASK_STATE_*` /
`ROLE_USER` / `ROLE_AGENT`, camelCase fields); transport checks the
`A2A-Version` header; errors use the spec code table.

## Inbound half

### InboundServerManager

`InboundServerManager` owns the live set. Each persisted `InboundServerRecord`
(`inbound_servers` table) becomes one live instance at boot:

- a preset-bound `ContextSessionPool` (when `agents` is mounted) — sessions
  are composed from `record.preset` via `agentPresets.resolve` + `mount`;
- an `A2AServer` on the shared `TaskStore`, with its own endpoint
  (`/a2a/<id>`) and card route (`/a2a/<id>/agent-card.json`);
- an `A2aRoutes` registration (enable/disable), an `ExecutorSet`
  (session/subagent), and a `LiveInboundRegistry` for peer monitoring.

The manager owns the full lifecycle: `add` (persist + assemble + enable),
`update` (persist + rebuild card + swap), `setEnabled` (route enable/disable),
`remove` (dispose + unpersist). Skills are derived per instance from its
preset's skill directory (see Design decisions §5); the built-in `chat`
fallback keeps minimal compositions exercisable. The gate's declared-skill
allow list is exactly that derived list, so remote skill calls always resolve
inside the instance's preset session.

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

SubscribeToTask / SendStreamingMessage deliver a catch-up status frame on
subscribe, then stream updates and the terminal task.

### Executors

- **session** — one DSH session per `contextId`, composed from the instance's
  preset; result = settled reply.
- **subagent** — delegates to `ctx.subagents`, streams tool-call artifacts as
  `artifact` events. Without an agent loop the server answers with a readable
  refusal.

### Inbound session layer (per contextId)

The session layer makes the per-context DSH sessions observable and
reclaimable, without touching the A2A protocol surface (protocol only knows
tasks + contextId).

- **Binding** — the first time a context's session opens, the pool's
  `onSessionOpened` hook (fires exactly on `justOpened`) persists the
  `contextId → sessionId` binding through `TaskStore.setContextSession`
  (memory-first, so the domain's write-chain stays visible). The binding write
  never fails an in-flight task — a durability failure is logged.
- **Views** — `SessionView` rows are aggregated by `contextId` from the shared
  task store (counts, running/idle, first/last activity) folded over live
  observations: per-instance `ContextSessionRegistry` streaming counts (fed by
  `A2AServer` SSE open/close hooks) and pool handle presence. Data-source
  priority is live-first, task-store derivation as fallback: a composition
  without an agent loop (no pool) still renders the session table from task
  records; rows survive restarts as degraded (no handles/streaming) because
  tasks are durable — only the in-memory observations reset, consistent with
  the peer registry.
- **Reclamation** — `cancelSessionTasks(contextId)` aborts every non-terminal
  task of the context through the existing `A2AServer.abort` path (no new
  infrastructure); `closeSession(contextId)` additionally disposes the context's
  live handle(s) via `ContextSessionPool.disposeContext` and drops them from the
  pool. **Close semantics**: close is an in-memory resource release, NOT a
  conversation tombstone — A2A has no "closed context" notion, so the next task
  on the same contextId re-opens a fresh handle through `agentFor` and is never
  refused. Whether the reopened DSH session resumes persisted history is host
  behavior outside this plugin's control.
- **Attribution** — each `A2AServer` stamps its instance id onto the task
  records it creates (`TaskStore.create.serverId`), so a session row (and the
  task list's source column) can name the inbound instance it arrived through.

The facade exposes `listSessions` / `cancelSessionTasks` / `closeSession`;
sessions also ride the `status()` snapshot (`sessions` field) and the loopback
API (`session.cancel` / `session.close`, loopback-only like every control
action).

### Task store and domain

Tasks and bindings live in the `a2a` storage domain (`DomainFacility.open` →
`Domain` → typed `KvTable`), JSON-encoded records. Tables: `tasks` (each
record carries the optional `serverId` of its inbound instance), `contexts`,
`agents` (per-instance outbound agent records), `identity`,
`inbound_servers`, `outbound_servers`. `DomainTaskStore` keeps a
write-chain-visible live view so synchronous readers see their own writes.

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

For each connected instance, `registerAgentTools` maps every advertised
remote skill to a model tool `a2a__<name>__<skill>` (normalized,
collision-hashed). Executing the tool runs `A2AClient.sendMessage` with a
stable per-caller contextId and returns the settled task's text. The outbound
tools call the remote directly at P0; the preset-bound local hand-off session
composition is the documented extension point.

## GUI dashboard

- **Browser half** (`src/client/`) — a React plugin registered as a
  `settings.section` ("A2A 连接") through `ctx.slots.inject`, loaded by the
  DSH web shell via the client bundle (styling in `client/dashboard.css.ts`,
  `--dsw-alias-*` tokens with `@container` responsiveness). Three tabs:
  inbound servers (preset pickers listing real roster presets defaulting to
  the deployment default, preset-derived skill chips, Bearer Token entry),
  outbound servers (two-phase discover→connect with card preview), and
  activity (peers + sessions + tasks, stacked as separate crew sections).
- **Loopback API** (`/a2a/api`) — GET returns a snapshot (inbound/outbound
  server views, tasks, peers, sessions); `GET /a2a/api/presets` returns the
  agent-preset roster for the pickers; POST dispatches control actions
  (inbound.create/update/remove/enable/disable/setAuth,
  outbound.create/update/remove/enable/disable/refresh/setAuth/discover,
  task.cancel, inbound.close, session.cancel/session.close). Non-loopback
  callers get 403. The GUI, the `/a2a` command, and `ctx.a2a` consumers all
  share the same facade implementation.

## Security model

- **Direct bearer-token entry, layered resolution.** The GUI's Bearer Token
  field writes the token through the harness credentials service
  (`ctx.credentials.set` → managed `.env`/credential store, directory `0o700`);
  each instance record keeps only an auto-generated env-var name
  (`A2A_INBOUND_<id>` / `A2A_OUTBOUND_<id>`). Runtime resolution
  (`resolveAuthToken`) layers credentials → process environment per operation,
  so externally exported env vars keep working. A token value never lands in
  the `a2a` domain, plugin config, or the AgentCard, and the GUI never echoes
  it back.
- The GUI dashboard API is **loopback-only**; remote peers cannot drive it.
- The AgentCard advertises only the scheme declaration, never the token value.

## Storage backend note

The default composition routes the `a2a` domain through the JSON backend.
SQLite can be selected by routing the domain to `storage-sqlite` in the same
patch layer.

## Independent project

The package is deliberately **not** a workspace member of the harness
checkout: it keeps its own `package.json` and dependency graph,
`@deepseek-ai/*` as peer dependencies, and `zod` as its only own runtime
dependency. It typechecks the harness source graph through project references
to built `lib/types` declarations; a fresh checkout must build the host
aggregate first.

## P1 / explicitly-not-doing

- push notifications (method-level declaration only);
- the outbound preset hand-off session composition seam (preset is persisted
  metadata at P0);
- OAuth 2.0 / per-client credentials, gRPC binding;
- an interoperability conformance suite (spec audit + cross-tests instead);
- persisted inbound-peer history (peers are live-connection records by
  design);
- **session persistence/recovery** — session data is all in memory and resets
  on process restart (DSH sessions cannot be resurrected); the durable task
  store is the only history that survives, rendered as degraded rows;
- **session editing / preset hot-swap** — the session layer is observe +
  reclaim only; preset changes are instance edits in the inbound-servers tab,
  not per-session operations.

## Tests

- `tests/unit/` — protocol constants, JSON-RPC/SSE framing, card assembly and
  skill defaults, store (incl. write-chain visibility regressions), executor
  resolution, A2A server (dispatch, gate, auth, cancel, streaming), inbound
  registry, session registry (streaming counting, view aggregation incl. the
  degraded no-pool path), agent session pool (has/disposeContext/reopen),
  outbound client and registry (stubbed fetch), dashboard API.
- `tests/composition/` — boots `apply()` on a real Cordis `Context` with stub
  host services: multi-instance assembly, per-instance route registration,
  the declared-skill gate, `a2a/inbound-task` vetoes, task persistence,
  outbound tool registration, instance CRUD/removal.