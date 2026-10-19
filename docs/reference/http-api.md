---
name: HTTP API and A2A protocol
description: Loopback dashboard actions, inbound JSON-RPC endpoints, SSE streaming, task states, error codes, AgentCard, and outbound tool contracts
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.3.8
relative-docs:
  - docs/guide/getting-started.md
  - docs/guide/concepts.md
  - docs/architecture.md
---

# HTTP API and A2A protocol

**English** · [中文](http-api.zh.md)

This page is the wire-level reference for `0.3.8`. It has two parts:

1. the **loopback dashboard API** the panel uses (`/a2a/api`);
2. the **A2A endpoints** published by inbound servers (`/a2a/<id>`).

The dashboard API is a control surface. The A2A endpoints are the protocol the
outside world speaks. They are separate: a remote client can call an inbound
endpoint but cannot drive the dashboard.

## 1. Dashboard API

Base path: `/a2a/api`. It is mounted on the profile web server and accepts only
loopback peers (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Any other peer gets
`403`.

### 1.1 Read endpoints

| Method and path | Returns |
|---|---|
| `GET /a2a/api` | Snapshot: `{ inbounds, outbounds, tasks, peers, sessions }` |
| `GET /a2a/api/presets` | Agent-preset roster: `[{ id, name?, description?, isDefault? }]` |

Snapshot example (values abbreviated):

```json
{
  "inbounds": [
    {
      "id": "e2e-b-ade6a7ad",
      "name": "b-server",
      "description": "B inbound",
      "version": "0.1.0",
      "endpointPath": "/a2a/e2e-b-ade6a7ad",
      "preset": "standard",
      "cardPath": "/a2a/e2e-b-ade6a7ad/agent-card.json",
      "cardUrl": "http://127.0.0.1:3081/a2a/e2e-b-ade6a7ad",
      "enabled": true,
      "skills": [{ "id": "chat", "name": "chat", "description": "..." }]
    }
  ],
  "outbounds": [
    {
      "id": "out-2c6d9dbd-cf6",
      "name": "b",
      "agentCardUrl": "http://127.0.0.1:3081/a2a/e2e-b-ade6a7ad/agent-card.json",
      "enabled": true,
      "timeoutMs": 60000,
      "state": "connected",
      "skillCount": 1,
      "toolCount": 1
    }
  ],
  "tasks": [],
  "peers": [],
  "sessions": []
}
```

### 1.2 Control actions

`POST /a2a/api` with a JSON body whose `action` is one of the following.

#### Inbound

| Action | Required fields | Optional fields |
|---|---|---|
| `inbound.create` | `name`, `description`, `version` | `endpointPath`, `preset`, `authTokenEnv`, `enabled` |
| `inbound.update` | `id` | `name`, `description`, `version`, `endpointPath`, `preset`, `authTokenEnv` |
| `inbound.remove` | `id` | — |
| `inbound.enable` / `inbound.disable` | `id` | — |
| `inbound.setAuth` | `id` | `token` (omit or empty to clear) |
| `inbound.close` | `id` (peer id) | — |

#### Outbound

| Action | Required fields | Optional fields |
|---|---|---|
| `outbound.create` | `name`, `agentCardUrl` | `bearerTokenEnv`, `preset`, `enabled`, `timeoutMs` |
| `outbound.update` | `id` | `name`, `preset`, `timeoutMs` |
| `outbound.remove` | `id` | — |
| `outbound.enable` / `outbound.disable` | `id` | — |
| `outbound.refresh` | `id` | — |
| `outbound.setAuth` | `id` | `token` (omit or empty to clear) |
| `outbound.discover` | `agentCardUrl` | `token` |

#### Tasks and sessions

| Action | Required fields | Effect |
|---|---|---|
| `task.cancel` | `id` (task id) | Aborts and marks the task canceled |
| `session.cancel` | `id` (context id) | Cancels the context's active tasks |
| `session.close` | `id` (context id) | Cancels active tasks and releases the live session handle |

### 1.3 Responses and status codes

A successful control action returns `200` with:

```json
{ "ok": true, "message": "inbound server \"b-server\" created", "id": "b-server-..." }
```

`inbound.create` and `outbound.create` include `id`; `outbound.discover`
includes a `preview` object with the remote name, version, description,
endpoint, and skills. A failed action returns `409` with `{ ok: false,
message, ... }`.

| Status | Meaning |
|---|---|
| `200` | Action succeeded, or read succeeded |
| `400` | Body is not valid JSON |
| `403` | Caller is not loopback |
| `405` | Method other than `GET`/`POST` |
| `409` | Action failed (for example, unknown id or failed connect) |

### 1.4 Examples

Create an inbound instance:

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{
    "action": "inbound.create",
    "name": "reports",
    "description": "Reporting agent",
    "version": "0.1.0",
    "preset": "standard",
    "enabled": true
  }'
```

Set its bearer token:

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{ "action": "inbound.setAuth", "id": "reports-1a2b3c4d", "token": "s3cr3t" }'
```

Discover a remote card without creating a connection:

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{ "action": "outbound.discover", "agentCardUrl": "https://remote.example/a2a/x/agent-card.json" }'
```

Create the connection:

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{
    "action": "outbound.create",
    "name": "remote",
    "agentCardUrl": "https://remote.example/a2a/x/agent-card.json",
    "timeoutMs": 60000
  }'
```

## 2. A2A endpoints

An inbound instance publishes:

| Path | Method | Purpose |
|---|---|---|
| `/a2a/<id>/agent-card.json` | `GET` | AgentCard JSON |
| `/a2a/<id>` | `POST` | JSON-RPC endpoint |

The endpoint is prefix-registered by the instance's `endpointPath` (default
`/a2a/<id>`). Disabling the instance unregisters both routes.

