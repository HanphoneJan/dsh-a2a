---
name: Concepts
description: The A2A model, inbound servers, outbound connections, presets, skills, tasks, contexts, executors and the AgentCard
update-time: 2026-10-25
---

# Concepts

**English** · [中文](concepts.zh.md)

This page defines the vocabulary the rest of the manual uses. Exact wire fields
are in the [HTTP API reference](../reference/http-api.md); operational
configuration is in [Operations](operations.md).

## A2A in one paragraph

Agent2Agent (A2A) is an HTTP + JSON-RPC protocol for one agent to call another.
A **server** publishes an AgentCard describing its identity, endpoint and
skills. A **client** reads the card, sends a message to the endpoint, and waits
for the task to settle or subscribes to updates. This plugin implements the A2A
`1.0.1` JSON-RPC binding and declares protocol version `1.0`; the gRPC and
HTTP+JSON bindings are not implemented.

## The two directions

| Direction | Who calls whom | Plugin surface |
|---|---|---|
| **Inbound** | A remote A2A client calls this DSH | One **inbound server** per published agent |
| **Outbound** | This DSH calls a remote A2A agent | One **outbound connection** per remote card |

The directions are independent. A profile can have any number of each, pointing
at other DSH instances or at non-DSH A2A agents.

## Inbound server

An inbound server instance is one published agent. It owns:

- an **endpoint** at `/a2a/<id>`;
- an **AgentCard** at `/a2a/<id>/agent-card.json`;
- the card's **name**, description and version;
- an **agent preset** that composes every DSH session behind the endpoint;
- the **skills** derived from that preset;
- an optional **bearer token**;
- an **enabled** flag that registers or unregisters its routes.

Instances are created, edited, enabled, disabled and deleted from the panel or
the `/a2a` command, and are persisted. A restart reassembles them and
re-registers the enabled ones.

## Outbound connection

An outbound connection is one remote agent this DSH can call. It owns:

- the remote **AgentCard URL**;
- a local **name** that becomes a tool-name segment;
- the imported **skills**, each registered as a model tool;
- an optional **bearer token**;
- a **timeout** for calls to that remote;
- an optional **preset** (recorded metadata, see below);
- an **enabled** flag.

Connecting fetches the card, imports its skills and registers one tool per
enabled skill. A failed connection stays in the panel with `lastError` and can
be refreshed or edited.

The outbound `preset` is persisted and shown in the panel, but the current tools
call the remote directly: no local hand-off session is composed from it yet.

## Presets and skills

A **preset** is a DSH agent preset: a named composition of instructions, tools,
skills and model defaults. An inbound instance binds one preset and composes a
fresh DSH session from it for each A2A context.

**Skills are derived, not typed.** At create, update and boot the plugin:

1. resolves the preset and its standing scope key
   (`agentPresets.standingKeyFor`);
2. lists the skills visible to that preset (`ctx.skills.list({ scope })`);
3. advertises the entries whose `invocation.modelInvocable` is not `false`.

If the preset or skills service is unavailable, or the catalogue is empty, the
card falls back to one built-in `chat` skill. `chat` is also the default routing
target when a request omits `message.metadata.skill`. A request naming a skill
outside the advertised set is rejected by the gate before execution.

The same gate dispatches every inbound task through the
`a2a/inbound-task` waterfall, where a policy plugin can reject it.

## Tasks and contexts

An inbound `SendMessage` creates a **task**:

- the task id is `a2a-<uuid>`;
- the context id comes from the caller or is generated;
- the task records its skill, input parts, state, artifacts, timestamps and the
  inbound instance it arrived through.

States follow the A2A vocabulary (`TASK_STATE_*`); the table, including which
states are terminal, is in
[the protocol reference](../reference/http-api.md#25-task-states).

A **context** is one conversation. The plugin keeps one live DSH session per
`(instance, contextId)` pair, with the deterministic id
`a2a-<instanceId>-<contextId>`. Reusing a `contextId` on the same instance
reuses that session; a different context or a different inbound instance opens a
different one.

Session handles are memory-only. The panel's **Close** cancels the context's
active tasks and releases the live handle; the next task on the same context
opens a fresh one. Tasks and context→session bindings are durable, so a restart
keeps task history but does not resurrect sessions.

## Executors

The inbound half has one executor seam with two implementations:

- **session** — run one turn on the context's DSH session and return the last
  assistant text. This is the default for every skill.
- **subagent** — delegate the task to `ctx.subagents`. It is wired when
  `agents` and `ctx.subagents` are mounted, but the current skill→executor map
  binds only `chat` to `session`, and unknown skills also default to `session`.
  No public configuration selects `subagent` today.

## AgentCard

The card is a pure function of the instance record, the advertised base URL and
the endpoint path: identity fields, a fixed DeepSeek provider, capabilities,
input/output modes, derived skills and one JSON-RPC `supportedInterfaces` entry.
A configured token adds a `bearer` scheme declaration, never the secret.

The card is served at the instance's `cardPath`. The well-known
`/.well-known/agent-card.json` is not used for instances; use the full
per-instance URL printed by the panel. The exact JSON shape is in the
[protocol reference](../reference/http-api.md#27-agentcard).

## Trust boundary

Dashboard controls are loopback-only; protocol endpoints use per-instance
bearer tokens stored as credential references. See
[Operations: access and security](operations.md#access-and-security).

## What is not implemented

Only the JSON-RPC binding is provided; push notifications, OAuth, mTLS and
per-client credentials are not. The complete list is in
[HTTP API: current limits](../reference/http-api.md#4-current-limits).
