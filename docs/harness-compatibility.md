---
name: Harness compatibility
description: Coupling surfaces, the procedure for moving to another DeepSeek Harness release, current status and known traps
update-time: 2026-10-25
---

# Harness compatibility

**English** · [中文](harness-compatibility.zh.md)

The plugin is built against a sibling DeepSeek Harness checkout, not against
published packages. A harness release can move the build layout, manifest
contract or runtime API assumptions, so this page is the maintenance procedure
for that coupling. Component design is in [Architecture](architecture.md).

## When to run this

- The sibling `../deepseek-harness` checkout moves to a new tag or to
  `origin/master`.
- The harness refuses to load the plugin with `incompatible-version`.
- Before publishing a dsh-a2a release: state which harness version it was
  verified against.

## Coupling surfaces

| Surface | Where it lives | What a harness change can do |
|---|---|---|
| Dependency versions | `peerDependencies` in `package.json` | A DSH peer range stops covering the runtime and the preflight refuses the plugin |
| Build layout | `references` in `tsconfig.json`, `tsconfig.client.json`, `tsconfig.types.json` | A referenced package splits, renames or stops being composite; `tsc -b` fails before source is read |
| Mount and manifest contract | `cordis.patch.yml`, `dsh.bundle.patch`, `dsh.client.inject`, `scripts/build-client.mjs` | The `- insert:` patch form, client injection list or `window.__ModuleLoader__.load({ id, factory })` contract changes |
| Runtime APIs | `ctx.a2a`, `ctx.slots.inject('settings.section', …)`, storage `KvTable`, commands, preset/skill/subagent data | A consumed service signature or data structure moves |
| Session event feed | `session/event` listeners for `tool/call` / `tool/result` in `src/server/exec/agent-runtime.ts` | Trace observation loses call ids, error flags or event timing; only real harness evidence catches it |

The surfaces are ordered by how cheaply they can be checked: versions and build
layout fail loudly and early; runtime APIs are covered by the consumer
typecheck, the real-persistence suite and the e2e smoke.

## Procedure

### 1. Identify the harness version

The harness has no changelog; the version is the root `package.json` `version`
and release tags are `dsh-v<semver>`.

```sh
cd ../deepseek-harness
grep -m1 '"version"' package.json
git status -sb && git log --oneline -3
git fetch origin --tags --prune
git ls-remote --tags origin | grep -v '\^{}' | awk -F/ '{print $NF}' | sort -V | tail -10
```

`git ls-remote` reports upstream regardless of what the local checkout has
fetched; a local tag list alone can be several release lines behind.

### 2. Refresh the harness build

Harness `lib/` output is gitignored and survives a version switch, so a stale
artifact plane can make the plugin typecheck against the previous version. A
switch can also leave manifest-less package directories behind, which the host
workspace glob still picks up.

```sh
pnpm install --frozen-lockfile
pnpm run clean
pnpm run build
```

### 3. Diff the coupling surfaces

```sh
cd ../deepseek-harness
git diff <from> <to> -- vendor/cordis vendor/schemastery | head -40
git diff <from> <to> -- packages/client/ui-settings packages/storage packages/interaction | head -40
git diff <from> <to> -- tsconfig.base.json tsconfig.base.client.json tsconfig.client.json tsconfig.host.json
```

### 4. Verify against the new checkout

```sh
cd ../dsh-a2a
pnpm typecheck   # host + client + mirror check
pnpm test        # unit + composition + real persistence
pnpm build       # tsc + tsdown + scripts/build-client.mjs
pnpm test:e2e    # hermetic two-instance A2A smoke against the built artifact
```

`pnpm test` alone is not evidence for a compatibility change: it runs stub host
services and cannot see durable-codec or manifest/mount drift. The mirror check
and the e2e smoke are the layers that can; see [Testing](testing.md).

If a clean rebuild no-ops because `lib/` was deleted while the TypeScript build
cache survived, clear `node_modules/.cache/dsh-a2a/` first: `tsc -b` trusts a
stale tsbuildinfo and tsdown then cannot find its entry points.

