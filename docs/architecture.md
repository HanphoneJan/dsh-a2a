---
name: Architecture
description: How the Cordis plugin, inbound and outbound managers, task store, session layer and browser half fit together
update-time: 2026-10-25
---

# Architecture

**English** · [中文](architecture.zh.md)

This page maps the shipped code: one plugin row, two managers, the storage
domain and the browser half. Vocabulary is in [Concepts](guide/concepts.md);
wire details are in the [HTTP API reference](reference/http-api.md).

## Overview

The plugin mounts as one Cordis row, id `a2a`, on any DSH profile that mounts
the standard host services. Its core abstraction is the **server instance**: a
reusable frame of endpoint, identity and skill advertisement, preset binding and
auth, materialized once per inbound direction and once per outbound connection.

```
┌─ GUI (browser, settings.section "A2A 连接") ────────────────────────────┐
│  inbound instances (create/preset/skills/auth/start/stop/edit)         │
│  outbound instances (create/URL/preset/auth/timeout/start/stop)        │
│  metrics · peers · sessions · tasks (view/cancel)                      │
└───────────────────────────────────────┬─────────────────────────────────┘
                                        │ loopback-only /a2a/api
┌─ Host plane ──────────────────────────▼─────────────────────────────────┐
│  InboundServerManager    per instance: preset-bound session pool +      │
│                           A2AServer + A2aRoutes (own endpoint + card)   │
│  OutboundServerManager   per instance: OutboundAgentRegistry (own agent │
│                           store) + remote A2AClient + tools             │
│  A2aDomain (tasks/contexts/agents/inbound_servers/outbound_servers)     │
│  A2aMetrics · ctx.a2a facade · /a2a command                             │
└─────────────────────────────────────────────────────────────────────────┘
```

