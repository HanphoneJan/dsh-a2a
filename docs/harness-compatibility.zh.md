# Harness 兼容性

Agent2Agent（A2A）v1.0.1 双端插件，用于 DeepSeek Harness。

[English](harness-compatibility.md) · **中文**

`@hanphone/dsh-a2a` 针对**兄弟目录**下的 DeepSeek Harness checkout 构建，而不是针对
已发布包构建，因此每次 harness 发版都可能让插件的构建布局、清单契约或运行时 API
假设发生漂移。本页是应对这种耦合的维护流程，以及当前的验证状态。架构说明见
[architecture.md](architecture.zh.md)。

## 何时执行本流程

- 兄弟目录 `../deepseek-harness` 切换到新 tag 或新的 `origin/master`。
- harness 以 `incompatible-version` 拒绝加载本插件。
- 发布 dsh-a2a 版本之前：必须写明它验证过的 harness 版本。

## 兼容面

| 兼容面 | 载体 | harness 变化会造成什么 |
|---|---|---|
| 依赖版本 | `package.json` 的 `peerDependencies` | 宿主携带更新的 `@deepseek-ai/cordis`/`schemastery`；DSH peer 范围不再覆盖运行时，预检拒绝加载 |
| 构建布局 | `tsconfig.json` 与 `tsconfig.client.json` 的 `references` | 被引用的 harness 包发生拆分、改名或不再是 composite 项目；`tsc -b` 在任何源码被读取前就失败 |
| 挂载与清单契约 | `cordis.patch.yml`、`dsh.bundle.patch`、`dsh.client.inject`、`scripts/build-client.mjs` | `- insert:` 补丁格式、客户端注入列表或 `window.__ModuleLoader__.load({ id, factory })` 浏览器契约变化 |
| 运行时 API | `ctx.a2a`、`ctx.slots.inject('settings.section', …)`、存储 `KvTable`、commands、preset/skill/subagent 数据 | 被消费的服务签名或数据结构发生移动 |

这四个兼容面按“检查成本”排序：依赖版本与构建布局会尽早、显式地报错；运行时 API
由消费方 typecheck 与测试覆盖。

## 流程

### 1. 确定 harness 版本

harness 没有 changelog；版本号在根 `package.json` 的 `version`，发布 tag 形如
`dsh-v<semver>`。

```sh
cd ../deepseek-harness
grep -m1 '"version"' package.json
git status -sb && git log --oneline -3
git fetch origin --tags --prune
git ls-remote --tags origin | grep -v '\^{}' | awk -F/ '{print $NF}' | sort -V | tail -10
```

`git ls-remote` 反映上游实时状态，与本地 fetch 过什么无关；只看本地 tag 列表可能落后
好几个版本线。

### 2. 刷新插件消费的 harness 构建产物

harness 的 `lib/` 产物被 gitignore，切换版本后依然存在，因此陈旧的产物面会让插件
其实是在对上一个版本做 typecheck。切换版本还可能留下没有 manifest 的包目录，而宿主
workspace 的 glob 仍会匹配并尝试打包它。

```sh
pnpm install --frozen-lockfile
pnpm run clean            # 清掉陈旧构建产物与无 manifest 的包残留
pnpm run build            # 或对被引用的包做定向 tsc -b
```

### 3. 对比各兼容面

```sh
cd ../deepseek-harness
git diff <from> <to> -- vendor/cordis vendor/schemastery | head -40
git diff <from> <to> -- packages/client/ui-settings packages/storage packages/interaction | head -40
git diff <from> <to> -- tsconfig.base.json tsconfig.base.client.json tsconfig.client.json tsconfig.host.json
```

### 4. 针对新 checkout 验证

```sh
cd ../dsh-a2a
pnpm typecheck   # host + client + 镜像检查（tsconfig.types.json）
pnpm test        # vitest run — unit + composition + 真实持久化
pnpm build       # tsc + tsdown + scripts/build-client.mjs
pnpm test:e2e    # 对已构建产物的双实例 A2A hermetic 冒烟
```

只跑 `pnpm test` 不足以作为兼容性变更的证据：它跑在 stub 宿主服务上，看不见持久化
codec 或 manifest/mount 漂移。能看见的是镜像检查与 e2e 冒烟；见
[testing.zh.md](testing.zh.md)。

如果删掉 `lib/` 后的干净重建“看起来成功但什么都没产出”，那是 TypeScript 构建缓存还在
作祟：先清 `node_modules/.cache/dsh-a2a/`。`tsc -b` 会信任陈旧的 tsbuildinfo，随后
tsdown 找不到入口。

### 5. 只在代码已兼容时改元数据

优先用元数据修复（工程引用路径、peer 范围、版本号），而不是改源码。若确实要改源码，
必须在同一改动里新增或调整行为测试。

### 6. 核对 DSH peer 预检

DSH 0.1.7 起，在导入插件前会用运行时版本校验插件的 `@deepseek-ai/dsh` 与
`@deepseek-ai/dsh-*` peer。预发布版本参与范围匹配，`workspace:^`/`~`/`*` 指当前运行时
版本。拒绝时带 `incompatible-version` 错误码并列出未满足的范围；插件管理器会在 pnpm
运行之前就拒绝 registry 安装。

