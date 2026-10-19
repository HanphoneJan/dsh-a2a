---
name: Operations
description: GUI and /a2a command reference, lifecycle semantics, configuration, host services, storage, and exposure
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.3.7
relative-docs:
  - docs/guide/concepts.md
  - docs/reference/http-api.md
  - docs/harness-compatibility.md
---

# Operations

**English** · [中文](operations.zh.md)

This page is the day-to-day reference: where the controls are, what each field
does, how instances behave across restarts, and how to configure storage and
security. It applies to `0.3.7` on DeepSeek Harness `0.2.1-rc.2`.

## 1. Control surfaces

There are three equivalent ways to drive the plugin:

| Surface | Use it for |
|---|---|
| **Settings → A2A connections** | Primary UI: create/edit/enable/disable/delete, inspect peers, sessions, and tasks |
| **`/a2a` command** | Text backup inside a DSH chat session |
| **Loopback `/a2a/api`** | Scripts, tests, and integrations; see [HTTP API](../reference/http-api.md) |

All three call the same facade, so they cannot disagree about state. The panel
refreshes every 3 seconds.

## 2. The panel

### 2.1 Inbound servers

Each card shows the name, endpoint path, preset badge, authentication state,
derived skill chips, and the live AgentCard URL. Actions:

| Action | Effect |
|---|---|
| **Enable / Disable** | Registers or unregisters the card and endpoint routes; the record and session pool stay |
| **Edit** | Changes name/description/version/preset/token; rebuilds the card/skills and swaps the live instance |
| **Delete** | Disposes the live instance and removes the persisted record |
| **Clear auth** | Removes the stored bearer token and rebuilds the instance anonymously |

The create/edit form has name, version, preset, bearer token, and description.
Skills are shown after creation; you do not type them. The preset picker lists
only real roster presets and preselects the deployment default.

### 2.2 Outbound servers

Adding is a two-phase flow:

1. Enter the remote AgentCard URL (and optional token), click **Import**.
2. Review the discovered name/version/description/endpoint/skills, adjust the
   local name, preset, and timeout, click **Connect**.

Each connected card shows a state dot, the imported skill count, the tool
count, and the last error when failed. Actions: **Enable/Disable**, **Refresh**
(re-read the card and re-register tools), **Edit** (name/preset/timeout/token),
**Delete**.

The token is stored separately through the credentials service; editing with an
empty token field keeps the existing one. **Clear auth** is available in the
inbound form. Outbound has no clear button: send an empty `token` through
`outbound.setAuth`; leaving the edit form's token field empty keeps the
existing token.

### 2.3 Connections and tasks

Three tables:

- **Inbound peers** — who is calling this DSH: source identity, task count and
  active count, streaming indicator, first/last seen, and **Close**.
- **Inbound sessions** — one row per `contextId`: instance, preset, running or
  idle, task/active counts, streaming, first/last seen, **Cancel active**, and
  **Close**.
- **Tasks** — the last 20 tasks with id, skill, source instance, state, and
  **Cancel**.

Semantics:

- **Cancel active** aborts every non-terminal task on the context; the session
  stays open.
- **Close** additionally releases the context's live session handle. It is a
  resource release, not a conversation tombstone: the next task on the same
  `contextId` opens a fresh handle.
- **Close** on a peer drops that peer's registry entry; it does not delete its
  tasks.

## 3. `/a2a` command reference

The command is available in a DSH chat session. Its output is JSON for the list
and status verbs.

| Command | Purpose |
|---|---|
| `/a2a status` | Whole-plugin snapshot |
| `/a2a presets` | Agent-preset roster |
| `/a2a inbound list` | Inbound instances |
| `/a2a inbound create _ <name> [preset] [description]` | Create an inbound instance |
| `/a2a inbound remove <id>` | Remove it |
| `/a2a inbound enable\|disable <id>` | Toggle its routes |
| `/a2a outbound list` | Outbound instances |
| `/a2a outbound create _ <agentCardUrl> [name] [preset]` | Create an outbound connection |
| `/a2a outbound remove <id>` | Remove it |
| `/a2a outbound enable\|disable <id>` | Toggle it |
| `/a2a outbound refresh <id>` | Re-read the remote card |
| `/a2a tasks` | Task list |
| `/a2a task get <taskId>` | One task |
| `/a2a task cancel <taskId>` | Cancel a task |
| `/a2a sessions` | Per-context session views |
| `/a2a session cancel <contextId>` | Cancel the context's active tasks |
| `/a2a session close <contextId>` | Release the context's live session |
| `/a2a peers` | Inbound peer registry |
| `/a2a help` | Usage text |

> **0.3.7 parser quirk.** The `inbound create` and `outbound create` verbs
> currently consume one extra leading token: `rest` is destructured as
> `[action, id, ...args]`, and the create branches read `args[0]` as the
> name/URL. That is why the working forms above include a `_` placeholder
> before the real name/URL. The panel is the recommended creation path; the
> placeholder is only needed when using the command.

Arguments are whitespace-separated; descriptions cannot contain spaces via the
command. Use the panel or the HTTP API for anything richer.

## 4. Lifecycle semantics

- **Create** persists the record, derives skills, resolves auth, assembles the
  runtime, and registers routes when enabled.
- **Update** persists the patch, re-derives skills (preset may have changed),
  re-resolves auth, and replaces the live instance while preserving the
  enabled state.
