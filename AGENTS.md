# AGENTS.md — dsh-a2a

Standing orders for agents working in this repository. Read
[docs/architecture.md](docs/architecture.md) before changing `src/`. The harness
version-compatibility procedure lives in
[docs/harness-compatibility.md](docs/harness-compatibility.md); follow it whenever
the DeepSeek Harness checkout this plugin builds against changes version.

## What this repository is

`@hanphone/dsh-a2a` is an independent, open-source Agent2Agent (A2A) v1.0.1
dual-end plugin for DeepSeek Harness. It mounts as one Cordis row (`a2a`) and
turns a DSH profile into a multi-instance A2A citizen: multiple inbound servers
(each with its own endpoint, AgentCard, preset, derived skills and auth) and
multiple outbound connections (remote skills exposed as model tools). Server
instances are created and managed from the GUI, not from `cordis.patch.yml`.

The plugin is developed against a **sibling harness checkout** at
`../deepseek-harness`. It resolves `@deepseek-ai/*` imports through project
references into that checkout's TypeScript source graph, not from
`node_modules`. A missing or stale sibling checkout is the most common cause of
a confusing typecheck failure.

## Layout

```
src/                 host half
  servers/           inbound/outbound multi-instance managers
  server/            single-instance internals (store, card, A2A server, routes,
                     executors, registries)
  outbound/          outbound internals (A2AClient, registry, tools)
  client/            browser half (React settings dashboard)
  service.ts         ctx.a2a facade
  commands.ts        /a2a chat command
tests/
  unit/              protocol, framing, card, store, registry, server, client, api
  composition/       apply() on a real Cordis Context with stub host services
cordis.patch.yml     bundle patch (mounts the plugin core only)
scripts/build-client.mjs  wraps the browser bundle for window.__ModuleLoader__
docs/                architecture (EN/ZH) and harness compatibility (EN/ZH)
```

## Commands

```sh
pnpm typecheck   # host (tsc -b) + client (tsc -p tsconfig.client.json)
pnpm test        # vitest run (unit + composition)
pnpm build       # tsc + tsdown → lib/index.js (host) + lib/client.js (browser)
pnpm pack --pack-destination <dir>   # publishable tarball
```

A clean rebuild after deleting `lib/` can no-op if the TypeScript build cache
survives: `tsc -b` trusts a stale tsbuildinfo, then tsdown cannot find its entry
points. Clear `node_modules/.cache/dsh-a2a/` before rebuilding in that case.

## Harness coupling

Four surfaces couple this plugin to a harness version. When the harness changes,
check them in this order — the procedure and its evidence requirements are in
[docs/harness-compatibility.md](docs/harness-compatibility.md):

1. `peerDependencies` (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`,
   `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-storage-domain`).
2. TypeScript project references in `tsconfig.json` and `tsconfig.client.json`.
3. Manifest and mount contracts: `cordis.patch.yml`'s `- insert:` form,
   `dsh.bundle.patch`, `dsh.client.inject`, and the browser contract
   `window.__ModuleLoader__.load({ id, factory })` consumed by
   `scripts/build-client.mjs`.
4. Runtime APIs: `ctx.a2a`, `ctx.slots.inject('settings.section', …)`,
   storage `KvTable`, commands, and preset/skill/subagent data.

DSH 0.1.7+ runs a plugin peer preflight over `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peers and rejects a plugin whose ranges do not cover the
running version. Keep those ranges truthful for every tested harness version
instead of `*`. The preflight ignores `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery`, but never pin either to an exact version: an exact
pin still fights the host's copy at install time.

## Rules

- **Evidence before claims.** A compatibility change ships with
  `pnpm typecheck`, `pnpm test`, and `pnpm build` results against the named
  harness version. Report the commands actually run; do not restate an earlier
  green run as current.
- **Never change `src/` without a passing typecheck and the test suite.**
  Behavior changes also need a test that fails without them.
- **Keep the plugin additive.** Prefer new opt-in config over changed defaults;
  the plugin runs inside someone else's profile composition.
- **Editorial language of the codebase is English.** Public docs are an
  EN/ZH pair (`README.md`/`README.zh.md`, `docs/architecture.md`/
  `docs/architecture.zh.md`, `docs/harness-compatibility.md`/`.zh.md`); update
  both sides together and use the `**English** · [中文](…)` switcher line.
- **`@hanphone/dsh-a2a` is the published identity.** The package name is read by
  `scripts/build-client.mjs` to label the module-loader registration and is
  referenced by `cordis.patch.yml`; renaming the package is a breaking release,
  not a metadata edit.
- **Version bumps are deliberate.** Bump `package.json` `version` in the same
  commit as the compatibility adaptation, and state the harness version the
  release was verified against in the commit message.
- **Secrets stay out of the tree.** `.npmrc` and `~/.git-credentials` hold
  registry tokens; never print, copy into source, or commit them. Mask tokens in
  command output.
- **Do not push or publish without an explicit request.** Publishing targets
  npmjs (`@hanphone/dsh-a2a`) and GitHub Packages have different scope rules; see
  [docs/harness-compatibility.md](docs/harness-compatibility.md#publishing).

## Editing these instructions

Keep each rule self-contained and link the owning document instead of repeating
it. Add a rule only after it has bitten twice; prefer updating
`docs/harness-compatibility.md` for procedure detail.
