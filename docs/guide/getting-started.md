---
name: Getting started
description: Install @hanphone/dsh-a2a, publish an inbound A2A server, call it with curl, and connect a remote agent as a model tool
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.3.8
relative-docs:
  - docs/guide/concepts.md
  - docs/guide/operations.md
  - docs/reference/http-api.md
---

# Getting started

**English** · [中文](getting-started.zh.md)

This page takes you from a fresh install to two working directions:

1. **Inbound** — another A2A client sends a task to this DSH.
2. **Outbound** — this DSH calls a remote A2A agent as a model tool.

Both directions work from the **Settings → A2A connections** panel. The
`/a2a` chat command and the loopback HTTP API are equivalent control surfaces;
the panel is the primary one.

## 1. Before you start

You need:

- DeepSeek Harness **0.2.1-rc.2** (the version this release is verified
  against) with the `web` profile.
- A running `dsh web` instance. The default address is
  `http://127.0.0.1:3080/`.
- The `dsh` command, or the repository checkout command `pnpm dsh`.

The base `web` profile already mounts the services this plugin needs:
`storageDomain`, `webServer`, `tools`, `agents`, `agentPresets`, `skills`,
and `credentials`. A custom composition that omits one of them idles only the
affected half; see [Operations](operations.md#host-services).

## 2. Install

```sh
dsh plugin --profile web add @hanphone/dsh-a2a
```

If you are working from a harness checkout, use the launcher form:

```sh
cd deepseek-harness
pnpm dsh plugin --profile web add @hanphone/dsh-a2a
```

Restart the web app once (`dsh web`, or `pnpm dsh web`). The browser bundle is
scanned at startup, so a page refresh alone is not enough after installation.

Verify the plugin is mounted:

```text
/a2a status
```

The command prints a JSON snapshot with `inbounds` and `outbounds` arrays.
The same snapshot is available at `GET http://127.0.0.1:3080/a2a/api`.

## 3. Publish your first inbound server

Open **Settings → A2A connections → Inbound servers → New inbound server** and
fill in:

| Field | Meaning |
|---|---|
| Name | Human-readable name shown in the AgentCard and the panel |
| Version | AgentCard version string (default `1.0.0`) |
| Agent preset | The DSH preset that composes sessions for this server. Skills are derived from this preset. |
| Bearer token | Optional. When set, every request must send `Authorization: Bearer <token>`. |
| Description | AgentCard description |

Create the server. The panel shows the endpoint and the AgentCard URL:

```text
http://127.0.0.1:3080/a2a/<id>
http://127.0.0.1:3080/a2a/<id>/agent-card.json
```

Skills are **not typed by hand**. The card advertises the model-invocable
skills of the selected preset's skill directory. When no skills service or
preset mount is available, the card advertises the built-in `chat` skill.

### Verify the card

```sh
curl -sS http://127.0.0.1:3080/a2a/<id>/agent-card.json
```

The response is an A2A `AgentCard` with `name`, `version`,
`supportedInterfaces`, `capabilities`, and `skills`. A bearer-protected server
also advertises the `bearer` security scheme; the token value is never in the
card.

### Send a task

The `SendMessage` method creates a task and **blocks until the task settles**:

```sh
curl -sS http://127.0.0.1:3080/a2a/<id> \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "SendMessage",
    "params": {
      "message": {
        "role": "ROLE_USER",
        "parts": [{ "text": "Reply with exactly OK" }],
        "metadata": { "skill": "chat" }
      }
    }
  }'
```

A successful response contains a task whose `status.state` is
`TASK_STATE_COMPLETED` and whose `artifacts` hold the reply:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "id": "a2a-...",
    "contextId": "...",
    "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "..." },
    "artifacts": [{ "artifactId": "result", "parts": [{ "text": "OK" }] }],
    "metadata": { "skill": "chat" }
  }
}
```

To receive progress frames instead of waiting, send
`SendStreamingMessage` (or `SubscribeToTask`) with
`Accept: text/event-stream`:

```sh
curl -N http://127.0.0.1:3080/a2a/<id> \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "role": "ROLE_USER",
        "parts": [{ "text": "Count to three slowly" }],
        "metadata": { "skill": "chat" }
      }
    }
  }'
```

Each SSE frame is a `data: <StreamResponse>` line; the final frame carries the
settled `task`. See [HTTP API and A2A protocol](../reference/http-api.md#a2a-endpoints)
for the frame vocabulary.

If the inbound server has a bearer token, add:

```sh
-H 'authorization: Bearer <token>'
```

## 4. Connect a remote agent as a tool

You need the remote agent's **AgentCard URL** (for example
`https://remote.example/a2a/<id>/agent-card.json`), plus a bearer token if the
remote requires one.

Open **Settings → A2A connections → Outbound servers**, then:

1. Paste the AgentCard URL (and token, if any) and click **Import**.
2. Review the discovered name, version, description, endpoint, and skills.
3. Confirm the local name, preset, timeout, and click **Connect**.

On success the panel shows `connected`, the number of imported skills, and the
number of registered tools. Each remote skill becomes a model tool:

```text
a2a__<connection-name>__<skill-id>
```

For a connection named `weather` and a remote skill `chat`, the tool is
`a2a__weather__chat`. Its only argument is:

```json
{ "prompt": "the task or instruction to send to the remote agent" }
```

Ask the model to use it, for example:

```text
Use the a2a__weather__chat tool with prompt "Reply with exactly OK" and show
the result verbatim.
```

The tool calls the remote agent over A2A and returns the settled task's text.
A failed remote task raises a tool error with the remote message; an
`INPUT_REQUIRED` or `AUTH_REQUIRED` task is surfaced as text instead of a
throw.

## 5. Check both directions

```text
/a2a inbound list
/a2a outbound list
/a2a tasks
/a2a sessions
```

Or use the panel's **Connections and tasks** tab, which shows inbound peers,
per-`contextId` sessions, and tasks, with cancel and close actions.

## Next steps

- [Concepts](concepts.md) — how presets, skills, tasks, contexts, and executors fit together.
- [Operations](operations.md) — GUI fields, `/a2a` reference, configuration, storage, security.
- [HTTP API and A2A protocol](../reference/http-api.md) — exact payloads and methods.
- [Troubleshooting](troubleshooting.md) — empty replies, 401s, failed connections, missing tools.
