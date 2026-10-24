---
name: Harness 兼容性
description: 耦合面、迁移到另一个 DeepSeek Harness 版本的流程、当前状态与已知陷阱
update-time: 2026-10-25
---

# Harness 兼容性

[English](harness-compatibility.md) · **中文**

插件针对同级的 DeepSeek Harness checkout 构建，而不是针对已发布包。harness 的某个
版本可能改变构建布局、manifest 契约或运行时 API 假设，所以本页是这套耦合的维护流程。
组件设计见[架构](architecture.zh.md)。

## 什么时候跑这个流程

- 同级 `../deepseek-harness` checkout 换到新 tag 或 `origin/master`。
- harness 以 `incompatible-version` 拒绝加载插件。
- 发布 dsh-a2a 之前：说明它对哪个 harness 版本做过验证。

## 耦合面

| 面 | 位置 | harness 改动会造成什么 |
|---|---|---|
| 依赖版本 | `package.json` 的 `peerDependencies` | DSH peer 范围不再覆盖运行时，预检拒绝插件 |
| 构建布局 | `tsconfig.json`、`tsconfig.client.json`、`tsconfig.types.json` 的 `references` | 被引用的包拆分、改名或不再是 composite；`tsc -b` 在读源码前就失败 |
| 挂载与 manifest 契约 | `cordis.patch.yml`、`dsh.bundle.patch`、`dsh.client.inject`、`scripts/build-client.mjs` | `- insert:` patch 形式、客户端注入列表或 `window.__ModuleLoader__.load({ id, factory })` 契约变化 |
| 运行时 API | `ctx.a2a`、`ctx.slots.inject('settings.section', …)`、存储 `KvTable`、commands、preset/skill/subagent 数据 | 被消费的服务签名或数据结构移动 |

四者按检查成本排序：版本与构建布局失败得早且响；运行时 API 由消费方类型检查、真实
持久化套件与 e2e 冒烟覆盖。

## 流程

### 1. 确认 harness 版本

harness 没有 changelog；版本就是根 `package.json` 的 `version`，发布 tag 是
`dsh-v<semver>`。

```sh
cd ../deepseek-harness
grep -m1 '"version"' package.json
git status -sb && git log --oneline -3
git fetch origin --tags --prune
git ls-remote --tags origin | grep -v '\^{}' | awk -F/ '{print $NF}' | sort -V | tail -10
```

`git ls-remote` 反映上游状态，与本地已 fetch 的内容无关；只看本地 tag 列表可能落后
好几个发布线。

### 2. 刷新 harness 构建产物

harness 的 `lib/` 输出被 gitignore，且会跨版本切换保留，所以陈旧的产物 plane 会让
插件对上一个版本做类型检查。切换版本还可能留下没有 manifest 的包目录，被宿主
workspace glob 扫到。

```sh
pnpm install --frozen-lockfile
pnpm run clean
pnpm run build
```

### 3. Diff 耦合面

```sh
cd ../deepseek-harness
git diff <from> <to> -- vendor/cordis vendor/schemastery | head -40
git diff <from> <to> -- packages/client/ui-settings packages/storage packages/interaction | head -40
git diff <from> <to> -- tsconfig.base.json tsconfig.base.client.json tsconfig.client.json tsconfig.host.json
```

### 4. 对新 checkout 验证

```sh
cd ../dsh-a2a
pnpm typecheck   # 宿主 + 客户端 + 镜像检查
pnpm test        # 单元 + 组合 + 真实持久化
pnpm build       # tsc + tsdown + scripts/build-client.mjs
pnpm test:e2e    # 对已构建产物跑双实例 A2A hermetic 冒烟
```

兼容性变更不能只拿 `pnpm test` 当证据：它跑的是 stub 宿主服务，看不见持久化编解码
或 manifest/挂载漂移。镜像检查与 e2e 冒烟才能；见[测试](testing.zh.md)。

如果删掉 `lib/` 后干净重建却 no-op，是因为 TypeScript 构建缓存还在：先清
`node_modules/.cache/dsh-a2a/`，否则 `tsc -b` 信任陈旧 tsbuildinfo，tsdown 随后
找不到入口。

