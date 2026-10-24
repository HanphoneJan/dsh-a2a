# Harness Compatibility

Agent2Agent (A2A) v1.0.1 dual-end plugin for DeepSeek Harness.

**English** · [中文](harness-compatibility.zh.md)

`@hanphone/dsh-a2a` is built against a sibling DeepSeek Harness checkout rather
than against published packages, so every harness release can move the plugin's
build layout, manifest contract, or runtime API assumptions. This page is the
maintenance procedure for that coupling and the current verification status.
Architecture is in [architecture.md](architecture.md).

## When to run this procedure

- The sibling `../deepseek-harness` checkout moves to a new tag or to
  `origin/master`.
- The harness refuses to load the plugin with `incompatible-version`.
- Before publishing a dsh-a2a release: state which harness version it was
  verified against.

## Compatibility surfaces

| Surface | Where it lives | What a harness change can do |
|---|---|---|
| Dependency versions | `peerDependencies` in `package.json` | Host ships a newer `@deepseek-ai/cordis`/`schemastery`; a DSH peer range stops covering the runtime and the preflight refuses the plugin |
| Build layout | `references` in `tsconfig.json` and `tsconfig.client.json` | A referenced harness package splits, renames, or stops being a composite project; `tsc -b` fails before any source is read |
| Mount and manifest contract | `cordis.patch.yml`, `dsh.bundle.patch`, `dsh.client.inject`, `scripts/build-client.mjs` | The `- insert:` patch form, client injection list, or `window.__ModuleLoader__.load({ id, factory })` browser contract changes |
| Runtime APIs | `ctx.a2a`, `ctx.slots.inject('settings.section', …)`, storage `KvTable`, commands, preset/skill/subagent data | A consumed service signature or data structure moves |

The four surfaces are ordered by how cheaply they can be checked: dependency
versions and build layout fail loudly and early; runtime APIs are covered by the
consumer typecheck and tests.

## Procedure

### 1. Identify the harness version

The harness has no changelog; the version is the root `package.json` `version`
and the release tags are `dsh-v<semver>`.

```sh
cd ../deepseek-harness
grep -m1 '"version"' package.json
git status -sb && git log --oneline -3
git fetch origin --tags --prune
git ls-remote --tags origin | grep -v '\^{}' | awk -F/ '{print $NF}' | sort -V | tail -10
```

`git ls-remote` reports the upstream state regardless of what this checkout has
fetched; a local tag list alone can be several release lines behind.

### 2. Refresh the harness build the plugin consumes

Harness `lib/` output is gitignored and survives a version switch, so a stale
artifact plane can make the plugin typecheck against the previous version. A
version switch can also leave manifest-less package directories behind, which
the host workspace glob still picks up and tries to bundle.

```sh
pnpm install --frozen-lockfile
pnpm run clean            # drop stale build output and manifest-less package residue
pnpm run build            # or a targeted tsc -b for the referenced packages
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
pnpm typecheck   # host + client + mirror check (tsconfig.types.json)
pnpm test        # vitest run — unit + composition + real persistence
pnpm build       # tsc + tsdown + scripts/build-client.mjs
pnpm test:e2e    # hermetic two-instance A2A smoke against the built artifact
```

`pnpm test` alone is not enough evidence for a compatibility change: it runs
stub host services and cannot see durable-codec or manifest/mount drift. The
mirror check and the e2e smoke are the layers that can; see
[testing.md](testing.md).

If the clean rebuild no-ops because `lib/` was deleted while the TypeScript
build cache survived, clear `node_modules/.cache/dsh-a2a/` first: `tsc -b`
trusts a stale tsbuildinfo and tsdown then cannot find its entry points.

### 5. Adapt metadata only when the code is already compatible

Prefer metadata fixes (project reference paths, peer ranges, version bump) over
source changes. If source must change, add or adjust a behavior test in the same
change.

### 6. Verify the DSH peer preflight

DSH 0.1.7 and later evaluate a plugin's `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peers against the running version before importing it.
Prereleases participate in range matching, and `workspace:^`/`~`/`*` refer to
the running version. A refusal carries the `incompatible-version` code with the
unsatisfied ranges; the plugin manager rejects registry installs before pnpm
runs.

