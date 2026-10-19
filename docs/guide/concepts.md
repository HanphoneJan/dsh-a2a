---
name: Concepts
description: The A2A model, inbound servers, outbound connections, presets, skills, tasks, contexts, executors, and the security model
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.4.0
relative-docs:
  - docs/architecture.md
  - docs/guide/operations.md
  - docs/reference/http-api.md
---

# Concepts

**English** · [中文](concepts.zh.md)

This page defines the vocabulary the rest of the manual uses. It describes the
current behavior of `0.4.0`, including places where the implementation is
narrower than the protocol.

## 1. A2A in one paragraph

Agent2Agent (A2A) is an HTTP + JSON-RPC protocol for one agent to call another.
A **server** publishes an AgentCard describing its identity, endpoint, and
skills; a **client** reads the card, sends a message to the endpoint, and waits
for a task to settle (or subscribes to streaming updates). This plugin
implements the A2A `1.0.1` JSON-RPC binding and declares protocol version
`1.0`. It does not implement the gRPC or HTTP+JSON bindings.

## 2. The two directions

| Direction | Who calls whom | Plugin surface |
|---|---|---|
| **Inbound** | A remote A2A client calls this DSH | One **inbound server** per published agent |
| **Outbound** | This DSH calls a remote A2A agent | One **outbound connection** per remote card |

The directions are independent. A profile can have zero or more of each, and
they can point at other DSH instances or at non-DSH A2A agents.

## 3. Inbound server

An inbound server instance is a published agent. It owns:

- an **endpoint** at `/a2a/<id>`;
- an **AgentCard** at `/a2a/<id>/agent-card.json`;
- a **name**, description, and version shown on the card;
- an **agent preset** that composes the DSH sessions behind the endpoint;
- the **skills** derived from that preset;
- an optional **bearer token**;
- an **enabled** flag that registers or unregisters its routes.

Instances are created, edited, enabled, disabled, and deleted from the panel
or the `/a2a` command. They are persisted; a restart re-assembles them and
re-registers the enabled ones.

## 4. Outbound connection

An outbound connection instance is one remote agent this DSH can call. It
owns:

- the remote **AgentCard URL**;
- a local **name** that becomes the tool-name segment;
- the imported **skills**, each registered as a model tool;
- an optional **bearer token**;
- a per-connection **timeout**;
- an optional **preset** (persisted metadata; see §7);
- an **enabled** flag.

On connect, the plugin fetches the card, imports its skills, and registers one
tool per skill. A failed connection stays in the panel with its `lastError`
and can be refreshed or edited.

## 5. Presets and skills

A **preset** is a DSH agent preset: a named composition of instructions,
tools, skills, and model defaults. The inbound server binds one preset and
composes a fresh DSH session from it for each A2A context.

**Skills are derived, not typed.** At create/update/boot, the plugin:

1. resolves the preset and its standing scope;
2. lists the skills visible to that preset;
3. advertises the model-invocable entries on the AgentCard.

If the skills service or preset mount is unavailable, the card falls back to a
single built-in `chat` skill. The same `chat` skill is the default routing
target when a request omits `message.metadata.skill`.

A request whose `metadata.skill` is not in the advertised set is rejected by
the skill gate before execution.

## 6. Tasks and contexts

An inbound `SendMessage` creates a **task**:

- the task id is `a2a-<uuid>`;
- the context id is supplied by the caller or generated;
- the task records its skill, input parts, state, artifacts, timestamps, and
  the inbound server instance that received it.

States follow the A2A vocabulary: `TASK_STATE_SUBMITTED`,
`TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`,
`TASK_STATE_AUTH_REQUIRED`, `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`,
`TASK_STATE_CANCELED`, `TASK_STATE_REJECTED`. The last four are terminal;
`INPUT_REQUIRED` and `AUTH_REQUIRED` are interrupted but not terminal.