### 5. Prefer metadata over source changes

Fix project references, peer ranges or the version first. If source must change,
add or adjust a behavior test in the same change.

### 6. Verify the peer preflight

DSH 0.1.7 and later evaluate a plugin's `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peers against the running version before importing it.
Prereleases participate in range matching, and `workspace:^`/`~`/`*` refer to
the running version. A refusal carries the `incompatible-version` code with the
unsatisfied ranges; the plugin manager rejects registry installs before pnpm
runs.

The preflight ignores `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`. Only
`@deepseek-ai/dsh-commands` and `@deepseek-ai/dsh-storage-domain` participate.
Keep those two ranges truthful for every tested harness version. The other two
are not evaluated, but their declared ranges must still admit the host's
vendored copy, including an exact prerelease when the host line vendors one.

To bypass a genuine mismatch, grant an exact exemption rather than widening the
range dishonestly:

```sh
dsh plugin allow-version <pkg@version> --dsh-version <runtime> --accept-risk
dsh plugin version-exemptions
dsh plugin revoke-version <pkg@version> --dsh-version <runtime>
```

### 7. Record, commit, pack, publish

Bump `package.json` `version` in the same commit, state the verified harness
version in the message, and produce the tarball:

```sh
pnpm pack --pack-destination <dir>
```

Publishing goes to npmjs as `@hanphone/dsh-a2a` (`publishConfig.access: public`).
A `403` there is an npm credential problem, not a package problem. A release is
not published without an explicit request.

## Current status

`0.5.1` is verified against harness `0.2.1-rc.3`: `pnpm typecheck` (host +
client + mirror check), `pnpm test` (196/196), `pnpm test:integration` (6/6),
`pnpm build` producing `lib/index.js` and `lib/client.js`, and `pnpm test:e2e`
passing an inbound and outbound round trip against two real instances, including
the optional trace extension's card declaration and header acknowledgement.
`0.2.1-rc.2` remains in the matrix; `0.2.1-alpha.2` and `0.1.7-rc.2` are also
covered by the scheduled matrix.

## Known traps

- **Empty `lib/` after a successful-looking `tsc -b`.** Stale tsbuildinfo; clear
  `node_modules/.cache/dsh-a2a/`.
- **Client typecheck reading stale declarations.** Harness `lib/types` is
  gitignored and survives a checkout reset; rebuild the referenced packages
  after switching versions.
- **Stale manifest-less harness package residue.** Run `pnpm run clean` in the
  harness before rebuilding; tsdown's `packages/*/*` glob otherwise bundles
  leftover `lib/types` output and fails with `MISSING_EXPORT`.
- **Two zod copies.** Pin `dependencies.zod` to the harness's line (`~4.4.3`);
  a floating `^4.4.3` gives mutually incompatible `Config` types under
  `exactOptionalPropertyTypes`.
- **`ERR_PNPM_NO_MATCHING_VERSION` before every script.** The harness peers have
  no registry version inside their truthful ranges. pnpm 11+ reads
  `autoInstallPeers: false` and `verifyDepsBeforeRun: false` from
  `pnpm-workspace.yaml`; `.npmrc` alone is not enough.
- **TS6306 from a solution reference.** A harness package that exposes a
  solution `tsconfig.json` must be referenced through its
  `tsconfig.client.json` (or `tsconfig.host.json`) leaf.
- **Vite `SyntaxError` importing harness source in tests.** Harness source uses
  standard TypeScript decorators; `vitest.config.ts` installs the harness's
  `standardDecoratorPlugin`.
- **Spec imports miss the harness paths map.** Vite 8's native
  `resolve.tsconfigPaths` only applies `paths` to files a tsconfig includes.
  `tests/tsconfig.json` extends the build config and includes the specs.

## Known limitations

- No final harness release has been tested; every verified version so far is a
  prerelease.
- The plugin couples to harness packages by path through `../deepseek-harness`.
  A checkout at a different relative path needs the `tsconfig*.json` references
  updated.