### 2.1 Authentication

Without a token, no `Authorization` header is required. With a token, every
request must send:

```http
Authorization: Bearer <token>
```

A missing or wrong token gets `401` with `WWW-Authenticate: Bearer`. Streaming
requests are authorized before the `200` SSE headers are written, so a `401`
is still a clean HTTP status.

### 2.2 Methods

The endpoint speaks the A2A `1.0.1` JSON-RPC binding. Method names are
PascalCase.

| Method | Parameters | Behavior |
|---|---|---|
| `SendMessage` | `message` | Creates a task and **blocks until terminal/interrupted**; returns the task |
| `SendStreamingMessage` | `message` | Creates a task and streams frames; requires `Accept: text/event-stream` |
| `GetTask` | `id` | Returns one task |
| `ListTasks` | none (params ignored) | Returns every task in the store |
| `CancelTask` | `id` | Cancels a non-terminal task; terminal tasks return `TASK_CANCEL_NOT_ALLOWED` |
| `SubscribeToTask` | `id` | Streams an existing task's current status and terminal state; requires SSE |
| `GetExtendedAgentCard` | none | Returns the same AgentCard |

Unsupported methods (including the push-notification configuration methods)
return `METHOD_NOT_FOUND`. The card advertises
`capabilities.pushNotifications: false`.

### 2.3 Message shape

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "optional-uuid",
      "contextId": "optional-uuid",
      "role": "ROLE_USER",
      "parts": [{ "text": "hello" }],
      "metadata": { "skill": "chat" }
    }
  }
}
```

- `parts` may be text, file, or data parts; the session executor renders them
  to text (`partsToText`), with file parts becoming their URL/name and data
  parts becoming JSON.
- `metadata.skill` selects the advertised skill; it defaults to `chat` and is
  rejected by the gate when not in the advertised set.
- `contextId` is the conversation key. Reusing it reuses the live DSH session;
  omitting it generates a new context.
- `messageId` is optional at runtime; the server generates task identities.

### 2.4 Streaming

Send with `Accept: text/event-stream`:

```sh
curl -N http://127.0.0.1:3080/a2a/<id> \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "SendStreamingMessage",
    "params": { "message": { "role": "ROLE_USER", "parts": [{ "text": "hello" }] } }
  }'
