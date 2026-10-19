# Harness 兼容性

Agent2Agent（A2A）v1.0.1 双端插件，用于 DeepSeek Harness。

[English](harness-compatibility.md) · **中文**

`@hanphone/dsh-a2a` 是针对一份**兄弟目录**下的 DeepSeek Harness checkout 构建的，而不是针对已发布包构建，因此每次 harness 发版都可能让插件的构建布局、清单契约或运行时 API 假设发生漂移。本参考既是对这种漂移的维护流程，也是“实际断在哪里、怎么修”的记录。架构说明见 [architecture.md](architecture.md)。

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

这四个兼容面按“检查成本”排序：依赖版本与构建布局会尽早、显式地报错；运行时 API 由消费方 typecheck 与测试覆盖。

## 流程

### 1. 确定 harness 版本

harness 没有 changelog；版本号在根 `package.json` 的 `version`，发布 tag 形如 `dsh-v<semver>`。

```sh
cd ../deepseek-harness
grep -m1 '"version"' package.json
git status -sb && git log --oneline -3
git fetch origin --tags --prune
git ls-remote --tags origin | grep -v '\^{}' | awk -F/ '{print $NF}' | sort -V | tail -10
```

`git ls-remote` 反映的是上游实时状态，与本地 fetch 过什么无关；只看本地 tag 列表可能落后好几个版本线。

### 2. 刷新插件消费的 harness 构建产物

harness 的 `lib/` 产物被 gitignore，切换版本后依然存在，因此陈旧的产物面会让插件其实是在对上一个版本做 typecheck。切换版本还可能留下没有 manifest 的包目录，而宿主 workspace 的 glob 仍会匹配并尝试打包它。

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

只跑 `pnpm test` 不足以作为兼容性变更的证据：它跑在 stub 宿主服务上，看不见持久化 codec 或 manifest/mount 漂移。能看见的是镜像检查与 e2e 冒烟；见 [testing.md](testing.zh.md)。

如果删掉 `lib/` 后的干净重建“看起来成功但什么都没产出”，那是 TypeScript 构建缓存还在作祟：先清 `node_modules/.cache/dsh-a2a/`。`tsc -b` 会信任陈旧的 tsbuildinfo，随后 tsdown 找不到入口。

### 5. 只在代码已兼容时改元数据

优先用元数据修复（工程引用路径、peer 范围、版本号），而不是改源码。若确实要改源码，必须在同一改动里新增或调整行为测试。

### 6. 核对 DSH peer 预检

DSH 0.1.7 起，在导入插件前会用运行时版本校验插件的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` peer。预发布版本参与范围匹配，`workspace:^`/`~`/`*` 指当前运行时版本。拒绝时带 `incompatible-version` 错误码并列出未满足的范围；插件管理器会在 pnpm 运行之前就拒绝 registry 安装。

本插件最关键的细节：**该预检忽略 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`**，只有 `@deepseek-ai/dsh-commands` 和 `@deepseek-ai/dsh-storage-domain` 参与。这两个范围要对每个已测 harness 版本保持真实。`cordis` 与 `schemastery` 不参与预检，但声明区间仍要能容纳宿主内置的版本——宿主线内置预发布（如 `4.0.5-alpha.1`）时，要把该精确预发布写进备选（例如 `~4.0.2 || 4.0.5-alpha.1`）。

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

## 兼容记录

