# dsh-a2a

Agent2Agent (A2A) Protocol v1.0.1 dual-end plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — **English** · [中文](README.zh.md)

`@hanphone/dsh-a2a` is an independent, open-source A2A plugin that turns a
DeepSeek Harness profile into a multi-faced agent-to-agent citizen: it can
simultaneously serve **multiple inbound A2A servers**, each bound to its own
agent preset with its own endpoint, AgentCard, preset-derived skills and auth, and
connect to **multiple outbound A2A servers**, each with its own preset, whose
remote skills appear as model tools. Every server instance is created,
started, stopped, edited and removed entirely from the GUI — no config-file
editing.

Architecture and design decisions: [docs/architecture.md](docs/architecture.md).

## Features

- **A2A v1.0.1 protocol surface, aligned with the official spec** —
  `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
  `GetExtendedAgentCard`, `SubscribeToTask` over JSON-RPC; SSE streaming with
  catch-up frames; official `TASK_STATE_*` / `ROLE_*` enums and AgentCard
  structure (including `supportedInterfaces`, `capabilities`, full error-code
  table).
- **Multiple inbound servers** — one per persona. Each instance gets its own
  endpoint (`/a2a/<id>`), AgentCard route, authentication env, and skill
  declarations.
- **Per-instance agent preset** — every inbound server binds one concrete
  agent preset (e.g. `ptc`, `standard`, `minimal`, …); the picker lists only
  real roster presets (matching the in-app selector) and defaults to the
  deployment default. Inbound tasks execute in sessions composed from that
  preset through the standard `agentPresets` resolve+mount path.
- **Preset-derived skill declarations** — the AgentCard's skills are the
  model-invocable entries of the bound preset's skill directory
  (`agentPresets.standingKeyFor` + `ctx.skills.list`), derived automatically —
  "the preset decides its skills; everything is a plugin". No typed skill form;
  a missing skills service falls back to the built-in `chat` skill. Remotes
  call a skill via `metadata.skill`, and the preset session executes it
  through its `tool-skill` loader.
- **Multiple outbound servers** — each connection has its own remote URL,
  auth env, timeout and preset; enabled instances map remote skills
  to `a2a__<name>__<skill>` model tools.
- **Durable task store** — tasks live in the `a2a` storage domain (JSON
  backend by default, SQLite per deployment choice); server-generated ids
  survive restarts, and each task records the inbound server it arrived
  through.
- **Executors** — `session` (one DSH session per `contextId`) and `subagent`
  (delegates to `ctx.subagents`, streams tool-call artifacts back).
- **Governed inbound** — every inbound task passes through the
  `a2a/inbound-task` waterfall so policy plugins can veto or audit.
- **Inbound connection monitoring** — the dashboard shows which remote peers
  are talking to each instance and can close a peer.
- **Inbound session layer (per context)** — each A2A conversation
  (`contextId`) maps to one live DSH session (`a2a-<contextId>`); the GUI
  aggregates sessions by contextId (status, task counts, streaming, first/last
  activity) and can cancel a session's active tasks or close its live session
  — close is an in-memory release, the next task on the same contextId simply
  re-opens a fresh one. All-in-memory, like the peer registry; without an
  agent loop the table still renders from task records (degraded).
- **Direct bearer-token entry** — the GUI's Bearer Token field writes each
  instance's token through the harness credentials service (managed `.env` /
  credential store, `0o700`); the record keeps only an auto-generated env-var
  name and the value never lands in the a2a domain or the AgentCard. Runtime
  resolution layers credentials → process environment, so externally exported
  env vars keep working.
- **Minimal plugin config** — instances are created through the GUI and live
  in the domain; the plugin `Config` only carries host-level defaults
  (`baseUrl`, `subagentProvider`, `defaultTimeoutMs`).

## Installation

### From npm

```sh
dsh plugin --profile web add @hanphone/dsh-a2a
```

Any profile name works (`web`, custom profiles, headless etc.):

```sh
dsh plugin --profile <name> add @hanphone/dsh-a2a
```

### From a local build

```sh
cd dsh-a2a
pnpm build
npm pack
dsh plugin --profile <name> add <path-to>/hanphone-dsh-a2a-<version>.tgz
```

## Quick start

1. **Install** — `dsh plugin --profile web add @hanphone/dsh-a2a`.
2. **Restart the GUI** — the browser half is scanned at host startup, so
   restart once after installing (`pnpm dsh web` or your profile launcher).
3. **Open Settings → A2A 连接** — create your first inbound server (pick a
   preset — its skills are derived automatically — optionally set an auth
   env). It is enabled immediately and publishes its own endpoint and
   AgentCard.

Each inbound server listens on the profile's webServer:

```sh
# the created instance's AgentCard (see the GUI for the exact id)
curl http://127.0.0.1:3080/a2a/<id>/agent-card.json
```

Send a task to an instance (its declared `chat` skill):

```sh
curl -X POST http://127.0.0.1:3080/a2a/<id> \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"role":"user","parts":[{"text":"hello"}],"metadata":{"skill":"chat"}}}}'
```

## GUI dashboard

The browser half registers an **A2A 连接** page under Settings, organized in
three tabs. From it you can, without touching any file:

- **入站 Servers** — create inbound servers (name/description/version, a
  preset picker listing real roster presets with the deployment default
  preselected, and a Bearer Token field), start/stop, edit (including clearing
  auth), and remove them; each card shows its endpoint, preset badge,
  auth state, preset-derived skill chips and live AgentCard URL.
- **出站 Servers** — add outbound connections with a two-phase flow: enter
  the remote AgentCard URL (± bearer token) → **导入** to preview the remote
  card (name/version/skills/endpoint) → **连接** to confirm; start/stop,
  refresh, edit (name/preset/timeout/token) and remove them. Cards show
  connection state (state dot), tool counts and errors.
- **连接与任务** — the inbound-peer table (who is calling, task counts,
  streaming, close control), the per-context session table (status dot,
  task/active counts, streaming, first/last activity, cancel-active / close
  buttons), and the task list (per-source view, cancel).

All dashboard traffic goes through the **loopback-only** `/a2a/api` route —
remote peers can never drive it.

## Configuration

The GUI covers instance management day-to-day. The plugin `Config` only has
host-level defaults, set through the profile's user patch layer
(`$DSH_HOME/profiles/<name>/cordis.patch.yml`) if you want to override them:

```yaml
- id: a2a
  config:
    baseUrl: http://127.0.0.1:<port>   # omit to derive from the webServer address
    subagentProvider: in-process
    defaultTimeoutMs: 60000            # default outbound connection timeout
