# dsh-a2a

Agent2Agent（A2A）v1.0.1 双端插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — [English](README.md) · **中文**

`@hanphone/dsh-a2a` 是一个独立开源的 A2A 插件，把 DeepSeek Harness profile 变成多面手 A2A 一等公民：能**同时对外发布多个入站 A2A server**，每个绑定一个自己的 agent preset、拥有独立端点 / AgentCard / 派生技能 / 鉴权；也能**同时接入多个出站 A2A server**，每个独立 preset，远端技能映射为模型工具。所有 server 实例的创建、启停、编辑、删除全部在 GUI 完成——无需改任何配置文件。

工作原理：[docs/architecture.md](docs/architecture.md)。
跟随 DeepSeek Harness 版本更新：[docs/harness-compatibility.md](docs/harness-compatibility.md)。

## 功能

- **A2A v1.0.1 协议面，对齐官方规范** — JSON-RPC 上的 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`GetExtendedAgentCard`、`SubscribeToTask`；SSE 流式带补发帧；官方 `TASK_STATE_*` / `ROLE_*` 枚举与 AgentCard 结构（含 `supportedInterfaces`、`capabilities`、完整错误码表）。
- **多入站 server，每个绑定一个 preset** — 每实例独立端点（`/a2a/<id>`）、AgentCard、鉴权 env 与 roster preset；会话经标准 `agentPresets` resolve+mount 路径按该 preset 组装。
- **技能从 preset 派生** — 卡片宣告所绑 preset 技能目录中模型可调的条目（`agentPresets.standingKeyFor` + `ctx.skills.list`）。无需手写技能表单；skills 服务缺失时兜底内置 `chat`，远端用 `metadata.skill` 选择技能。
- **多出站 server** — 每个连接独立远端 URL、鉴权 env、超时与可选 preset；启用实例把远端技能映射为 `a2a__<name>__<skill>` 模型工具。
- **持久化任务存储** — 任务存于 `a2a` 存储域（默认 json 后端，可按部署切 SQLite）；服务端生成 id 跨重启存活，每个任务记录来源入站实例。
- **执行器** — `session`（每个 `contextId` 一个 DSH 会话）与 `subagent`（委托 `ctx.subagents`，工具调用过程流式回传）。
- **受治理入站** — 每个入站任务经过 `a2a/inbound-task` waterfall，策略插件可否决或审计。
- **入站可观测性** — 面板展示活跃对端与每个 `contextId` 一行会话（状态、计数、流式、活动时间），带关闭/取消操作。会话在内存中；没有 agent 循环时表格降级为任务记录。
- **直接填 Bearer Token** — GUI 的 Bearer Token 输入框把每个实例的 token 经 harness 凭据服务写入托管 `.env`/凭据库（`0o700`）；记录只保留自动生成的变量名，token 明文绝不进 a2a 域或 AgentCard。运行时读取分层（凭据 → 进程环境），外部 export 同名变量仍兼容。
- **版本号与检查更新** — 面板显示插件版本、Node 运行环境与各卡片的 AgentCard 版本；「检查更新」同时问 npm 与 GitHub（缓存 6 小时，只读），有新版本时给出两步更新命令。
- **最小插件配置** — 实例经 GUI 创建并存于域中；插件 `Config` 只承载宿主级默认值（`baseUrl`、`subagentProvider`、`defaultTimeoutMs`）。

## 安装

### 从 npm

```sh
dsh plugin --profile web add @hanphone/dsh-a2a
```

任意 profile 名均可（`web`、自定义 profile、headless 等）。

### 本地构建安装

```sh
cd dsh-a2a
pnpm build
npm pack
dsh plugin --profile <name> add <path-to>/hanphone-dsh-a2a-<version>.tgz
```

## 快速开始

1. **安装** — `dsh plugin --profile web add @hanphone/dsh-a2a`。
2. **重启 GUI** — 浏览器端插件表在 host 启动时扫描，装完请重启一次（`pnpm dsh web` 或对应 profile 启动命令）。
3. **打开 设置 → A2A 连接** — 创建第一个入站 server（选 preset——技能自动派生——可选鉴权 env）。创建即时启用并发布自己的端点与 AgentCard。

每个入站 server 监听在 profile 的 webServer 上：

```sh
# 所建实例的 AgentCard（确切 id 见 GUI）
curl http://127.0.0.1:3080/a2a/<id>/agent-card.json
```

向实例发任务（其宣告的 `chat` 技能）：

```sh
curl -X POST http://127.0.0.1:3080/a2a/<id> \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"role":"ROLE_USER","parts":[{"text":"hello"}],"metadata":{"skill":"chat"}}}}'
```

## GUI 面板