| dsh-a2a | 验证所用 harness | 所需改动 | 证据 |
|---|---|---|---|
| 0.4.0 | 0.2.1-rc.2 | A2A 线协议对齐：SendMessage `{task}` envelope、SSE JSON-RPC 帧 + 事件 id、ListTasks `totalSize`、A2A-Version 校验、push 方法返回 `-32003`；按地址限流；运行中任务续接明确拒绝；artifact `append` 语义；出站断流 `Last-Event-ID` 续接；实现 returnImmediately/historyLength；移除未使用的出站 handoff 会话 | `pnpm typecheck`（host + client + 镜像检查）零错误；`pnpm test` 159/159；`pnpm build` 产出 `lib/index.js`+`lib/client.js`；`pnpm test:e2e` 对两个真实 `0.2.1-rc.2` 实例跑通入站与出站往返 |
| 0.3.8 | 0.2.1-rc.2 | CLI 修复：`/a2a inbound create` 与 `outbound create` 多消费一个前导 token；入站描述改为由剩余单词拼接；新增命令解析测试 | `pnpm typecheck`（host + client + 镜像检查）零错误；`pnpm test` 121/121；`pnpm build` 产出 `lib/index.js`+`lib/client.js`；`pnpm test:e2e` 对两个真实 `0.2.1-rc.2` 实例跑通入站与出站往返 |
| 0.3.7 | 0.2.1-rc.2 | 源码修复：入站消息 `source.kind` 由 `plugin` 改为生产者自己的 `a2a`；新增测试层（镜像检查、真实持久化套件、e2e 冒烟）；`vitest.config.ts` 装入 `standardDecoratorPlugin` | `pnpm typecheck`（host + client + 镜像检查）零错误；`pnpm test` 114/114；`pnpm build` 产出 `lib/index.js`+`lib/client.js`；`pnpm test:e2e` 对两个真实 `0.2.1-rc.2` 实例跑通入站与出站往返 |
| 0.3.6 | 0.2.1-rc.2 | 无需改动——peer 范围、zod 收紧、构建布局与清单契约本已兼容；仅版本号与记录 | 清缓存后的 `pnpm typecheck`（host+client）零错误；`pnpm test` 110/110；完整 `pnpm build` 产出 `lib/index.js`+`lib/client.js`+`lib/types` |
| 0.3.5 | 0.2.1-alpha.2 | peer 范围放宽到 0.2 线；zod 收紧到 harness 所在线；为 Vite 8 路径解析新增 tests 专属 tsconfig | `pnpm typecheck`（host+client）零错误；`pnpm test` 110/110；完整 `pnpm build` 产出 `lib/index.js`+`lib/client.js`+`lib/types`；`dsh web` 可启动并正常服务 |
| 0.3.4 | 0.1.7-rc.2 | 修 `tsconfig.client.json` 引用；peer 范围改为真实区间 | typecheck（host+client）零错误；`vitest run` 110/110；完整 `pnpm build` 成功 |
| 0.3.3 | 0.1.5-rc.2 | 无需改动——代码与元数据本已兼容 | 消费方 `pnpm typecheck` 零错误 |

### 0.4.0 细节

协议一致性与安全加固版本。`SendMessage` 返回规范 oneof（`result.task` /
`result.message`）；流式事件改为 JSON-RPC result/error envelope 并带 SSE 事件
id；artifact 增量带 `append` 语义；`ListTasks` 返回 `totalSize`；校验并返回
`A2A-Version`；push 配置方法返回 `PUSH_NOTIFICATION_NOT_SUPPORTED`（`-32003`）。
限流按客户端地址而不是端口；运行中任务续接会明确拒绝而不是静默丢弃；出站
客户端断流后用 `Last-Event-ID` 续接。实现 `returnImmediately`、`historyLength`
与仅文本的 `acceptedOutputModes`。移除未使用的出站 handoff 会话组装。

### 0.3.8 细节

CLI 修复版本。`/a2a inbound create` 与 `/a2a outbound create` 把命令尾部解构为
`[action, id, ...args]`，却从 `args[0]` 读取名称/URL，导致第一个真实参数被丢弃、
必须使用占位符。现在 create 分支从 `id` 读取名称/URL，入站描述由剩余单词拼接
（因此可以包含空格），并由 `tests/unit/commands.spec.ts` 覆盖解析。手册的命令表与
排障页不再描述占位符。

### 0.3.7 细节

这是 bug 修复版本，不是 harness 适配。两处改动：