```

Instances are **not** configured via patches — they are created in the GUI and
persisted in the `a2a` domain (`inbound_servers` / `outbound_servers` tables).

### Required host services

Base-backed profiles mount them all: `webServer` (`@deepseek-ai/dsh-host-webserver`),
the storage stack (`@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-domain`),
the tools registry (`@deepseek-ai/dsh-tools`), an agent loop
(`@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop`), and agent presets
(`@deepseek-ai/dsh-agent-presets`; the preset pickers and preset-bound session
composition need it). The subagent executor additionally needs
`@deepseek-ai/dsh-subagent`.

### Storage backend

The task and instance stores live in the `a2a` storage domain. The base
composition routes storage through the `json` backend; to use SQLite, route
the domain and add the backend in the same patch layer:

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

## CLI

A `/a2a` chat command mirrors the dashboard (a text backup to the GUI):

```
a2a status | presets | peers |
    inbound list|create|remove|enable|disable |
    outbound list|create|remove|enable|disable|refresh |
    tasks | task get|cancel <id> |
    sessions | session cancel|close <contextId> | help
```

## How it works

- **Inbound** — an `InboundServerManager` owns every instance: one preset-bound
  session pool + `A2AServer` + routes per instance. Each instance persists in
  the `inbound_servers` table and serves its own endpoint + AgentCard. Tasks
  flow through `a2a/inbound-task` → executor → task store, with SSE frames
  streamed to subscribers. A per-instance session registry observes SSE
  lifecycle hooks; the facade folds those live observations over the shared
  task store into per-`contextId` session views.
- **Outbound** — an `OutboundServerManager` owns every connection: one
  `OutboundAgentRegistry` with an isolated agent store per instance,
  persisted in the `outbound_servers` table. `A2AClient` discovers an
  AgentCard, and each skill registers as a tool.
- **Dashboard** — the browser half (React, `settings.section`) reads/writes
  the loopback-only `/a2a/api` route; the host half feeds it snapshots of
  inbound/outbound server views and the preset roster (`/a2a/api/presets`).

See [docs/architecture.md](docs/architecture.md) for the full design.

## Directory structure

```
src/
  api.ts                  # loopback dashboard API (/a2a/api, /a2a/api/presets)
  index.ts                # Cordis plugin entry (apply)
  protocol.ts             # A2A v1.0.1 protocol constants + types
  jsonrpc.ts              # JSON-RPC framing
  servers/                # multi-instance managers
    inbound-manager.ts    #   inbound server instances (CRUD, routes, lifecycle)
    outbound-manager.ts   #   outbound connection instances (CRUD, tools)
  server/                 # single-instance internals: store, card, a2a-server,
                          #   routes, executors, inbound-registry, session-registry
  outbound/               # outbound internals: A2AClient, registry, tools
  client/                 # browser half: settings dashboard (React)
  service.ts              # ctx.a2a service facade
  commands.ts             # /a2a chat command
tests/
  unit/                   # protocol, framing, card, store, registry, server,
                          #   client, api, inbound-registry, identity
  composition/            # apply() on a real Cordis Context with stub host services
cordis.patch.yml          # bundle patch (mounts the plugin; instances are GUI-managed)
```

## Development

> The plugin typechecks against the harness source graph through project
> references; a harness checkout with its built host aggregate is required.

```sh
pnpm typecheck   # host (tsc -b) + client (tsc -p tsconfig.client.json)
pnpm test        # vitest run (unit + composition suites)
pnpm build       # tsc + tsdown → lib/index.js (host) + lib/client.js (browser)
```

## Acknowledgements

This plugin was inspired by and developed alongside
[ryubyte/dsh-a2a](https://github.com/ryubyte/dsh-a2a), an earlier A2A plugin
for DeepSeek Harness. That project's design — dual-end scope, AgentCard
advertisement, and the settings-dashboard pattern — set the direction this
implementation follows. Our protocol layer, task store, and executor seam are
independent implementations; the GUI management model owes a direct debt to
ryubyte's connection dashboard.

## License

MIT