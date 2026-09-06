# dsh-a2a

Agent2Agent（A2A）v1.0 双端插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

> [English](README.md) | **中文**

`@hanphone/dsh-a2a` 把 DeepSeek Harness profile 变成 A2A 一等公民：

- **入站服务端** —— 从实时工具注册表派生的 AgentCard、JSON-RPC + SSE、持久化任务存储、可插拔的会话/子代理执行器，以及带审计的策略门禁（`a2a/inbound-task`）。
- **出站客户端** —— 持久化的多 Agent 注册表，远程技能映射为模型工具（`a2a__<name>__<skill>`），带每 agent 超时的同步调用。
- **GUI 面板** —— Harness Web UI 设置中的 **A2A 连接** 页：开关入站服务端、管理出站 agent、查看与取消任务——无需改任何配置文件。

设计决策见 [docs/architecture.md](docs/architecture.md)。当前范围为该文档中的 P0。

## 功能

- **A2A v1.0 协议面** —— JSON-RPC 上的 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`GetExtendedAgentCard`、`SubscribeToTask`；SSE 流式带补发帧。
- **动态 AgentCard** —— 技能从实时 `ctx.tools` 注册表派生（显式 id 清单，缺失引用大声失败），外加内置 `chat` 技能，装完即可直接验证。
- **持久化任务存储** —— 任务存于 `a2a` 存储域（默认 json 后端，可按部署切 SQLite）；任务 id 服务端生成且跨重启存活。
- **执行器** —— `session`（每个 `contextId` 一个 DSH 会话）与 `subagent`（委托 `ctx.subagents`，把工具调用过程流式回传）两种内置实现。
- **受治理的入站** —— 每个入站任务都经过 `a2a/inbound-task` waterfall，策略插件可在执行前否决或审计。
- **环境变量鉴权** —— 入站 Bearer token 只以环境变量名（`authTokenEnv`）引用，不以明文落配置。
- **装完即用** —— `dsh plugin add` 后两端默认启用，无需手动 patch。

## 安装

### 从 npm 发布版安装

```sh
dsh plugin --profile web add @hanphone/dsh-a2a
```

任意 profile 名均可：

```sh
dsh plugin --profile <name> add @hanphone/dsh-a2a
```

### 本地构建安装

```sh
cd dsh-a2a
pnpm build
npm pack
dsh plugin --profile <name> add <path-to>/hanphone-dsh-a2a-0.1.0.tgz
```

## 快速开始

1. **安装** —— `dsh plugin --profile web add @hanphone/dsh-a2a`。
2. **重启 GUI** —— 浏览器端插件表在 host 启动时扫描，装完请重启一次 `pnpm dsh web`（或对应 profile 启动命令）。
3. **打开 设置 → A2A 连接** —— 会看到入站服务端状态、出站 agent 列表与任务列表。

入站服务端监听在 profile 的 webServer 上（默认 `http://127.0.0.1:3080`）：

```sh
curl http://127.0.0.1:3080/.well-known/agent-card.json
```

发一个任务（内置 `chat` 技能）：

```sh
curl -X POST http://127.0.0.1:3080/a2a \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"role":"user","parts":[{"text":"hello"}],"metadata":{"skill":"chat"}}}}'
```

## GUI 面板

浏览器端在设置中注册 **A2A 连接** 页。无需改文件即可：

- 开关入站服务端（`server.enable` / `server.disable`），
- 列出、添加、启用/停用、刷新、删除出站 agent，
- 查看与取消入站任务。

所有面板流量都走 profile webServer 上的**仅回环** `/a2a/api` 路由——远程对端永远无法驱动它。

## 配置

面板覆盖日常操作。面板不编辑的项（name/description、baseUrl、`authTokenEnv`、skills、executors、toolPrefix）通过 profile 用户 patch 层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）配置——保留方式：