1. **入站 `(no reply)` 修复。** session 执行器交给 agent 的消息 `source` 是 `{ kind: 'plugin', plugin: 'a2a' }`；JSONL v4 编码器拒绝 `kind: 'plugin'`，写入在 handle 的后台 flush 中失败，agent loop 吞掉错误，于是每个入站任务都以 `COMPLETED` + `(no reply)` 落定。现在改用生产者自己的 `{ kind: 'a2a' }`。
2. **本该抓住它的测试层。** `tests/types/mirrors.typecheck.ts`（编译期 source 契约）、`tests/integration/persistence.spec.ts`（真实 JSONL v4 codec + agent loop）、`scripts/e2e-a2a.mjs`（两个真实实例 + mock LLM，入站与出站）。`vitest.config.ts` 装入 harness 的 `standardDecoratorPlugin`，使测试能 import harness 源码。见 [testing.zh.md](testing.zh.md)。

门禁：`pnpm test:all`——typecheck（host + client + 镜像检查）、114 个测试、build、以及 hermetic e2e 冒烟，全部对 `0.2.1-rc.2` checkout 跑通。

### 0.3.6 细节

harness 从 `0.2.1-alpha.2` 升到 `0.2.1-rc.2`（990 个提交）。无需任何适配，只改了版本号与本文记录。

1. `peerDependencies` 仍覆盖新宿主。`vendor/cordis` 由 `4.0.5-alpha.1 → 4.0.5`、`vendor/schemastery` 由 `3.18.5-alpha.1 → 3.18.5`，两者均已转正并落在既有的 `~4.0.2` 与 `3.*` 区间内。`@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-storage-domain` 保持 `>=0.1.3 <0.3`，覆盖预检所评估的 `0.2` 线。两个精确预发布备选保留：它们让插件对仍运行 alpha 线的宿主保持真实。
2. `dependencies.zod` 继续收紧在 `~4.4.3`；harness 根仍解析到 `zod@4.4.3`，两份 zod 导致的 `exactOptionalPropertyTypes` 失败不会复现。
3. 构建布局未变。`tsconfig.base.json` 只新增 `paths` 别名（plugin-market、cua、remote-access 等本插件未消费的包）；`tsconfig.base.client.json` 与被引用包的 tsconfig 叶子均未变，工程引用与 `ui-settings/tsconfig.client.json` 叶子引用仍然解析。
4. 清单契约未变：`DshClientManifest.inject`、`DshBundleManifest.patch` 与 `- insert:` 补丁格式在 `alpha.2..rc.2` 之间零 diff。

发布之后，一次真实的 `dsh web` 往返暴露了上文那个入站 `(no reply)` bug：110 个 stub 测试看不见，本流程的 typecheck/build 步骤同样看不见。`0.3.7` 已修复，并加上镜像检查、真实持久化套件与 e2e 冒烟（见 `0.3.7` 记录）。

### 0.3.5 细节

插件源码未动；需要三处元数据/构建布局修复。

1. `peerDependencies` 放宽到覆盖 `0.2` 线。`@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-storage-domain` 从 `">=0.1.3 <0.2"` 改为 `">=0.1.3 <0.3"`，因为预发布版本参与范围匹配，该区间覆盖 `0.2.1-alpha.2`。`@deepseek-ai/cordis` 增加 `4.0.5-alpha.1` 备选，`@deepseek-ai/schemastery` 增加 `3.18.5-alpha.1` 备选：`0.2.1-alpha` 宿主内置这两个预发布版，稳定的 `~4.0.2`/`3.*` 区间不接纳它们。
2. `dependencies.zod` 从 `^4.4.3` 收紧为 `~4.4.3`。harness 解析到 zod `4.4.3`；全新安装 `^4.4.3` 会浮动到 `4.6.5`，两份 zod 会让 `@deepseek-ai/schemastery` 的 `Config` 类型在 `exactOptionalPropertyTypes` 下互不兼容。收紧后与 harness 保持同一条 zod 线。
3. `tests/tsconfig.json` 继承构建配置，使 Vite 8 原生的 `resolve.tsconfigPaths` 把 harness 的 `paths` 映射应用到 spec 文件。构建配置的 `include` 只有 `src`；composition 套件直接从 `tests/` 以值方式导入 `@deepseek-ai/cordis`，没有 tests 专属配置时路径映射覆盖不到它，解析会落到不含任何 harness 包的 `node_modules`。