```

Frames are unnamed SSE `data:` lines. Each payload is a `StreamResponse`:

- `{ "statusUpdate": { taskId, contextId, status } }`
- `{ "artifactUpdate": { taskId, contextId, artifact, lastChunk } }`
- `{ "task": { ... } }` (the final settled task)

`SubscribeToTask` uses the same transport and replays the current status before
streaming to the terminal state.

### 2.5 Task states

| State | Terminal? | Meaning |
|---|---|---|
| `TASK_STATE_SUBMITTED` | No | Task recorded, not started |
| `TASK_STATE_WORKING` | No | Executor running |
| `TASK_STATE_INPUT_REQUIRED` | No (interrupted) | Remote agent needs more input |
| `TASK_STATE_AUTH_REQUIRED` | No (interrupted) | Remote agent needs authentication |
| `TASK_STATE_COMPLETED` | Yes | Finished with artifacts |
| `TASK_STATE_FAILED` | Yes | Execution failed; status message carries the error |
| `TASK_STATE_CANCELED` | Yes | Canceled by the caller or the session panel |
| `TASK_STATE_REJECTED` | Yes | Rejected before execution |

### 2.6 Error codes

| Code | Name |
|---|---|
| `-32700` | `PARSE_ERROR` |
| `-32600` | `INVALID_REQUEST` |
| `-32601` | `METHOD_NOT_FOUND` |
| `-32602` | `INVALID_PARAMS` |
| `-32603` | `INTERNAL_ERROR` |
| `-32001` | `TASK_NOT_FOUND` |
| `-32002` | `TASK_CANCEL_NOT_ALLOWED` |
| `-32003` | `PUSH_NOTIFICATION_NOT_SUPPORTED` |
| `-32004` | `UNSUPPORTED_OPERATION` |
| `-32005` | `CONTENT_TYPE_NOT_SUPPORTED` |
| `-32006` | `STREAMING_NOT_SUPPORTED` |
| `-32007` | `VERSION_NOT_SUPPORTED` |
| `-32008` | `INVALID_AGENT_RESPONSE` |
| `-32040` | `UNAUTHORIZED` (HTTP 401 mapping) |

The current dispatch uses a subset: `INVALID_REQUEST`, `INVALID_PARAMS`,
`METHOD_NOT_FOUND`, `INTERNAL_ERROR`, `TASK_NOT_FOUND`,
`TASK_CANCEL_NOT_ALLOWED`, and the `401` mapping.

### 2.7 AgentCard

```json
{
  "name": "reports",
  "description": "Reporting agent",
  "version": "0.1.0",
  "provider": { "url": "https://deepseek.com", "organization": "DeepSeek" },
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extendedAgentCard": true,
    "stateTransitionHistory": false
  },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{ "id": "chat", "name": "chat", "description": "..." }],
  "supportedInterfaces": [
    {
      "url": "http://127.0.0.1:3080/a2a/<id>",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ]
}
```

With a bearer token, the card additionally carries a `bearer` security scheme
and requirement. It never carries the token value.

## 3. Outbound tool contract

Each connected remote skill becomes a model tool:

```text
a2a__<connection-name>__<skill-id>
```

Names are normalized to `[A-Za-z0-9_-]` (other characters become `_`), truncated
to 64 characters, and disambiguated with a hash on collision. The argument
schema is:

```json
{
  "prompt": "The task or instruction to send to the remote agent."
}
```

The tool sends an A2A `SendMessage` with a stable per-caller `contextId`, waits
for the task, and returns the artifact text. A `FAILED` task throws a tool
error with the remote message; `INPUT_REQUIRED` and `AUTH_REQUIRED` are
returned as text so the model can react.

## 4. Current limits

These are intentional or known at `0.3.8`; do not assume otherwise:

- `SendMessage` always blocks; the declared `returnImmediately` option is not
  honored.
- `historyLength` is not honored; `GetTask` returns no history array.
- `ListTasks` ignores filters and pagination and returns the whole task store.
- Push notifications are not implemented; the push-config methods return
  `METHOD_NOT_FOUND`.
- Only the JSON-RPC binding is implemented (no gRPC or HTTP+JSON).
- No OAuth, mTLS, per-client credentials, or rate limiting.
- The outbound `preset` is persisted metadata; there is no local hand-off
  session behind outbound tools yet.
- The `subagent` executor exists but is not selected by the default skill map.