本插件最关键的细节：**该预检忽略 `@deepseek-ai/cordis` 与
`@deepseek-ai/schemastery`**，只有 `@deepseek-ai/dsh-commands` 和
`@deepseek-ai/dsh-storage-domain` 参与。这两个范围要对每个已测 harness 版本保持真实。
`cordis` 与 `schemastery` 不参与预检，但声明区间仍要能容纳宿主内置的版本——宿主线内置
预发布（如 `4.0.5-alpha.1`）时，要把该精确预发布写进备选（例如
`~4.0.2 || 4.0.5-alpha.1`）。

确需绕过真实不匹配时，用精确豁免，而不是不诚实地放宽范围：

```sh
dsh plugin allow-version <pkg@version> --dsh-version <runtime> --accept-risk
dsh plugin version-exemptions
dsh plugin revoke-version <pkg@version> --dsh-version <runtime>
```

### 7. 记录、提交、打包、发布

提升 `package.json` 的 `version`，在提交信息里写明所验证的 harness 版本，并产出 tarball：

```sh
pnpm pack --pack-destination <dir>
```

## 当前状态

`0.5.0` 已对 harness `0.2.1-rc.2` 验证：`pnpm typecheck`（host + client + 镜像检查）
零错误，`pnpm test` 178/178，`pnpm build` 产出 `lib/index.js` + `lib/client.js`，
`pnpm test:e2e` 对两个真实实例跑通入站与出站往返。CI 矩阵还覆盖 `0.2.1-alpha.2` 与
`0.1.7-rc.2`。

## 常见坑

- **`lib/` 为空却“看起来构建成功”。** 陈旧 tsbuildinfo；清
  `node_modules/.cache/dsh-a2a/`。
- **客户端 typecheck 读到陈旧声明。** harness 的 `lib/types` 被 gitignore、会在
  checkout 重置后存活；切换版本后要重建被引用的 harness 包。
- **harness 中无 manifest 的陈旧包残留。** 重建前先在 harness 跑 `pnpm run clean`；
  否则 tsdown 的 `packages/*/*` glob 会打包残留的 `lib/types` 产物并报 `MISSING_EXPORT`。
- **两份 zod。** 把 `dependencies.zod` 收紧到 harness 所在线（`~4.4.3`）；
  浮动的 `^4.4.3` 会让 `Config` 类型在 `exactOptionalPropertyTypes` 下互不兼容。
- **每次跑脚本前 `ERR_PNPM_NO_MATCHING_VERSION`。** harness peer 的真实区间在 registry
  内没有对应版本。pnpm 11+ 从 `pnpm-workspace.yaml` 读取 `autoInstallPeers: false` 与
  `verifyDepsBeforeRun: false`；仅设 `.npmrc` 不够。
- **solution 引用导致的 TS6306。** 暴露 solution `tsconfig.json` 的 harness 包必须通过
  其 `tsconfig.client.json`（或 `tsconfig.host.json`）叶子文件引用。
- **测试里 import harness 源码触发 Vite `SyntaxError`。** harness 源码使用标准
  TypeScript 装饰器；`vitest.config.ts` 装上 harness 的 `standardDecoratorPlugin`。
- **spec 导入取不到 harness 路径映射。** Vite 8 原生的 `resolve.tsconfigPaths` 只对
  tsconfig `include` 命中的文件应用 `paths`；`tests/tsconfig.json` 继承构建配置并纳入
  spec。

## 发布

两个 registry，规则不同：

- **npmjs** — `@hanphone/dsh-a2a`，`publishConfig.access: public`。对过期或已撤销 token
  返回的 `403` 是 npm 凭据问题，不是包的问题。
- **GitHub Packages**（`npm.pkg.github.com`）——要求 npm scope 等于拥有该包的 GitHub
  账号或组织。属于 `HanphoneJan` 的 token 无法创建 `@hanphone/dsh-a2a`，registry 会回
  `403 permission_denied: create_package`。要在那里发布，要么拿到 `hanphone` 账号的
  token，要么把包改名为 `@hanphonejan/dsh-a2a`；改名是破坏性变更：包名被
  `scripts/build-client.mjs` 读取用于 module-loader id，也被 `cordis.patch.yml` 引用。
  因此发布到 GitHub Packages 是可选项，不属于常规发布流程。

## 已知限制

- 本插件验证过的 harness 版本全是预发布版（`0.1.5-rc.2`、`0.1.7-rc.2`、
  `0.2.1-alpha.2`、`0.2.1-rc.2`）；尚无正式版被测过。
- 插件通过 `../deepseek-harness` 路径与 harness 包耦合。若 checkout 位于其它相对路径，
  需要同步修改 `tsconfig*.json` 的引用。
- checkout 固定在 `0.2.1-rc.2`，并叠加本地 `llm-pi-ai` `sessionHeader` 补丁。