另有两个构建环境细节支撑这些修复。pnpm 11+ 从 `pnpm-workspace.yaml`（而非 `.npmrc`）读取工作区设置，因此 `autoInstallPeers: false` 与 `verifyDepsBeforeRun: false` 放在那里；harness 的各 peer 在真实区间内没有 registry 版本，任何依赖 reify（包括脚本运行前检查）都会失败，必须保持关闭。harness 里的 `pnpm run clean` 同样是前置步骤，而非可选项（见下文“陈旧残留”条目）。

### 0.3.4 细节

只需要两处元数据修复；插件源码未动。

1. `tsconfig.client.json` 原先引用 `ui-settings` 包目录。0.1.7 把该目录的 `tsconfig.json` 变成了 solution 文件（`files: []`），下挂 `tsconfig.host.json` 与 `tsconfig.client.json`，因此引用必须写成 `../deepseek-harness/packages/client/ui-settings/tsconfig.client.json`。引用 solution 目录会报 TS6306。
2. `peerDependencies` 从 `@deepseek-ai/cordis: "4.0.2"` 改为 `"~4.0.2"`（0.1.7 宿主带 4.0.4），并把 `@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-storage-domain` 从 `"*"` 改为 `">=0.1.3 <0.2"`。该真实区间覆盖了本插件测过的全部 harness 版本，且无需豁免即满足 0.1.7 预检。

### 0.3.3 细节

0.1.3 → 0.1.5 区间内 `vendor/cordis` 仍是 4.0.2、`vendor/schemastery` 仍是 3.18.2，本插件消费的那些包只有版本号变动和 README 重写。针对 harness 源码图的消费方 typecheck 零错误通过，因此没有改动发布。

## 断点与修复

