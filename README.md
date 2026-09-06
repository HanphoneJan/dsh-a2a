# dsh-a2a

Agent2Agent (A2A) Protocol v1.0 dual-end plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — **English** · [中文](README.zh.md)

`@hanphone/dsh-a2a` is an independent, open-source A2A plugin that turns a
DeepSeek Harness profile into a first-class agent-to-agent citizen: an inbound
server with a durable governed task store and a live-derived AgentCard, an
outbound client whose remote skills appear as model tools, and a GUI
dashboard that manages both halves without touching any file.

Architecture and design decisions: [docs/architecture.md](docs/architecture.md).

## Features

- **A2A v1.0 protocol surface** — `SendMessage`, `SendStreamingMessage`,
  `GetTask`, `ListTasks`, `CancelTask`, `GetExtendedAgentCard`,
  `SubscribeToTask` over JSON-RPC; SSE streaming with catch-up frames.
- **Dynamic AgentCard** — skills derived from the live `ctx.tools` registry
  (explicit id list, loud failure on missing referents) plus a built-in
  `chat` skill; a fresh install answers end-to-end immediately.
- **Durable task store** — tasks live in the `a2a` storage domain (JSON
  backend by default, SQLite per deployment choice); server-generated ids
  survive restarts.
- **Executors** — `session` (one DSH session per `contextId`) and `subagent`
  (delegates to `ctx.subagents`, streams tool-call artifacts back).
- **Governed inbound** — every inbound task passes through the
  `a2a/inbound-task` waterfall so policy plugins can veto or audit.
- **Inbound connection monitoring** — the dashboard shows which remote peers
  are talking to this DSH (source, first/last seen, task counts, active
  streams) and can close a peer.
- **Runtime service identity** — edit the AgentCard's name/description/version
  from the dashboard; the card rebuilds immediately and the identity persists
  across restarts.
- **First-run onboarding** — a fresh install shows a pre-filled identity form
  ("service identity") so publishing the service is one click.
- **Auth by environment variable** — inbound bearer token is referenced by
  env-var name (`authTokenEnv`), never stored in config as plaintext.
- **Install-and-use** — both halves are enabled by default after
  `dsh plugin add`; no manual patch required to start.

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
dsh plugin --profile <name> add <path-to>/hanphone-dsh-a2a-0.2.0.tgz
```

## Quick start

1. **Install** — `dsh plugin --profile web add @hanphone/dsh-a2a`.
2. **Restart the GUI** — the browser half is scanned at host startup, so
   restart once after installing (`pnpm dsh web` or your profile launcher).
3. **Open Settings → A2A 连接** — the dashboard shows the inbound server
   status, the service identity (with first-run onboarding pre-filled), the
   outbound agent list, inbound peer connections, and the task list.

The inbound server listens on the profile's webServer (default
`http://127.0.0.1:3080`):

```sh
curl http://127.0.0.1:3080/.well-known/agent-card.json
```

Send a task (the built-in `chat` skill):

```sh
curl -X POST http://127.0.0.1:3080/a2a \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"role":"user","parts":[{"text":"hello"}],"metadata":{"skill":"chat"}}}}'
```

## GUI dashboard

The browser half registers an **A2A 连接** page under Settings. From it you
can, without touching any file:

- toggle the inbound server;
- view and edit the service identity (name/description/version) — the
  AgentCard rebuilds immediately and the change persists;
- list, add, enable/disable, refresh, and remove outbound agents;
- see which inbound peers are connected (source, activity, tasks) and close
  one;
- view and cancel inbound tasks.

All dashboard traffic goes through the **loopback-only** `/a2a/api` route —
remote peers can never drive it.

## Configuration

The dashboard covers day-to-day operations. Values the dashboard does not
edit (baseUrl, `authTokenEnv`, skills, executors, toolPrefix) are configured
through the profile's user patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`)
— the reserve path:

```yaml
- id: a2a
  config:
    server:
      enabled: true
      name: My DSH Agent
      description: A DeepSeek Harness agent exposed over A2A v1.0
      version: 0.1.0
      baseUrl: http://127.0.0.1:<port>   # omit to derive from the webServer address
      endpointPath: /a2a
      authTokenEnv: A2A_INBOUND_TOKEN    # optional; an env var NAME, never the token
      skills:
        ids: []                          # explicit tool ids to expose; chat is built-in
        exclude: []
      executors:
        chat: session                    # or subagent (needs the subagent seam)
      subagentProvider: in-process
    client:
      toolPrefix: a2a
      agents: []                         # or declare agents declaratively
```

### Required host services

Base-backed profiles mount them all: `webServer` (`@deepseek-ai/dsh-host-webserver`),
the storage stack (`@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-domain`),
the tools registry (`@deepseek-ai/dsh-tools`), and an agent loop
(`@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop`; the subagent
executor additionally needs `@deepseek-ai/dsh-subagent`).

### Storage backend

The task store lives in the `a2a` storage domain. The base composition routes
storage through the `json` backend; to use SQLite, route the domain and add
the backend in the same patch layer:

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

### Outbound agents (file-declared, optional — the GUI manages the same list)

```yaml
- id: a2a
  config:
    client:
      toolPrefix: a2a
      agents:
        - name: my-remote-agent
          agentCardUrl: https://remote.example/.well-known/agent-card.json
          bearerTokenEnv: A2A_REMOTE_TOKEN   # optional; env var NAME
          enabled: true
          timeoutMs: 60000
```

Each enabled remote agent's skills become model tools named
`a2a__<name>__<skill>` (normalized, collision-hashed). The registry persists
across restarts.

## CLI

A `/a2a` chat command mirrors the dashboard:

```
a2a status | enable | disable | card | agents |
    agent add|remove|enable|disable|refresh |
    tasks | task get|cancel <id> | help
```

## How it works

- **Inbound** — `POST /a2a` (JSON-RPC) and `GET /.well-known/agent-card.json`;
  the AgentCard derives from the live tool registry and carries the persisted
  service identity. Tasks flow through `a2a/inbound-task` → executor → task
  store, with SSE frames streamed to subscribers.
- **Outbound** — a persisted `agents` table in the `a2a` domain; `A2AClient`
  discovers an AgentCard, and each skill registers as a tool.
- **Dashboard** — the browser half (React, `settings.section`) reads/writes
  the loopback-only `/a2a/api` route; the host half feeds it snapshots of the
  server, tasks, agents, inbound peers, and the service identity.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Directory structure

```
src/
  api.ts                  # loopback dashboard API (/a2a/api)
  index.ts                # Cordis plugin entry (apply)
  protocol.ts             # A2A v1.0 protocol constants + types
  jsonrpc.ts              # JSON-RPC framing
  server/                 # inbound half: store, card, a2a-server, routes,
                          #   executors, inbound-registry, identity
  outbound/               # outbound half: A2AClient, registry, tools
  client/                 # browser half: settings dashboard (React)
  service.ts              # ctx.a2a service facade
  commands.ts             # /a2a chat command
tests/
  unit/                   # protocol, framing, card, store, registry, server,
                          #   client, api, inbound-registry, identity
  composition/            # apply() on a real Cordis Context with stub host services
cordis.patch.yml          # bundle patch (mounts the plugin, enabled by default)
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
derivation from the tool registry, and the settings-dashboard pattern — set
the direction this implementation follows. Our protocol layer, task store,
and executor seam are independent implementations; the GUI management model
owes a direct debt to ryubyte's connection dashboard.

## License

MIT