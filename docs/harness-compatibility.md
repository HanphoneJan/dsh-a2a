# Harness Compatibility

Agent2Agent (A2A) v1.0.1 dual-end plugin for DeepSeek Harness.

**English** · [中文](harness-compatibility.zh.md)

`@hanphone/dsh-a2a` is built against a sibling DeepSeek Harness checkout rather
than against published packages, so every harness release is an opportunity for
the plugin's build layout, manifest contract, or runtime API assumptions to
drift. This reference is the maintenance procedure for that drift plus the
record of what actually broke and how it was fixed. Architecture is in
[architecture.md](architecture.md).

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
pnpm typecheck   # host (tsc -b) + client (tsc -p tsconfig.client.json)
pnpm test        # vitest run — unit + composition
pnpm build       # tsc + tsdown + scripts/build-client.mjs
```

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

## Compatibility record

| dsh-a2a | Harness verified against | Changes required | Evidence |
|---|---|---|---|
| 0.3.5 | 0.2.1-alpha.2 | peer ranges widened to the 0.2 line; zod pinned to the harness's zod line; tests-scoped tsconfig for Vite 8 path resolution | `pnpm typecheck` host+client clean; `pnpm test` 110/110; full `pnpm build` produced `lib/index.js`+`lib/client.js`+`lib/types`; `dsh web` boots and serves |
| 0.3.4 | 0.1.7-rc.2 | `tsconfig.client.json` reference fix; peer ranges made truthful | typecheck host+client clean; `vitest run` 110/110; full `pnpm build` succeeded |
| 0.3.3 | 0.1.5-rc.2 | none — code and metadata already compatible | consumer `pnpm typecheck` clean |

### 0.3.5 details

Plugin source was unchanged; three metadata/build-layout fixes were needed.

1. `peerDependencies` widened to cover the `0.2` line. `@deepseek-ai/dsh-commands` and `@deepseek-ai/dsh-storage-domain` went from `">=0.1.3 <0.2"` to `">=0.1.3 <0.3"`, which covers `0.2.1-alpha.2` because prereleases participate in range matching. `@deepseek-ai/cordis` gained the `4.0.5-alpha.1` alternative and `@deepseek-ai/schemastery` the `3.18.5-alpha.1` alternative: the `0.2.1-alpha` host vendors those prereleases, which the stable `~4.0.2`/`3.*` ranges do not admit.
2. `dependencies.zod` pinned from `^4.4.3` to `~4.4.3`. The harness resolves zod `4.4.3`; a fresh install of `^4.4.3` floats to `4.6.5`, and the two zod copies make `@deepseek-ai/schemastery`'s `Config` types mutually incompatible under `exactOptionalPropertyTypes`. The pin keeps the plugin on the harness's zod line.
3. `tests/tsconfig.json` extends the build config so Vite 8's native `resolve.tsconfigPaths` applies the harness `paths` map to spec files. The build config's `include` is `src`; the composition suite imports `@deepseek-ai/cordis` as a value directly from `tests/`, so without a tests-scoped config the paths map did not reach it and resolution fell through to a `node_modules` that holds no harness packages.

Two build-environment details back these fixes. pnpm 11+ reads workspace settings from `pnpm-workspace.yaml`, not `.npmrc`, so `autoInstallPeers: false` and `verifyDepsBeforeRun: false` live there; the harness peers have no registry version inside their truthful ranges, so any dependency reify (including the pre-script check) fails and must stay disabled. `pnpm run clean` in the harness is also a prerequisite, not an optional step (see the stale-residue entry below).

### 0.3.4 details

Two metadata fixes were needed; plugin source was unchanged.

1. `tsconfig.client.json` referenced the `ui-settings` package directory. In
   0.1.7 that directory's `tsconfig.json` became a solution file (`files: []`)
   over `tsconfig.host.json` and `tsconfig.client.json`, so the reference has to
   name `../deepseek-harness/packages/client/ui-settings/tsconfig.client.json`.
   Referencing the solution directory fails with TS6306.
2. `peerDependencies` moved from `@deepseek-ai/cordis: "4.0.2"` to `"~4.0.2"`
   (the 0.1.7 host ships 4.0.4) and from `"*"` to `">=0.1.3 <0.2"` for
   `@deepseek-ai/dsh-commands` and `@deepseek-ai/dsh-storage-domain`. The
   truthful range covers every harness version this plugin has been tested
   against and satisfies the 0.1.7 preflight without an exemption.

### 0.3.3 details

Across the 0.1.3 → 0.1.5 range `vendor/cordis` (4.0.2) and
`vendor/schemastery` (3.18.2) were unchanged, and the packages this plugin
consumes only received version bumps and README rewrites. Consumer typecheck
against the harness source graph passed with zero errors, so no change shipped.

## Breakages and fixes

- **TS6306 from a solution reference.** A harness client package that exposes a
  solution `tsconfig.json` must be referenced through its `tsconfig.client.json`
  (or `tsconfig.host.json`) leaf. Symptom: `pnpm typecheck` fails on the client
  program before reading plugin source.
- **`incompatible-version` refusal after a harness minor bump.** The plugin
  declared `"*"` ranges, which `evaluatePluginCompatibility` treats as a range
  that must still satisfy the runtime; `"*"` normally satisfies, so the practical
  failure came from the exact `cordis` pin fighting the host copy and from
  ranges that did not describe tested versions. Fix by stating the tested range.
- **Empty `lib/` with a successful-looking `tsc -b`.** Stale tsbuildinfo. Clear
  `node_modules/.cache/dsh-a2a/`.
- **Client typecheck reading stale declarations.** Harness `lib/types` is
  gitignored and survives a checkout reset; rebuild the harness referenced
  packages after switching versions.
- **Stale manifest-less harness package residue breaks the host build.** After
  the checkout moved from 0.1.7 to 0.2.1-alpha.2,
  `packages/session/session-title-all-prompts-llm/` survived as `lib/` +
  `node_modules/` only; the package now lives under `packages/experimental/`.
  tsdown's host workspace globs `packages/*/*`, bundled the stale
  `lib/types/index.js`, and failed with
  `MISSING_EXPORT "registerSessionTitleLlmProvider"`. Fix: run
  `pnpm run clean` in the harness before rebuilding — it removes
  manifest-less package directories whose only entries are known residue.
- **Two zod copies after a fresh install.** `dependencies.zod: "^4.4.3"` floats
  to the newest `4.x`, while the harness stays on `4.4.3`; typecheck then
  reports `exactOptionalPropertyTypes` mismatches deep inside zod's
  `$ZodCheck`/`$ZodType` types. Pin the plugin to the harness's zod line
  (`~4.4.3`).
- **Spec imports miss the harness paths map.** Vite 8's native
  `resolve.tsconfigPaths` applies a tsconfig's `paths` only to files it
  includes. The build config includes `src`, so a spec importing
  `@deepseek-ai/cordis` directly failed to resolve; `tests/tsconfig.json`
  extends the build config and includes the specs.
- **`ERR_PNPM_NO_MATCHING_VERSION` before every script run.** pnpm reifies the
  tree before running a script and cannot resolve the harness peer ranges, whose
  registry versions sit outside them. pnpm 11+ reads `autoInstallPeers` and
  `verifyDepsBeforeRun` from `pnpm-workspace.yaml`; `.npmrc` alone is not
  enough.

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
  (`0.1.5-rc.2`, `0.1.7-rc.2`, `0.2.1-alpha.2`). The compatibility record names
  the exact version rather than a range because no final release has been tested.
- The plugin couples to harness packages by path through `../deepseek-harness`.
  A checkout at a different relative path needs the `tsconfig*.json` references
  updated.
- `0.2.1-alpha.2` is the newest tag at the time of writing (confirmed with
  `git ls-remote --tags origin`); the checkout is pinned to it plus the local
  `llm-pi-ai` `sessionHeader` patch.