- **每个入站任务都 `(no reply)`——被弃用的 `plugin` source kind。** 入站执行器交给 agent 的消息 `source` 是 `{ kind: 'plugin', plugin: 'a2a' }`。`session.append` 的内存校验接受任何非空 kind，所以 stub 测试全绿；真正拒绝 `kind: 'plugin'` 的是 JSONL v4 编码器（`packages/session/session-format-v3-to-v4/src/message-sources.ts`），因为 harness 没有共享的 catch-all plugin kind。拒绝发生在 session handle 的后台 flush 里，agent loop 吞掉驱动错误，任务以 `COMPLETED` + `(no reply)` 落定。修复：改用生产者自己的 kind `{ kind: 'a2a' }`。由 `tests/integration/persistence.spec.ts`（teardown 后断言真实 v4 日志）与 `tests/types/mirrors.typecheck.ts`（旧形状直接编译失败）覆盖。
- **测试里 import harness 源码触发 Vite `SyntaxError`。** harness 源码使用标准 TypeScript 装饰器（`@Remote`），Vite 默认解析器会拒绝。`vitest.config.ts` 现在装上 harness 的 `standardDecoratorPlugin`；集成与类型测试因为直接 value-import `@deepseek-ai/dsh-*` 模块而需要它。
- **solution 引用导致的 TS6306。** 暴露 solution `tsconfig.json` 的 harness 客户端包，必须通过其 `tsconfig.client.json`（或 `tsconfig.host.json`）叶子文件引用。症状：`pnpm typecheck` 在读取插件源码之前就于客户端程序失败。
- **harness 次版本升级后 `incompatible-version` 拒绝。** 插件曾声明 `"*"` 范围，而 `evaluatePluginCompatibility` 会把范围拿去匹配运行时；实际失败主要来自精确钉死的 `cordis` 与宿主副本冲突，以及范围没有描述已测版本。修复方式是写出真实测试区间。
- **`lib/` 为空却“看起来构建成功”。** 陈旧 tsbuildinfo 所致，清 `node_modules/.cache/dsh-a2a/`。
- **客户端 typecheck 读到陈旧声明。** harness 的 `lib/types` 被 gitignore、会在 checkout 重置后存活；切换版本后要重建被引用的 harness 包。
- **harness 中无 manifest 的陈旧包残留会击穿宿主构建。** 从 0.1.7 升到 0.2.1-alpha.2 后，`packages/session/session-title-all-prompts-llm/` 只剩 `lib/` + `node_modules/`；该包现已迁到 `packages/experimental/`。tsdown 的 host workspace 会匹配 `packages/*/*`，于是打包陈旧的 `lib/types/index.js` 并报 `MISSING_EXPORT "registerSessionTitleLlmProvider"`。修复：重建前先在 harness 跑 `pnpm run clean`——它会删除只含已知残留、没有 manifest 的包目录。
- **全新安装后出现两份 zod。** `dependencies.zod: "^4.4.3"` 会浮动到最新的 `4.x`，而 harness 停在 `4.4.3`；typecheck 随后在 zod 的 `$ZodCheck`/`$ZodType` 深处报 `exactOptionalPropertyTypes` 不匹配。把插件收紧到 harness 的 zod 线（`~4.4.3`）。
- **spec 导入取不到 harness 路径映射。** Vite 8 原生的 `resolve.tsconfigPaths` 只对 tsconfig `include` 命中的文件应用 `paths`。构建配置 `include` 为 `src`，因此直接从 spec 导入 `@deepseek-ai/cordis` 会解析失败；`tests/tsconfig.json` 继承构建配置并纳入 spec。
- **每次跑脚本前 `ERR_PNPM_NO_MATCHING_VERSION`。** pnpm 会在运行脚本前 reify 依赖树，而 harness peer 的真实区间在 registry 内没有对应版本。pnpm 11+ 从 `pnpm-workspace.yaml` 读取 `autoInstallPeers` 与 `verifyDepsBeforeRun`；仅设 `.npmrc` 不够。

## 发布

两个 registry，规则不同：

- **npmjs** — `@hanphone/dsh-a2a`，`publishConfig.access: public`。对过期或已撤销 token 返回的 `403` 是 npm 凭据问题，不是包的问题。
- **GitHub Packages**（`npm.pkg.github.com`）——要求 npm scope 等于拥有该包的 GitHub 账号或组织。属于 `HanphoneJan` 的 token 无法创建 `@hanphone/dsh-a2a`，registry 会回 `403 permission_denied: create_package`。要在那里发布，要么拿到 `hanphone` 账号的 token，要么把包改名为 `@hanphonejan/dsh-a2a`；改名是破坏性变更：包名被 `scripts/build-client.mjs` 读取用于 module-loader id，也被 `cordis.patch.yml` 引用。因此发布到 GitHub Packages 是可选项，不属于常规发布流程。

## 已知限制

- 本插件验证过的 harness 版本全是预发布版（`0.1.5-rc.2`、`0.1.7-rc.2`、`0.2.1-alpha.2`、`0.2.1-rc.2`）。兼容记录写的是精确版本而非区间，因为尚无正式版被测过。
- 插件通过 `../deepseek-harness` 路径与 harness 包耦合。若 checkout 位于其它相对路径，需要同步修改 `tsconfig*.json` 的引用。
- 截至撰写时，最新 tag 是 `0.2.1-rc.2`（用 `git ls-remote --tags origin` 核实）；checkout 固定在该 tag 之上，并叠加本地 `llm-pi-ai` `sessionHeader` 补丁。
