# @hanphone/dsh-a2a

Agent2Agent (A2A) Protocol v1.0 dual-end plugin for DeepSeek Harness:
an **inbound server** (AgentCard derived from the live tool registry, JSON-RPC
+ SSE, durable task store, pluggable session/subagent executors, and the
`a2a/inbound-task` policy gate + audit) and an **outbound client**
(persisted multi-agent AgentCard registry, skills mapped to model tools,
sync calls with per-agent timeout).

Design: [docs/design.md](docs/design.md). Scope is P0 per that document.

## Independence

This package is an **independent project**, not a workspace member of the
harness checkout it develops against (the two sit as sibling directories).
It keeps its own `package.json` and dependency graph:

- `@deepseek-ai/*` are **peer dependencies**: a DSH composition that loads the
  plugin provides them at runtime.
- `zod` is the only own runtime dependency (used by the storage-domain record
  schemas).
- Local typecheck/tests resolve the peers through the checkout's
  `tsconfig.base.json` `paths` facade and its built `lib/types` declarations
  (project references). `tsconfig.json` points at `../deepseek-harness/*` for
  the sibling checkout; a fresh checkout must build the host aggregate before
  `pnpm typecheck` here.
- In sandboxes where the shared pnpm store is read-only, `node_modules/zod`,
  `node_modules/@types/node`, `node_modules/vitest`, `node_modules/tsdown`,
  and `node_modules/typescript` are symlinked into the sibling checkout's
  `.pnpm` store; `vitest.config.ts` uses Vite's tsconfig-paths resolution
  through the checkout's `tsconfig.base.json`. Both are dev glue that
  disappears once the plugin installs its own dependencies.

## Development

> Prerequisite: the harness checkout must have its host aggregate built
> (root `pnpm run build:lib:host`, or at least the four referenced projects)
> so declaration outputs exist.

```sh
pnpm typecheck      # tsc -b tsconfig.json --force (emits lib/types)
pnpm test           # vitest run (unit + composition suites)
pnpm build          # tsc -b + tsdown → lib/index.js (bundled, @deepseek-ai/* external)
```

## Enable

### 1. Install the bundle

```sh
cd dsh-a2a
pnpm build
dsh plugin --profile <name> add @hanphone/dsh-a2a   # or a local tarball/package path
```

**Install-and-use**: the bundle's own patch (`cordis.patch.yml`) mounts the
plugin row, id `a2a`, with both halves **enabled by default** — the inbound
server starts listening on the profile's webServer and the outbound client is
live. No manual `cordis.patch.yml` entry is required to get started.

### 2. Operate from the GUI dashboard

The browser half registers an **A2A 连接** page under Settings. From it you
can, without touching any file:

- toggle the inbound server (`server.enable` / `server.disable`),
- list, add, enable/disable, refresh, and remove outbound agents,
- view and cancel inbound tasks.

All dashboard traffic goes through the loopback-only `/a2a/api` route on the
profile's webServer (never exposed to remote peers).

### 3. File configuration stays available (the reserve path)

Directly editing the profile's user patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`)
remains supported for values the dashboard does not edit (name/description,
baseUrl, authTokenEnv, executors, toolPrefix):

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
        ids: []                          # explicit tool ids to expose; the chat skill is built-in
        exclude: []
      executors:
        chat: session                    # or subagent (needs the subagent seam)
      subagentProvider: in-process
    client:
      toolPrefix: a2a
      agents: []                         # or list agents declaratively
```

Required host services (base-backed profiles mount them all): `webServer`
(`@deepseek-ai/dsh-host-webserver`), the storage stack
(`@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-domain`), the tools
registry (`@deepseek-ai/dsh-tools`), and an agent loop (`@deepseek-ai/dsh-agent`
+ `@deepseek-ai/dsh-agent-loop`; the subagent executor additionally needs
`@deepseek-ai/dsh-subagent`).

The task store lives in the `a2a` storage domain. The base composition routes
storage through the `json` backend; to follow the design's SQLite requirement,
route the domain and add the backend in the same patch layer:

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

Set `A2A_INBOUND_TOKEN` in the environment (never in config). Verify with
`curl http://127.0.0.1:<port>/.well-known/agent-card.json`.

### 4. File-declared outbound agents (optional; the GUI manages the same list)

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

Requires the `@deepseek-ai/dsh-tools` registry. Each enabled remote agent's
skills become tools named `a2a__<name>__<skill>` (normalized, collision-hashed);
the GUI dashboard shows connection state, the `/a2a` command lists it, and the
registry persists across restarts.

## Operations

GUI: the **A2A 连接** settings page manages the inbound toggle, outbound
agents, and task view. CLI: `/a2a` command — `status | enable | disable |
card | agents | agent add|remove|enable|disable|refresh | tasks | task get|cancel <id> | help`.

## Testing

- `tests/unit/` — protocol constants, JSON-RPC/SSE framing, card derivation,
  task store, executor resolution, the A2A server (dispatch, gate, auth,
  cancel, streaming), the outbound client (stubbed fetch) and registry.
- `tests/composition/` — boots `apply()` on a real Cordis `Context` with stub
  host services: assembly, route registration, the skill gate,
  `a2a/inbound-task` policy vetoes, and task persistence.
- A full REAL composition boot (SQLite backend + an LLM-backed agent loop
  through loader-smoke) is P1 per the design doc.

## Known limitations (documented, not roadmap)

OAuth 2.0 / per-client credentials, gRPC binding, push notifications,
`INPUT_REQUIRED` ↔ approval, passive outbound result injection, and a dashboard
UI are out of P0 scope and listed as P1 or explicitly-not-doing in
[docs/design.md](docs/design.md).