### 5. 优先改元数据

先修项目引用、peer 范围或版本号。必须改源码时，同一次改动里加或调整行为测试。

### 6. 验证 peer 预检

DSH 0.1.7 起会在导入前按运行版本评估插件的 `@deepseek-ai/dsh` 与
`@deepseek-ai/dsh-*` peer。预发布版本参与范围匹配，`workspace:^`/`~`/`*` 指向
运行版本。拒绝时携带 `incompatible-version` 码与不满足的范围；插件管理器会在 pnpm
执行前拒绝 registry 安装。

预检忽略 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`。只有
`@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-storage-domain` 参与。保持这两个
范围对每个测试过的 harness 版本都真实。另外两个不被评估，但声明的范围仍必须接纳宿主
vendored 的副本，包括宿主线 vendored 的精确预发布版本。

要绕过真实不匹配，给精确豁免，而不是不诚实地放宽范围：

```sh
dsh plugin allow-version <pkg@version> --dsh-version <runtime> --accept-risk
dsh plugin version-exemptions
dsh plugin revoke-version <pkg@version> --dsh-version <runtime>
```

### 7. 记录、提交、打包、发布

在同一次提交里 bump `package.json` 的 `version`，在提交消息里写明验证过的 harness
版本，并打出 tarball：

```sh
pnpm pack --pack-destination <dir>
```

发布目标是 npmjs 的 `@hanphone/dsh-a2a`（`publishConfig.access: public`）。那里的
`403` 是 npm 凭据问题，不是包问题。没有明确要求不发布。

## 当前状态

`0.5.0` 已对 harness `0.2.1-rc.2` 验证：`pnpm typecheck`（宿主 + 客户端 + 镜像
检查）、`pnpm test`（178/178）、`pnpm build` 产出 `lib/index.js` 与
`lib/client.js`、`pnpm test:e2e` 在两个真实实例间跑通入站与出站往返。CI 的 e2e
矩阵还覆盖 `0.2.1-alpha.2` 与 `0.1.7-rc.2`。

## 已知陷阱

- **`tsc -b` 看起来成功但 `lib/` 是空的。** 陈旧的 tsbuildinfo；清
  `node_modules/.cache/dsh-a2a/`。
- **客户端类型检查读到旧声明。** harness 的 `lib/types` 被 gitignore，且会跨
  checkout reset 保留；切换版本后重建被引用的包。
- **没有 manifest 的 harness 包残留。** 重建前在 harness 跑 `pnpm run clean`；
  否则 tsdown 的 `packages/*/*` glob 会打包遗留的 `lib/types` 输出，以
  `MISSING_EXPORT` 失败。
- **两份 zod。** 把 `dependencies.zod` 钉在 harness 的线上（`~4.4.3`）；浮动的
  `^4.4.3` 在 `exactOptionalPropertyTypes` 下给出互不兼容的 `Config` 类型。
- **每次跑脚本前 `ERR_PNPM_NO_MATCHING_VERSION`。** harness peer 在其真实范围内没有
  registry 版本。pnpm 11+ 从 `pnpm-workspace.yaml` 读 `autoInstallPeers: false` 与
  `verifyDepsBeforeRun: false`；只写 `.npmrc` 不够。
- **solution 引用导致 TS6306。** 暴露 solution `tsconfig.json` 的 harness 包必须
  经它的 `tsconfig.client.json`（或 `tsconfig.host.json`）叶子引用。
- **测试里导入 harness 源码报 Vite `SyntaxError`。** harness 源码使用标准 TypeScript
  装饰器；`vitest.config.ts` 安装了 harness 的 `standardDecoratorPlugin`。
- **spec 导入没有命中 harness 的 paths 映射。** Vite 8 原生
  `resolve.tsconfigPaths` 只对 tsconfig include 的文件应用 `paths`。
  `tests/tsconfig.json` 继承构建配置并 include 了 specs。

## 已知限制

- 没有测过正式版；已验证过的 harness 版本全是预发布。
- 插件通过 `../deepseek-harness` 按路径耦合 harness 包。换到别的相对路径需要更新
  `tsconfig*.json` 的引用。
