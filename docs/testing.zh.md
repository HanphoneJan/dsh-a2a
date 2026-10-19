# 测试

`@hanphone/dsh-a2a` 的测试策略、各层能抓什么、怎么运行。一句话总结：**插件可以全绿通过所有 stub 测试，但对着真实 harness 运行时仍然是坏的。** 下面的分层就是让 harness 契约变化在发布前失败。

[English](testing.md) · **中文**

## 为什么有这份文档

`0.3.6` 发布时，入站执行器交给 agent 的消息 `source` 是 `{ kind: 'plugin', plugin: 'a2a' }`（已在 `0.3.7` 修复）。`session.append` 的内存校验只要求 `source.kind` 是非空字符串，所以 110 个 stub 测试全绿。真正拒绝 `kind: 'plugin'` 的是只在真实组合里才会执行的 JSONL v4 编码器：

```text
SessionFormatError: format v4 message requires a producer-owned source kind
    at packages/session/session-format-v3-to-v4/src/message-sources.ts
```

写入在 session handle 的后台 flush 中失败，agent loop 把驱动错误吞掉，于是每个入站任务都以 `(no reply)` 落定。`pnpm typecheck` 和 `pnpm test` 都看不见。镜像检查与真实持久化集成测试就是为这个缺口加的。

## 分层

| 层 | 位置 | 能抓什么 | 需要 harness checkout |
|---|---|---|---|
| 镜像检查 | `tests/types/mirrors.typecheck.ts` | 结构镜像与真实 `@deepseek-ai/dsh-*` 类型漂移 | 是（project references） |
| 单元 / 组合 | `tests/unit`、`tests/composition` | 协议帧、路由、store、registry，以及 stub 宿主服务上的 `apply()` 装配 | 否 |
| 真实持久化集成 | `tests/integration/persistence.spec.ts` | 持久化 session codec、agent loop 契约、inbox source——就是上面那类 bug | 是（源码图） |
| Profile 冒烟 | `scripts/e2e-a2a.mjs` | 发布产物对两个真实 harness 实例：manifest/mount、路由、发现、JSON-RPC、工具注册、模型 → 工具 → 远端 agent | 是（已构建产物） |

## 命令

```sh
pnpm typecheck        # host（tsc -b）+ client + 镜像检查
pnpm test             # vitest run：单元 + 组合 + 集成
pnpm test:integration # 只跑真实持久化套件
pnpm build            # tsc + tsdown + 浏览器 bundle -> lib/
pnpm test:e2e         # 双实例 A2A 冒烟（需要已构建的插件）
pnpm test:all         # typecheck + test + build + test:e2e
```

`pnpm test:e2e` 需要：

- 已构建的插件（`pnpm build`）——缺 `lib/index.js` 会快速失败并给出提示；
- 兄弟目录 `../deepseek-harness` checkout（可用 `DSH_A2A_HARNESS_DIR` 覆盖），并且宿主产物已构建（`pnpm install && pnpm run build`）；
- 不需要其他东西：模型用 harness 自带的 mock LLM server。

`DSH_A2A_KEEP=1` 会保留两个临时 home 和子进程便于排查。

## e2e 流程

`scripts/e2e-a2a.mjs` 是 hermetic 且确定性的：

1. 两个临时 Harness home（`a`、`b`）各写一个 `web` profile（`a` 还加 `headless`），bundle 列表直接挂已构建插件；不碰 registry，不碰用户 home。
2. 每个 home 起一个脚本化 mock LLM server（`@deepseek-ai/dsh-llm-mock-server`），用 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` 把 `dsh web` 指过去。
3. **入站**：在 B 建入站 server，取 AgentCard，POST `SendMessage`，断言 artifact 是 mock 的文本。
4. **出站**：在 A 建到 B 的出站连接，断言 `connected` 且至少注册一个工具。
5. **往返**：停掉 A 的 web 实例，用 A 的 `headless` profile 对一个会调用 `a2a__b__chat` 的 mock 脚本发任务，断言 stdout 是 B 的回复。
6. 拆掉两个 home 和所有子进程。

## 加测试

- **行为变更** → 按 `AGENTS.md`，加一个去掉改动就会失败的单元/`composition` 测试。
- **新的宿主契约面**（新运行时服务、消息形状、存储字段）→ 有结构镜像就扩镜像检查；只有端到端才可观测的就加真实持久化或 e2e 断言。
- **新的 e2e 步骤** → 加进 `scripts/e2e-a2a.mjs`，并保持离线：默认运行里唯一允许的模型是 mock LLM server。

## CI

`.github/workflows/ci.yml` 在每次 push / PR 跑 `check`（typecheck + tests），PR 上再对 pinned harness 版本跑 `e2e`。每日定时和手动触发的完整矩阵覆盖 peer ranges 声称支持的全部 harness 版本（`0.2.1-rc.2`、`0.2.1-alpha.2`、`0.1.7-rc.2`）。扩展 `peerDependencies` 时同一次变更里扩矩阵。