浏览器端在设置中注册 **A2A 连接** 页：版本/更新条、入站 server 卡片（preset、派生
技能、鉴权、实时卡片 URL）、出站连接（两阶段"导入 → 预览 → 连接"），以及连接与任务
页（对端、按上下文的会话、任务）。所有面板流量走**仅回环** `/a2a/api` 路由。
逐字段说明见[运维指南](docs/guide/operations.zh.md#2-面板)。

## 配置

GUI 覆盖日常实例管理。插件 `Config` 只有宿主级默认值，如需覆盖可经 profile 用户 patch 层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）设置：

```yaml
- id: a2a
  config:
    baseUrl: http://127.0.0.1:<port>   # 省略则从 webServer 地址派生
    subagentProvider: in-process
    defaultTimeoutMs: 60000            # 出站连接默认超时
```

实例**不**经 patch 配置——它们在 GUI 中创建并持久化于 `a2a` 域（`inbound_servers` / `outbound_servers` 表）。

### 所需宿主服务

基础 profile 已挂载插件用到的全部服务。自定义组合必须提供存储栈、`webServer`、
`tools`、agent 循环与 `agentPresets`；缺失某项的具体影响见
[运维指南：宿主服务](docs/guide/operations.zh.md#6-宿主服务)。

### 存储后端

任务与实例存储位于 `a2a` 存储域（默认 JSON；SQLite 是按域路由的选项）。patch 示例见
[运维指南：存储](docs/guide/operations.zh.md#7-存储)。

## CLI

`/a2a` 聊天命令与面板对应（GUI 的文字备用路线）：

```
a2a status | presets | peers |
    inbound list|create|remove|enable|disable |
    outbound list|create|remove|enable|disable|refresh |
    tasks | task get|cancel <id> |
    sessions | session cancel|close <contextId> | help
```

## 目录结构

```
src/
  api.ts                  # 回环面板 API (/a2a/api、/a2a/api/update 等)
  index.ts                # Cordis 插件入口 (apply)
  protocol.ts             # A2A v1.0.1 协议常量与类型
  jsonrpc.ts              # JSON-RPC 帧
  update.ts               # 插件版本 + npm/GitHub 更新检查
  servers/                # 多实例管理器
    inbound-manager.ts    #   入站 server 实例（CRUD、路由、生命周期）
    outbound-manager.ts   #   出站连接实例（CRUD、工具）
  server/                 # 单实例内部件：store、card、a2a-server、
                          #   routes、executors、inbound-registry、session-registry
  outbound/               # 出站内部件：A2AClient、registry、tools
  client/                 # 浏览器半区：设置面板 (React)
  service.ts              # ctx.a2a 服务 facade
  commands.ts             # /a2a 聊天命令
tests/
  unit/                   # protocol、framing、card、store、registry、server、
                          #   update、client update-status、api 等
  composition/            # 在真实 Cordis Context 上以 stub 宿主服务跑 apply()
  integration/            # 真 agent loop + JSONL 持久化 + mock LLM
  types/                  # 对真实 DSH 类型做编译期镜像检查
scripts/
  e2e-a2a.mjs             # 双实例 A2A hermetic 冒烟
docs/                     # 公开手册 + 架构/兼容性/测试
cordis.patch.yml          # bundle patch（挂载插件；实例由 GUI 管理）
```

## 文档

从[文档索引](docs/README.zh.md)开始（安装、概念、运维、HTTP API、排障）。
深入文档：[架构](docs/architecture.zh.md)、
[Harness 兼容性](docs/harness-compatibility.zh.md)、
[测试](docs/testing.zh.md)。

## 开发

> 插件通过项目引用对 harness 源码图做类型检查；需要已构建宿主聚合的 harness checkout。

```sh
pnpm typecheck   # host + client + 编译期镜像检查
pnpm test        # vitest run（单元 + 组合 + 真实持久化）
pnpm build       # tsc + tsdown → lib/index.js（host）+ lib/client.js（浏览器）
pnpm test:e2e    # 对已构建产物的双实例 A2A hermetic 冒烟
pnpm test:all    # typecheck + test + build + e2e
```

stub 测试看不见宿主运行时契约漂移。分层、各层能抓什么、e2e 流程见 [docs/testing.zh.md](docs/testing.zh.md)。

## 致谢

本项目受 [ryubyte/dsh-a2a](https://github.com/ryubyte/dsh-a2a) 启发并与其并行开发——那是 DeepSeek Harness 上更早的 A2A 插件。其设计——双端范围、AgentCard 宣告、设置面板模式——为本文实现指明了方向。我们的协议层、任务存储与执行器接缝均为独立实现；GUI 管理模型则直接承袭了 ryubyte 的连接面板。

## 许可证

MIT