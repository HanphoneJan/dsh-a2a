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

How it works: [docs/architecture.md](docs/architecture.md). Tracking DeepSeek
Harness releases: [docs/harness-compatibility.md](docs/harness-compatibility.md).

## Features

- **A2A v1.0.1 protocol surface, aligned with the official spec** —
  `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
  `GetExtendedAgentCard`, `SubscribeToTask` over JSON-RPC; SSE streaming with
  catch-up frames; official `TASK_STATE_*` / `ROLE_*` enums and AgentCard
  structure (including `supportedInterfaces`, `capabilities`, full error-code
  table).
- **Multiple inbound servers, one preset each** — every instance has its own
  endpoint (`/a2a/<id>`), AgentCard, auth env and bound roster preset; its
  sessions are composed from that preset through the standard
  `agentPresets` resolve+mount path.
- **Preset-derived skills** — the card advertises the model-invocable entries
  of the bound preset's skill directory (`agentPresets.standingKeyFor` +
  `ctx.skills.list`). No typed skill form; a missing skills service falls back
  to the built-in `chat` skill, and remotes select a skill via
  `metadata.skill`.
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
- **Inbound observability** — the dashboard shows live peers and one session
  row per `contextId` (status, counts, streaming, activity) with close/cancel
  actions. Sessions are in-memory; without an agent loop the table degrades to
  task records.
- **Direct bearer-token entry** — the GUI's Bearer Token field writes each
  instance's token through the harness credentials service (managed `.env` /
  credential store, `0o700`); the record keeps only an auto-generated env-var
  name and the value never lands in the a2a domain or the AgentCard. Runtime
  resolution layers credentials → process environment, so externally exported
  env vars keep working.
- **Version display and update check** — the panel shows the plugin version,
  Node runtime and each card's AgentCard version; **Check for updates** asks
  npm and GitHub (six-hour cache, read-only) and prints the two-step update
  command when a newer version exists.
- **Minimal plugin config** — instances are created through the GUI and live
  in the domain; the plugin `Config` only carries host-level defaults
  (`baseUrl`, `subagentProvider`, `defaultTimeoutMs`).

## Installation

### From npm

```sh
dsh plugin --profile web add @hanphone/dsh-a2a
```

Any profile name works (`web`, custom profiles, headless etc.).

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
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"role":"ROLE_USER","parts":[{"text":"hello"}],"metadata":{"skill":"chat"}}}}'
```

## GUI dashboard

The browser half registers an **A2A 连接** page under Settings: a version/update
strip, inbound server cards (preset, derived skills, auth, live card URL),
outbound connections (two-phase discover → preview → connect), and the
connections/tasks tab (peers, per-context sessions, tasks). All dashboard
traffic goes through the **loopback-only** `/a2a/api` route. The field-by-field
reference is in [Operations](docs/guide/operations.md#2-the-panel).

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

The base profiles mount everything the plugin uses. A custom composition must
provide the storage stack, `webServer`, `tools`, an agent loop, and
`agentPresets`; the per-service effect of a missing mount is listed in
[Operations: host services](docs/guide/operations.md#6-host-services).

### Storage backend

Task and instance stores live in the `a2a` storage domain (JSON by default;
SQLite is a per-domain route). The patch example is in
[Operations: storage](docs/guide/operations.md#7-storage).

## CLI

A `/a2a` chat command mirrors the dashboard (a text backup to the GUI):

```
a2a status | presets | peers |
    inbound list|create|remove|enable|disable |
    outbound list|create|remove|enable|disable|refresh |
    tasks | task get|cancel <id> |
    sessions | session cancel|close <contextId> | help
```

## Directory structure

```
src/
  api.ts                  # loopback dashboard API (/a2a/api, /a2a/api/update, ...)
  index.ts                # Cordis plugin entry (apply)
  protocol.ts             # A2A v1.0.1 protocol constants + types
  jsonrpc.ts              # JSON-RPC framing
  update.ts               # plugin version + npm/GitHub update check
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
                          #   update, client update-status, api, ...
  composition/            # apply() on a real Cordis Context with stub host services
  integration/            # real agent loop + JSONL persistence, mock LLM
  types/                  # compile-time mirror check against real DSH types
scripts/
  e2e-a2a.mjs             # hermetic two-instance A2A smoke
docs/                     # public manual + architecture/compatibility/testing
cordis.patch.yml          # bundle patch (mounts the plugin; instances are GUI-managed)
```

## Documentation

Start at the [documentation index](docs/README.md) (installation, concepts,
operations, HTTP API, troubleshooting). Deep dives: [Architecture](docs/architecture.md),
[Harness compatibility](docs/harness-compatibility.md), and [Testing](docs/testing.md).

## Development

> The plugin typechecks against the harness source graph through project
> references; a harness checkout with its built host aggregate is required.

```sh
pnpm typecheck   # host + client + compile-time mirror check
pnpm test        # vitest run (unit + composition + real persistence)
pnpm build       # tsc + tsdown → lib/index.js (host) + lib/client.js (browser)
pnpm test:e2e    # hermetic two-instance A2A smoke against the built artifact
pnpm test:all    # typecheck + test + build + e2e
```

Stub tests alone cannot see host-runtime contract drift. The layers, what each
catches, and the e2e flow are in [docs/testing.md](docs/testing.md).

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