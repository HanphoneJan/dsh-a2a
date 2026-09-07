# dsh-a2a

Agent2Agent（A2A）v1.0.1 双端插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — [English](README.md) · **中文**

`@hanphone/dsh-a2a` 是一个独立开源的 A2A 插件，把 DeepSeek Harness profile 变成多面手 A2A 一等公民：能**同时对外发布多个入站 A2A server**，每个绑定一个自己的 agent preset、拥有独立端点 / AgentCard / 派生技能 / 鉴权；也能**同时接入多个出站 A2A server**，每个独立 preset，远端技能映射为模型工具。所有 server 实例的创建、启停、编辑、删除全部在 GUI 完成——无需改任何配置文件。

架构与设计决策：[docs/architecture.md](docs/architecture.md)。

## 功能

- **A2A v1.0.1 协议面，对齐官方规范** — JSON-RPC 上的 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`GetExtendedAgentCard`、`SubscribeToTask`；SSE 流式带补发帧；官方 `TASK_STATE_*` / `ROLE_*` 枚举与 AgentCard 结构（含 `supportedInterfaces`、`capabilities`、完整错误码表）。
- **多入站 server** — 每实例一个"人格"：独立端点（`/a2a/<id>`）、AgentCard 路由、鉴权 env、派生技能。
- **每实例 agent preset** — 每个入站 server 绑定一个具体 agent preset（如 `ptc`、`standard`、`minimal`、…）；选择器只列 roster 真实预设（与应用内选择器一致）并默认选中部署默认。入站任务在按该 preset 组装的会话中执行（标准 `agentPresets` resolve+mount 路径）。
- **技能宣告从 preset 派生** — AgentCard 技能 = 所绑 preset 技能目录中模型可调条目（`agentPresets.standingKeyFor` + `ctx.skills.list`），纯自动派生——"preset 确定、技能确定，一切皆插件"。无需手写技能表单；skills 服务缺失时兜底内置 `chat`。远端用 `metadata.skill` 调技能，由该 preset 会话经其 `tool-skill` 装载执行。
- **多出站 server** — 每个连接独立远端 URL、鉴权 env、超时与可选 preset；启用实例把远端技能映射为 `a2a__<name>__<skill>` 模型工具。
- **持久化任务存储** — 任务存于 `a2a` 存储域（默认 json 后端，可按部署切 SQLite）；服务端生成 id 跨重启存活，每个任务记录来源入站实例。
- **执行器** — `session`（每个 `contextId` 一个 DSH 会话）与 `subagent`（委托 `ctx.subagents`，工具调用过程流式回传）。
- **受治理入站** — 每个入站任务经过 `a2a/inbound-task` waterfall，策略插件可否决或审计。
- **入站连接监控** — 面板展示每个实例的对端连接，可关闭某个对端。
- **直接填 Bearer Token** — GUI 的 Bearer Token 输入框把每个实例的 token 经 harness 凭据服务写入托管 `.env`/凭据库（`0o700`）；记录只保留自动生成的变量名，token 明文绝不进 a2a 域或 AgentCard。运行时读取分层（凭据 → 进程环境），外部 export 同名变量仍兼容。
- **最小插件配置** — 实例经 GUI 创建并存于域中；插件 `Config` 只承载宿主级默认值（`baseUrl`、`subagentProvider`、`defaultTimeoutMs`）。

## 安装

### 从 npm

```sh
dsh plugin --profile web add @hanphone/dsh-a2a
```

任意 profile 名均可（`web`、自定义 profile、headless 等）：