A **context** is one conversation. The plugin keeps **one live DSH session per
context**, with the deterministic id `a2a-<contextId>`. Reusing a `contextId`
reuses that session; a different `contextId` opens a different one.

Session handles are memory-only. The panel's **Close** action cancels the
context's active tasks and releases the live handle; the next task on the same
`contextId` opens a fresh handle. Tasks and context→session bindings are
persisted, so a restart keeps task history but does not resurrect sessions.

## 7. Executors

The inbound half has an executor seam with two implementations:

- **session** — run one turn on the context's DSH session and return the last
  assistant text. This is the executor used for every skill in the current
  default composition.
- **subagent** — delegate the task to a configured subagent provider. The
  implementation exists and is wired when `ctx.subagents` is mounted, but the
  current default skill→executor map binds only `chat` to `session`; unknown
  skills also default to `session`. There is no public configuration that
  selects `subagent` today.

On the outbound side, the `preset` field is persisted and shown in the panel,
but current tools call the remote directly: there is no local hand-off session
composition behind it yet. Treat it as forward-looking metadata, not an active
routing rule.

## 8. AgentCard

The card is a pure function of the instance record plus the advertised base URL
and endpoint path:

- `name`, `description`, `version` from the instance;
- `provider` fixed to DeepSeek;
- `capabilities`: streaming `true`, push notifications `false`, extended card
  `true`, state-transition history `false`;
- `defaultInputModes` / `defaultOutputModes`: `text/plain`;
- `skills`: the derived skill list;
- `supportedInterfaces`: one JSON-RPC interface at the instance endpoint,
  protocol version `1.0`;
- when a token is configured, a `bearer` security scheme and requirement,
  with no secret value.

The card is served as JSON at the instance's `cardPath`. The well-known
`/.well-known/agent-card.json` path is not used for instances; use the full
per-instance URL printed by the panel.

## 9. Identity, storage, and sessions

Durable state lives in the `a2a` storage domain:

| Table | Contents |
|---|---|
| `tasks` | Task records, including source instance id |
| `contexts` | `contextId` → `sessionId` bindings |
| `agents` | Per-outbound-instance agent records |
| `identity` | Legacy service identity record |
| `inbound_servers` | Inbound instance records |
| `outbound_servers` | Outbound instance records |

The default backend is the profile's JSON storage; the `a2a` domain can be
routed to SQLite. See [Operations](operations.md#7-storage).

Inbound session working directories live under `$DSH_HOME/a2a-sessions`.
Tasks and instances survive a restart; live sessions and stream subscriptions
do not.

## 10. Security model

- **Dashboard API is loopback-only.** `/a2a/api` accepts only `127.0.0.1`,
  `::1`, or `::ffff:127.0.0.1`; any other peer gets `403`. A remote A2A client
  can call the protocol endpoint but can never drive the control panel.
- **Bearer tokens are credential references, not domain data.** The panel
  writes a token through the harness credentials service under a managed
  name (`A2A_INBOUND_<id>`, `A2A_OUTBOUND_<id>`). The instance record stores
  only that name; the AgentCard stores only the scheme.
- **Resolution is layered.** A token is read from the credentials service
  first, then the process environment, on every operation. Exporting the same
  variable externally keeps working.
- **Inbound auth.** When a token is configured, the endpoint requires
  `Authorization: Bearer <token>` and returns `401` with
  `WWW-Authenticate: Bearer` otherwise. Streaming requests are authorized
  before the `200` SSE headers are written.
- **No OAuth, mTLS, or per-client credentials.** A single shared bearer token
  protects an instance. The protocol's push-notification, gRPC, and OAuth
  capabilities are not implemented.

## 11. What this plugin is not

- It is not a model proxy or a general HTTP gateway.
- It does not route between inbound and outbound automatically; you connect
  them explicitly.
- It does not persist live sessions; only tasks and bindings are durable.
- It does not support A2A push notifications, gRPC, or the HTTP+JSON binding.
- It does not currently expose a local hand-off session for outbound calls.