The important detail for this plugin: **the preflight ignores
`@deepseek-ai/cordis` and `@deepseek-ai/schemastery`.** Only
`@deepseek-ai/dsh-commands` and `@deepseek-ai/dsh-storage-domain` participate.
Keep those two ranges truthful for every tested harness version. The other two
are not evaluated, but their declared ranges must still admit the host's
vendored copy — including an exact prerelease when the host line vendors one
(for example `~4.0.2 || 4.0.5-alpha.1`).

To bypass a genuine mismatch, grant an exact exemption rather than widening the
range dishonestly:

```sh
dsh plugin allow-version <pkg@version> --dsh-version <runtime> --accept-risk
dsh plugin version-exemptions
dsh plugin revoke-version <pkg@version> --dsh-version <runtime>
```

### 7. Record, commit, pack, publish

Bump `package.json` `version`, commit the adaptation with the harness version in
the message, and produce the tarball:

```sh
pnpm pack --pack-destination <dir>
```

## Current status

`0.5.0` is verified against harness `0.2.1-rc.2`: `pnpm typecheck` (host + client
+ mirror check) clean, `pnpm test` 178/178, `pnpm build` produced
`lib/index.js` + `lib/client.js`, and `pnpm test:e2e` passed an inbound and
outbound round trip against two real instances. The CI matrix also exercises
`0.2.1-alpha.2` and `0.1.7-rc.2`.

## Known pitfalls

- **Empty `lib/` after a successful-looking `tsc -b`.** Stale tsbuildinfo; clear
  `node_modules/.cache/dsh-a2a/`.
- **Client typecheck reading stale declarations.** Harness `lib/types` is
  gitignored and survives a checkout reset; rebuild the referenced harness
  packages after switching versions.
- **Stale manifest-less harness package residue.** `pnpm run clean` in the
  harness before rebuilding; tsdown's `packages/*/*` glob otherwise bundles
  leftover `lib/types` output and fails with `MISSING_EXPORT`.
- **Two zod copies.** Pin `dependencies.zod` to the harness's line (`~4.4.3`);
  a floating `^4.4.3` gives mutually incompatible `Config` types under
  `exactOptionalPropertyTypes`.
- **`ERR_PNPM_NO_MATCHING_VERSION` before every script run.** The harness peers
  have no registry version inside their truthful ranges. pnpm 11+ reads
  `autoInstallPeers: false` and `verifyDepsBeforeRun: false` from
  `pnpm-workspace.yaml`; `.npmrc` alone is not enough.
- **TS6306 from a solution reference.** A harness package that exposes a
  solution `tsconfig.json` must be referenced through its `tsconfig.client.json`
  (or `tsconfig.host.json`) leaf.
- **Vite `SyntaxError` importing harness source in tests.** Harness source uses
  standard TypeScript decorators; `vitest.config.ts` installs the harness's
  `standardDecoratorPlugin`.
- **Spec imports miss the harness paths map.** Vite 8's native
  `resolve.tsconfigPaths` only applies `paths` to files a tsconfig includes.
  `tests/tsconfig.json` extends the build config and includes the specs.

## Publishing

Two registries with different rules:

- **npmjs** — `@hanphone/dsh-a2a`, `publishConfig.access: public`. A `403`
  against an expired or revoked token is an npm credential problem, not a
  package problem.
- **GitHub Packages** (`npm.pkg.github.com`) — requires the npm scope to equal
  the GitHub account or organization that owns the package. A token belonging to
  `HanphoneJan` cannot create `@hanphone/dsh-a2a`; the registry answers
  `403 permission_denied: create_package`. Publishing there would require either
  a token for the `hanphone` account or renaming the package to
  `@hanphonejan/dsh-a2a`, which is a breaking change: the name is read by
  `scripts/build-client.mjs` for the module-loader id and is referenced by
  `cordis.patch.yml`. Publishing to GitHub Packages is therefore opt-in, not
  part of the routine release.

## Known limitations

- Every harness version this plugin has been verified against is a prerelease
  (`0.1.5-rc.2`, `0.1.7-rc.2`, `0.2.1-alpha.2`, `0.2.1-rc.2`); no final release
  has been tested.
- The plugin couples to harness packages by path through `../deepseek-harness`.
  A checkout at a different relative path needs the `tsconfig*.json` references
  updated.
- The checkout is pinned to `0.2.1-rc.2` plus the local `llm-pi-ai`
  `sessionHeader` patch.