```sh
dsh plugin --profile <name> add @hanphone/dsh-a2a
```

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
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"role":"user","parts":[{"text":"hello"}],"metadata":{"skill":"chat"}}}}'
```

## GUI 面板

浏览器端在设置中注册 **A2A 连接** 页，分三个 Tab。无需改文件即可：

- **入站 Servers** — 创建入站 server（名称/描述/版本、agent preset 选择器——只列真实 roster 预设并预选部署默认、Bearer Token 输入框），启停、编辑（含清除鉴权）、删除；每张卡片显示端点、preset 徽章、鉴权状态、preset 派生技能 chips 与实时 AgentCard URL。
- **出站 Servers** — 两阶段添加出站连接：输入远端 AgentCard URL（± Bearer Token）→「导入」预览远端卡片（名称/版本/技能/端点）→「连接」确认；启停、刷新、编辑（名称/preset/超时/token）、删除。卡片显示连接状态点、工具数与错误。
- **连接与任务** — 入站对端表（谁在调用、任务数、流式、关闭控制）与任务列表（按来源查看、取消）。

所有面板流量走 profile webServer 上的**仅回环** `/a2a/api` 路由——远程对端永远无法驱动它。

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

base 类 profile 全部挂载：`webServer`（`@deepseek-ai/dsh-host-webserver`）、存储栈（`@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-domain`）、工具注册表（`@deepseek-ai/dsh-tools`）、agent 循环（`@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop`）、agent presets（`@deepseek-ai/dsh-agent-presets`；preset 选择器与 preset 化会话组装需要它）。subagent 执行器还需要 `@deepseek-ai/dsh-subagent`。

### 存储后端

任务与实例存储位于 `a2a` 存储域。base 组合默认走 `json` 后端；要切 SQLite，在同一 patch 层路由域并加后端：

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

## CLI

`/a2a` 聊天命令与面板对应（GUI 的文字备用路线）：

```
a2a status | presets | peers |
    inbound list|create|remove|enable|disable |
    outbound list|create|remove|enable|disable|refresh |
    tasks | task get|cancel <id> | help
```

## 工作原理

- **入站** — `InboundServerManager` 拥有每个实例：每实例 = preset 化会话池 + `A2AServer` + 路由。实例持久化于 `inbound_servers` 表，各自服务独立端点与 AgentCard。任务流经 `a2a/inbound-task` → 执行器 → 任务存储，SSE 帧推送给订阅者。
- **出站** — `OutboundServerManager` 拥有每个连接：每实例一个带独立 agent 存储的 `OutboundAgentRegistry`，实例持久化于 `outbound_servers` 表。`A2AClient` 发现 AgentCard，每个技能注册为一个工具。
- **面板** — 浏览器端（React，`settings.section`）经仅回环 `/a2a/api` 路由读写；host 端喂给它入站/出站 server 视图与 preset 名单（`/a2a/api/presets`）。

完整设计见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```
src/
  api.ts                  # 回环面板 API (/a2a/api、/a2a/api/presets)
  index.ts                # Cordis 插件入口 (apply)
  protocol.ts             # A2A v1.0.1 协议常量与类型
  jsonrpc.ts              # JSON-RPC 帧
  servers/                # 多实例管理器
    inbound-manager.ts    #   入站 server 实例（CRUD、路由、生命周期）
    outbound-manager.ts   #   出站连接实例（CRUD、工具）
  server/                 # 单实例内部件：store、card、a2a-server、
                          #   routes、executors、inbound-registry
  outbound/               # 出站内部件：A2AClient、registry、tools
  client/                 # 浏览器半区：设置面板 (React)
  service.ts              # ctx.a2a 服务 facade
  commands.ts             # /a2a 聊天命令
tests/
  unit/                   # protocol、framing、card、store、registry、server、
                          #   client、api、inbound-registry、identity
  composition/            # 在真实 Cordis Context 上以 stub 宿主服务跑 apply()
cordis.patch.yml          # bundle patch（挂载插件；实例由 GUI 管理）
```

## 开发

> 插件通过项目引用对 harness 源码图做类型检查；需要已构建宿主聚合的 harness checkout。

```sh
pnpm typecheck   # host (tsc -b) + client (tsc -p tsconfig.client.json)
pnpm test        # vitest run（单元 + 组合套件）
pnpm build       # tsc + tsdown → lib/index.js（host）+ lib/client.js（浏览器）
```

## 致谢

本项目受 [ryubyte/dsh-a2a](https://github.com/ryubyte/dsh-a2a) 启发并与其并行开发——那是 DeepSeek Harness 上更早的 A2A 插件。其设计——双端范围、AgentCard 宣告、设置面板模式——为本文实现指明了方向。我们的协议层、任务存储与执行器接缝均为独立实现；GUI 管理模型则直接承袭了 ryubyte 的连接面板。

## 许可证

MIT