```yaml
- id: a2a
  config:
    server:
      enabled: true
      name: My DSH Agent
      description: A DeepSeek Harness agent exposed over A2A v1.0
      version: 0.1.0
      baseUrl: http://127.0.0.1:<port>   # 省略则从 webServer 地址派生
      endpointPath: /a2a
      authTokenEnv: A2A_INBOUND_TOKEN    # 可选；环境变量名，绝不写 token 明文
      skills:
        ids: []                          # 暴露的显式工具 id；chat 为内置
        exclude: []
      executors:
        chat: session                    # 或 subagent（需要 subagent 接缝）
      subagentProvider: in-process
    client:
      toolPrefix: a2a
      agents: []                         # 或声明式列出 agent
```

### 所需宿主服务

base 类 profile 全部挂载：`webServer`（`@deepseek-ai/dsh-host-webserver`）、存储栈（`@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-domain`）、工具注册表（`@deepseek-ai/dsh-tools`）、agent 循环（`@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop`；subagent 执行器还需要 `@deepseek-ai/dsh-subagent`）。

### 存储后端

任务存储位于 `a2a` 存储域。base 组合默认走 `json` 后端；要切 SQLite，在同一 patch 层路由域并加后端：

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

### 出站 agent（文件声明，可选——GUI 管理同一列表）

```yaml
- id: a2a
  config:
    client:
      toolPrefix: a2a
      agents:
        - name: my-remote-agent
          agentCardUrl: https://remote.example/.well-known/agent-card.json
          bearerTokenEnv: A2A_REMOTE_TOKEN   # 可选；环境变量名
          enabled: true
          timeoutMs: 60000
```

每个启用远程 agent 的技能会注册为 `a2a__<name>__<skill>` 模型工具（规范化、冲突哈希）。注册表跨重启持久化。

## CLI

`/a2a` 聊天命令与面板对应：

```
a2a status | enable | disable | card | agents |
    agent add|remove|enable|disable|refresh |
    tasks | task get|cancel <id> | help
```

## 工作原理

- **入站** —— `POST /a2a`（JSON-RPC）与 `GET /.well-known/agent-card.json`；AgentCard 从实时工具注册表派生。任务流经 `a2a/inbound-task` → 执行器 → 任务存储，SSE 帧推送给订阅者。
- **出站** —— `a2a` 域中的持久化 `agents` 表；`A2AClient` 发现 AgentCard，每个技能注册为一个工具。
- **面板** —— 浏览器端（React，`settings.section`）经仅回环 `/a2a/api` 路由读写。

完整设计见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```
src/
  api.ts             # 回环面板 API (/a2a/api)
  index.ts           # Cordis 插件入口 (apply)
  protocol.ts        # A2A v1.0 协议常量与类型
  jsonrpc.ts         # JSON-RPC 帧
  server/            # 入站半区：store、card、a2a-server、routes、executors
  outbound/          # 出站半区：A2AClient、registry、tools
  client/            # 浏览器半区：设置面板 (React)
  service.ts         # ctx.a2a 服务 facade
  commands.ts        # /a2a 聊天命令
tests/
  unit/              # protocol、framing、card、store、registry、server、client、api
  composition/       # 在真实 Cordis Context 上以 stub 宿主服务跑 apply()
cordis.patch.yml     # bundle patch（挂载插件，默认启用）
```

## 开发

> 插件通过项目引用对 harness 源码图做类型检查；需要已构建宿主聚合的 harness checkout。

```sh
pnpm typecheck   # host (tsc -b) + client (tsc -p tsconfig.client.json)
pnpm test        # vitest run（单元 + 组合套件）
pnpm build       # tsc + tsdown → lib/index.js（host）+ lib/client.js（浏览器）
```

## 致谢

本项目受 [ryubyte/dsh-a2a](https://github.com/ryubyte/dsh-a2a) 启发并与其并行开发——那是 DeepSeek Harness 上更早的 A2A 插件。其设计——双端范围、从工具注册表派生 AgentCard、设置面板模式——为本文实现指明了方向。我们的协议层、任务存储与执行器接缝均为独立实现；GUI 管理模型则直接承袭了 ryubyte 的连接面板。

## 许可证

MIT