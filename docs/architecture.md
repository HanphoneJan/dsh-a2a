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
│  tasks (per-instance view/cancel) · inbound peer monitoring             │
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
   GUI).
5. **Skill declaration replaces tool white-listing (confirmed)** — the
   AgentCard's skills are exactly what the creator declared; empty at creation
   defaults to the bound preset's display name (or the built-in `chat`). The
   v0.2 `deriveSkills` mechanism is removed.
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
  are composed from `record.preset` via `agentPresets.resolve` + `mount`,
  else the deployment default;
- an `A2AServer` on the shared `TaskStore`, with its own endpoint
  (`/a2a/<id>`) and card route (`/a2a/<id>/agent-card.json`);
- an `A2aRoutes` registration (enable/disable), an `ExecutorSet`
  (session/subagent), and a `LiveInboundRegistry` for peer monitoring.

The manager owns the full lifecycle: `add` (persist + assemble + enable),
`update` (persist + rebuild card + swap), `setEnabled` (route enable/disable),
`remove` (dispose + unpersist). Skill defaults (`defaultSkillFor`) apply at
creation: declared skills verbatim, else the preset display name, else
`chat`.

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
  DSH web shell via the client bundle. It renders the inbound/outbound server
  lists (with preset pickers, skill-declaration textarea, auth env inputs) and
  task/peer views.
- **Loopback API** (`/a2a/api`) — GET returns a snapshot (inbound/outbound
  server views, tasks, peers); `GET /a2a/api/presets` returns the agent-preset
  roster for the pickers; POST dispatches control actions
  (inbound.create/update/remove/enable/disable, outbound.create/remove/
  enable/disable/refresh, task.cancel, inbound.close). Non-loopback callers
  get 403. The GUI, the `/a2a` command, and `ctx.a2a` consumers all share the
  same facade implementation.

## Security model

- Each inbound instance's bearer token is an **env-var name**
  (`authTokenEnv`), resolved at boot; never stored as plaintext.
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
  design).

## Tests

- `tests/unit/` — protocol constants, JSON-RPC/SSE framing, card assembly and
  skill defaults, store (incl. write-chain visibility regressions), executor
  resolution, A2A server (dispatch, gate, auth, cancel, streaming), inbound
  registry, outbound client and registry (stubbed fetch), dashboard API.
- `tests/composition/` — boots `apply()` on a real Cordis `Context` with stub
  host services: multi-instance assembly, per-instance route registration,
  the declared-skill gate, `a2a/inbound-task` vetoes, task persistence,
  outbound tool registration, instance CRUD/removal.