- **Enable/Disable** only registers/unregisters routes. The record, skills, and
  session pool remain; disabled instances are assembled at boot but not routed.
- **Remove** disposes the live instance and writes an empty tombstone row; the
  instance does not reappear on restart.
- **Outbound connect** fetches the card, registers one tool per skill, and
  persists the record. A failed connect returns an error and keeps a failed
  view for diagnosis; the record is saved before the connect attempt.
- **Outbound refresh** rebuilds the registry from the card and re-registers
  tools. **Edit** rebuilds the connection with the new name/preset/timeout and
  re-applies the stored token.
- **Restart** re-assembles persisted inbound and outbound instances; enabled
  ones resume. Live sessions and stream subscriptions are not restored.

## 5. Configuration

The plugin configuration is intentionally minimal. Instances are **not**
configured in `cordis.patch.yml`; they live in the `a2a` domain and are managed
by the panel.

```yaml
- id: a2a
  config:
    baseUrl: http://127.0.0.1:3080   # optional; derived from webServer when omitted
    subagentProvider: in-process     # default
    defaultTimeoutMs: 60000          # default outbound timeout
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | web server port, then `DSH_A2A_PORT`, then `3000` | Advertised base URL for every inbound AgentCard |
| `subagentProvider` | `in-process` | Provider name for the subagent executor seam |
| `defaultTimeoutMs` | `60000` | Default per-call timeout for outbound connections |

The inbound session working directory is `$DSH_HOME/a2a-sessions` (created on
startup). `DSH_HOME` defaults to `~/.dsh`.

## 6. Host services

Only `storageDomain` is required. Everything else is probed; a missing service
idles the affected capability instead of failing the whole plugin.

| Service | Used by | Effect when absent |
|---|---|---|
| `storageDomain` | both halves | Required; the plugin does not mount |
| `webServer` | inbound routes, dashboard API | Inbound endpoints/card and the panel API are idle |
| `agents` | inbound session executor | Inbound tasks run the `refuse` executor |
| `agentPresets` | preset selection, skill derivation | Preset defaults and derived skills degrade to `chat` |
| `skills` | skill derivation | Card falls back to `chat` |
| `credentials` | token storage/resolution | GUI token writes fail; externally exported env vars still work |
| `subagents` | subagent executor | The subagent executor is not wired |
| `tools` | outbound tool registration | Outbound connections cannot register tools |
| `commands` | `/a2a` | The chat command is not registered |

The base `web` profile mounts all of these. A custom composition should include
`storageDomain`, `webServer`, `agents`, `agentPresets`, `skills`, `tools`, and
`commands` for the full surface.

## 7. Storage

The `a2a` domain defaults to the profile's JSON backend. Tables and their
contents are listed in [Concepts](../guide/concepts.md#9-identity-storage-and-sessions).

To route only the `a2a` domain to SQLite:

```yaml
- id: storage-domain
  config:
    backend: json
    routes:
      a2a: sqlite
- insert:
    - id: storage-sqlite
      name: '@deepseek-ai/dsh-storage-sqlite'
      config:
        path: /absolute/path/to/a2a.sqlite
```

Operational notes:

- **One writer per `DSH_HOME`.** Two DSH processes sharing a home write the same
  JSON domain; do not run two instances against one storage root.
- **Tasks and instances persist.** Live sessions, stream subscriptions, and
  peer registries are in-memory and reset on restart.
- **The domain stores JSON strings**, so schema changes are guarded by the
  domain's `version` field. Back up the JSON/SQLite file before upgrades.
- **Session logs** for inbound contexts are written under
  `$DSH_HOME/sessions/...` by the normal DSH session persistence; the plugin's
  working directory is `$DSH_HOME/a2a-sessions`.

## 8. Exposure and security

- The dashboard API is **loopback-only** by construction. Putting the web app
  behind a reverse proxy does not make `/a2a/api` remotely callable.
- The A2A endpoints ride the same web server as the GUI. If you expose that
  server to a network, configure a bearer token on every inbound instance and
  terminate TLS at the proxy. The plugin does not add TLS or rate limiting.
- Tokens are stored through the credentials service and referenced by name.
  They are never written to the `a2a` domain or the AgentCard.
- Use a distinct token per inbound instance so one leak does not grant access
  to every published agent.
- Outbound tokens are resolved per call, so rotating the credential takes
  effect on the next tool call; no restart is required.

## 9. Upgrade and uninstall

Upgrade:

```sh
dsh plugin --profile web add @hanphone/dsh-a2a@latest
```

Restart `dsh web` after the install. Instances and tasks live in the domain and
survive the upgrade; live sessions do not.

Uninstall:

```sh
dsh plugin --profile web remove @hanphone/dsh-a2a
```

Removing the plugin leaves the `a2a` domain data in place. Delete the domain
rows (or the storage file) only if you intend to discard instance definitions
and task history.

## 10. Compatibility

The plugin declares peer ranges for the DSH versions it supports. DSH 0.1.7+
runs a peer preflight and refuses a plugin whose ranges do not cover the
running version. Upgrade the plugin and the harness together when the preflight
complains; do not widen ranges without running the compatibility procedure.

See [Harness compatibility](../harness-compatibility.md) for the exact ranges,
the verification procedure, and the release record.