Only `storageDomain` is injected. Every other host service is probed; a missing
one idles its capability instead of failing the plugin. The per-service effects
are listed in [Operations: host services](guide/operations.md#host-services).

## Module map

| Path | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: `Config`, service probes, manager assembly, dashboard route, teardown |
| `src/service.ts` | `ctx.a2a` facade shared by the command, dashboard and other plugins |
| `src/api.ts` | Loopback `/a2a/api` snapshot, reads and control actions |
| `src/commands.ts` | `/a2a` chat command |
| `src/protocol.ts` | A2A types, methods, task states, error codes, ProtoJSON helpers |
| `src/jsonrpc.ts` | JSON-RPC framing and parse helpers |
| `src/update.ts` | Version read and npm/GitHub update check |
| `src/servers/inbound-manager.ts` | Inbound instance lifecycle, skills derivation, scoped store |
| `src/servers/outbound-manager.ts` | Outbound instance lifecycle, auto-refresh, per-instance registry |
| `src/server/a2a-server.ts` | JSON-RPC dispatch, task lifecycle, SSE, rate limit, auth check |
| `src/server/routes.ts` | HTTP binding: card and endpoint routes, body cap, enable/disable |
| `src/server/card.ts` | Pure AgentCard assembly |
| `src/server/store.ts` | `a2a` domain spec, `DomainTaskStore`, `MemoryTaskStore`, `ScopedTaskStore` |
| `src/server/trace.ts` | Optional trace extension URI, schema types, redaction and bounds |
| `src/server/exec/` | Session pool, session/subagent executors, attachment admission |
| `src/server/executor.ts` | Executor contract and skill→executor resolution |
| `src/server/session-registry.ts` | Per-context session views and SSE stream counts |
| `src/server/inbound-registry.ts` | Live inbound peer registry |
| `src/server/metrics.ts` | Counters and bounded audit ring |
| `src/outbound/calls.ts` | A2A client: card discovery, send/poll/stream, cancel, retries |
| `src/outbound/registry.ts` | Connected agents, per-instance views, tool disposers |
| `src/outbound/tools.ts` | Remote-skill model tools |
| `src/client/` | React settings section, styles, update-status formatting |

## Plugin shape

`apply()` opens the `a2a` domain, builds both managers, registers the facade,
the optional `/a2a` command and the dashboard route, and returns a disposer that
tears every instance down. `Config` only carries host-level defaults; instances
are created through the facade and persisted in the domain.

The package is deliberately **not** a workspace member of the harness checkout.
It keeps its own `package.json`, declares `@deepseek-ai/*` as peers and `zod` as
its only runtime dependency, and typechecks the harness source graph through
project references to built `lib/types` declarations. The build produces
`lib/index.js` for the host and `lib/client.js` for the browser; the browser
bundle is wrapped for `window.__ModuleLoader__.load` by
`scripts/build-client.mjs`.

## Inbound half

### Manager and instance

`InboundServerManager` owns the live set. Each persisted `InboundServerRecord`
(`inbound_servers` table) becomes one live instance at boot:

- a `ContextSessionPool` when `agents` is mounted, composed from the effective
  preset (`record.preset` or the deployment default);
- an `A2AServer` over a `ScopedTaskStore` for this instance, with its own
  endpoint path and card path;
- an `A2aRoutes` registration, an `ExecutorSet`, a `LiveInboundRegistry` and a
  `ContextSessionRegistry`.

The manager owns `add`, `update`, `setEnabled`, `setAuth` and `remove`. `add`
derives skills, resolves the token, assembles, persists and enables. `update`
persists the patch, re-derives skills and auth, then swaps the live instance
while preserving the route state. `setEnabled` registers or unregisters routes
and persists the enabled flag. `remove` disposes and writes an empty tombstone.

### Skills and gate

Skills are derived at add, update and boot: the preset's standing scope key
(`agentPresets.standingKeyFor`) plus `ctx.skills.list({ scope })`, filtered to
`invocation.modelInvocable !== false`. A missing service, a failed mount or an
empty catalogue falls back to the built-in `chat` skill.

The instance's gate first checks that the requested skill is in that derived
set, then dispatches `a2a/inbound-task` as a waterfall. A listener can set
`rejected.reason` to veto the task; the gate also logs the decision.

### Request pipeline

```
POST /a2a/<id> (SendMessage)
  → routes: body cap, then A2AServer.preflight (rate limit, bearer auth)
  → A2A-Version check
  → parseRpc (JSON-RPC 2.0)
  → gate (declared skill + a2a/inbound-task)
  → ensureTask
      contextId + skill (metadata.skill ?? 'chat')
      messageId replay → original task
      taskId continuation → append the visible input, update current parts
      otherwise store.create → taskId a2a-<uuid>, SUBMITTED
  → runTask
      WORKING → executor.execute → events to store and SSE
      COMPLETED with a visible 'result' artifact, or COMPLETED with a status text
      when the turn produced no visible output, or FAILED
      INPUT_REQUIRED / AUTH_REQUIRED leave the task interrupted
  → cancel: CancelTask or facade abort → CANCELED
```

Task access is scoped by `serverId`: a task belonging to another instance is
indistinguishable from a missing task. Context bindings are namespaced with the
instance id, so two instances can reuse the same client `contextId` without
sharing a session.

The server also enforces the configured per-task timeout and per-instance
concurrency cap. A timeout settles the task `FAILED`; an over-quota task fails
with a readable message. Rate limiting is per source address, in process.

### Session layer

One DSH session is kept per `(instance, contextId)`, with the deterministic id
`a2a-<instanceId>-<contextId>`. The pool creates the session through `agents`
and mounts the preset; if the session id already exists, it resumes it. Turns on
one context are serialized.

The first time a context's session opens, the pool persists the
`contextId → sessionId` binding through the task store. A durability failure is
logged and never fails the task.

`SessionView` rows are grouped by `(serverId, contextId)`. Task counts,
running/idle and timestamps come from the durable task store; streaming comes
from per-instance SSE counts; `live` comes from pool handle presence. Rows
therefore survive restarts in a degraded form and still render without an agent
loop. `closeSession` aborts the context's non-terminal tasks and disposes its
handle; the next task re-opens one. Close is not a tombstone.

When an instance allows the optional trace extension and a request activates it,
the session runtime observes `session/event` for `tool/call` and `tool/result`.
It emits only metadata: tool name, phase, status, duration and a redacted
argument preview. The summary is bounded and stored on the task; it never becomes
an artifact, history or outbound tool output. The `subagent` executor does not
observe child tool events.

Each A2A server stamps its instance id on the tasks it creates, which is what
lets the session and task views attribute a row to an inbound instance.

## Storage

`openDomain` opens the `a2a` domain (`tasks`, `contexts`, `agents`,
`inbound_servers`, `outbound_servers`) over the routed storage backend. Records
are JSON strings; the domain's `version` guards format changes.

`DomainTaskStore` keeps a live in-memory view over the domain so synchronous
readers see their own writes before the queued domain write lands. `ScopedTaskStore`
adds the per-instance filter and namespaces context bindings. The backend choice
and operational notes are in [Operations: storage](guide/operations.md#storage).

## Outbound half

`OutboundServerManager` owns one `OutboundAgentRegistry` per persisted
`OutboundServerRecord` (`outbound_servers` table). Each registry has its own
agent store over the `agents` table, keyed `out:<id>`, and its own tool
disposers.

Lifecycle: `add` persists the record, then connects; `setEnabled` toggles the
tools of a live connection and persists the flag; `refresh` re-reads the card;
`update` persists the patch and rebuilds the connection; `setAuth` writes or
clears the credential and rebuilds; `remove` disposes and unpersists. Enabled
instances refresh their card on the configured interval.

For each enabled skill, `registerAgentTools` registers one model tool. The tool
sends a message with a stable per-caller context id, streams when the remote card
advertises streaming, propagates the caller's abort (sending `CancelTask` once a
task id is known), and retries transient transport/5xx failures. A connection
that fails stays in the views as `failed` with `lastError`, so it can be edited
or refreshed.

## Browser half

`src/client/` registers one `settings.section` (`A2A 连接`) through
`ctx.slots.inject`, loaded by the DSH web shell. It is a thin read/write client
for `/a2a/api`: it holds no protocol knowledge and never talks to A2A endpoints.
The host feeds it snapshots of instances, tasks, peers, sessions, presets,
metrics and the update answer. Styling is built on the host's `--dsw-alias-*`
tokens in `dashboard.css.ts`.

The GUI, the `/a2a` command and `ctx.a2a` consumers all call the same facade
implementation, so they cannot disagree about state. The panel polls the
snapshot every three seconds; the version strip asks once and caches the update
answer for six hours.

## Trust boundaries

The control panel is reachable only from loopback; protocol endpoints carry an
optional per-instance bearer token whose value stays in the credentials layer.
See [Operations: access and security](guide/operations.md#access-and-security).
