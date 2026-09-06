# dsh-a2a 设计文档 v1.0（多实例重构稿）

状态:已实现（2026-09-06 随 v1.0 交付）。v1.0 按用户新业务需求重构:从"单入站 server + 单出站 client"升级为"多入站 server + 多出站 server",每个 server 实例可绑定一个不同的 DeepSeek Harness agent preset,技能宣告文字由创建者输入(默认取 preset 名),全部配置与开关 GUI 可操作,协议面对齐官方 A2A v1.0.1(以 a2aproject/A2A 规范仓库为权威)。

历史:v0.2 文档(单实例、工具白名单派生技能)已废弃,由本稿取代;旧版配置不迁移,直接删除。

---

## 0. 需求(用户原话,逐条编号)

1. 完全实现 a2a 协议的功能
2. 支持多个入站 server 和出站 server
3. 每个入站 server 可以选择不同的 DeepSeek Harness 的 agent preset,如"当前运行在 `ptc` agent preset"
4. 不同的出站 server 也可以接入不同的 agent preset
5. 完全支持 GUI 操作
6. agent 中的技能宣告文字由创建者输入,默认为 preset 名

---

## 1. 定位与目标

一句话:**把 DSH 变成 A2A 的多面手——可同时对外发布多个不同"人格"的入站 A2A server,每个由不同 agent preset 支撑;可同时接入多个出站 A2A server,每个按自己的 preset 组装本端会话;一切能力宣告与开关都在 GUI 里完成;协议面与官方 A2A v1.0.1 对齐。**

与 v0.2 的定位差异:

| 维度 | v0.2 | v1.0 |
|---|---|---|
| 协议 | 自称 v1.0,枚举/结构有出入 | **官方 v1.0.1 对齐**(枚举 `TASK_STATE_*`/`ROLE_*`、AgentCard 结构、方法全集含 push config) |
| 入站 | 单 `/a2a` 端点 | **多 server 实例**,各自端点/卡片/鉴权/preset |
| 出站 | 单 registry 多 agent | **多出站 server 连接**,每连接独立 preset |
| 技能宣告 | 从 ctx.tools 白名单派生 | **创建者输入**(默认 preset 名),协议字段完整 |
| 预设 | 无 | 每实例绑定一个 agent preset |
| GUI | 单页 | 多实例增删改/启停/预设/宣告/鉴权全覆盖 |

---

## 2. 架构总览

```text
┌─ GUI（浏览器, settings.section "A2A 连接"）──────────────────────────────┐
│  入站 servers 列表（创建/删除/启停/预设/宣告文字/鉴权 env）               │
│  出站 servers 列表（创建/删除/启停/预设/远端 URL/超时）                  │
│  任务视图（按实例过滤/取消）· 入站对端监控 · 状态                        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ loopback-only /a2a/api
┌─ Host 半区 ───────────────────▼────────────────────────────────────────┐
│  InboundServerManager                                                   │
│    per server:                                                         │
│      endpointPath (独立, 如 /a2a/<id>)                                  │
│      AgentCard（身份 + 技能宣告 + 鉴权 + supportedInterfaces）           │
│      preset 绑定 → 入站任务会话按该 preset 组装                          │
│      A2AServer 实例（JSON-RPC v1.0.1 + SSE + 任务落库）                  │
│  OutboundServerManager                                                  │
│    per server:                                                         │
│      A2AClient（远端 URL/鉴权/超时）                                     │
│      preset 绑定 → 调用远端时本端会话按该 preset 组装                    │
│      远端 skills → 模型工具 a2a__<id>__<skill>                          │
│  TaskStore（a2a 域, 任务带 serverId 来源）                              │
│  ctx.a2a facade（命令 + GUI 共用）                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

核心抽象:**"server 实例"** = 端点 + 身份/技能宣告 + preset 绑定 + 鉴权 + (出站时)远端引用。入站与出站共享同一定义框架,只是方向与承载不同。

---

## 3. 多入站 server

### 3.1 实例定义

每个入站 server 实例:

- `id`: 稳定标识(路径安全 `[a-z0-9-]`)
- `name` / `description` / `version`: 身份(AgentCard 头部)
- `endpointPath`: 独立端点,默认 `/a2a/<id>`
- `preset`: 绑定的 agent preset id(如 `ptc`);缺省 = 该 server 的入站任务用 DSH 默认 preset 创建会话
- `authTokenEnv`: 可选,环境变量名(每实例独立鉴权)
- `skills`: **宣告列表**(§5),创建者输入
- `enabled`: 开关

### 3.2 路由

webServer 上每实例注册:
- `GET /.well-known/agent-card.json`(默认实例)或 `/a2a/<id>/agent-card.json`(命名实例)
- `POST /a2a/<id>`(JSON-RPC / SSE)

AgentCard 的 `supportedInterfaces[].url` 指向实例自己端点,`protocolBinding: "JSONRPC"`, `protocolVersion: "1.0"`。

### 3.3 入站任务 → preset 会话

实例创建时把 `preset` 传入会话池:入站任务 `SendMessage` → 该实例的会话按 `agentPresets.resolve(preset) + mount(agentCtx, preset)` 组装(机制同 `ContextSessionPool`,只是预设来自实例配置而非全局默认)。不同入站 server 各自拥有不同的工作模式(如一个 `standard`、一个 `ptc`)。

### 3.4 实例生命周期

GUI 可:创建(选 preset/填宣告/设鉴权 env)、启用/停用、删除、编辑。删除会 dispose 该实例的全部 effect 与环境。

---

## 4. 多出站 server

### 4.1 实例定义

每个出站 server 连接实例:

- `id`: 稳定标识(`a2a-out-<uuid>` 或用户命名)
- `name`: 展示名(工具命名空间)
- `agentCardUrl`: 远端 AgentCard 地址
- `bearerTokenEnv`: 可选,环境变量名
- `preset`: **本端在与该远端交互时按该 preset 组装**(调用远端时本地维护的会话)
- `enabled` / `timeoutMs`
- `skills`: 宣告列表(创建者输入;远端卡片技能可自动导入为默认)

> **出站 preset 语义(已确认)**:需求 4 按用户确认的 (b) 解读——出站 server 的 preset 决定"与这个远端对话时本 DSH 维护的本地会话组装"。

### 4.2 出站技能 → 工具

每连接每技能注册为模型工具 `a2a__<name>__<skill>`(规范名,冲突哈希)。

---

## 5. 技能宣告(skill 宣告文字)

### 5.1 数据来源

需求 6:**AgentCard 的每个技能宣告由创建者输入,默认取 preset 名**。

- 创建/编辑 server 实例时,GUI 提供技能宣告表单:
  - `id`(技能标识,路径安全)
  - `name`(显示名,协议必填)
  - `description`(宣告文字,自由输入)
  - 可选 `tags` / `examples` / `inputModes` / `outputModes`(协议字段完整)
- **默认**:未填时,name/description 默认取该实例绑定的 preset 的展示名(`preset.yml` 的 `name`,如 `ptc` → "PTC 模式");无 preset 时默认 `chat`(内置,描述"Conversational assistance over a DSH agent session")。

### 5.2 与"从工具注册表派生"的关系

v0.2 从 `ctx.tools` 派生。v1.0 改为 **"宣告即声明"**:创建者声明这个 server 能做什么,填入 AgentCard 的技能字段。preset 的插件组装负责"实际能做什么",宣告负责"宣称能做什么",二者解耦(与 A2A 协议语义一致:AgentCard 是宣传面)。用户已确认:技能宣告完全取代工具白名单派生,白名单机制删除。

### 5.3 协议字段

AgentSkill(`AgentSkill`):`id, name(必填), description?, tags?, examples?, inputModes?, outputModes?`。AgentCard(`AgentCard`):`name, description?, supportedInterfaces[], provider?, version, documentationUrl?, capabilities(streaming/pushNotifications/extendedAgentCard/stateTransitionHistory), securitySchemes?, securityRequirements?, defaultInputModes, defaultOutputModes, skills[]`。

---

## 6. 完全实现 A2A v1.0.1 协议

### 6.1 方法全集(官方 §5.3 Method Mapping Reference)

| JSON-RPC Method | 状态 |
|---|---|
| `SendMessage` | 实现(含 `return_immediately`/`history_length`/`accepted_output_modes` 配置) |
| `SendStreamingMessage` | 实现(SSE) |
| `GetTask` | 实现(含 `historyLength`) |
| `ListTasks` | 实现(补 `contextId`/`status`/`pageSize`/`pageToken` 过滤分页) |
| `CancelTask` | 实现 |
| `SubscribeToTask` | 实现(SSE;终态任务返回 UnsupportedOperationError) |
| `CreateTaskPushNotificationConfig` | P1(方法面声明,返回 PushNotificationNotSupportedError) |
| `GetTaskPushNotificationConfig` | P1(同上) |
| `ListTaskPushNotificationConfigs` | P1(同上) |
| `DeleteTaskPushNotificationConfig` | P1(同上) |
| `GetExtendedAgentCard` | 实现 |

### 6.2 JSON 序列化(ADR-001 ProtoJSON)

- TaskState: `"TASK_STATE_*"`(SCREAMING_SNAKE_CASE)
- Role: `"ROLE_USER"` / `"ROLE_AGENT"`
- 字段名 camelCase

### 6.3 传输

- Content-Type: `application/json`;流式 `text/event-stream`
- `A2A-Version` 头:客户端发送版本,服务端校验,不支持则 `VersionNotSupportedError`(-32007)
- `A2A-Extensions` 头:透传(本插件不消费)

### 6.4 错误码(§3.3.2 + §9.5)

`-32700 ParseError, -32600 InvalidRequest, -32601 MethodNotFound, -32602 InvalidParams, -32603 InternalError, -32001 TaskNotFound, -32002 TaskNotCancelable, -32003 PushNotificationNotSupported, -32004 UnsupportedOperation, -32005 ContentTypeNotSupported, -32006 StreamingNotSupported, -32007 VersionNotSupported, -32008 InvalidAgentResponse`。

---

## 7. 数据模型与存储

### 7.1 server 实例持久化

`a2a` 域表(JSON,版本 1——加表不改记录格式):
- `inbound-servers`: `InboundServerRecord { id, name, description, version, endpointPath, preset?, authTokenEnv?, skills: AgentSkill[], enabled }`
- `outbound-servers`: `OutboundServerRecord { id, name, agentCardUrl, bearerTokenEnv?, preset?, enabled, timeoutMs }`
- `tasks` / `contexts` / `agents` / `identity`: 保留;任务记录加 `serverId` 来源字段

### 7.2 任务存储

TaskRecord 增加可选 `serverId`,标识来自哪个入站实例;`jobs`/`pushConfigs`(P1 push)预留。

---

## 8. 服务与命令

- `ctx.a2a` facade 扩展:server 实例 CRUD(enable/disable/remove/update)、preset 选择、技能宣告编辑、出站连接 CRUD、任务按实例查询/取消
- `/a2a` 命令面同步扩展(备用路线)
- GUI(`/a2a/api`)扩展:多实例快照 + 控制

---

## 9. GUI(settings.section "A2A 连接")

分栏:
- **入站 Servers**:列表(名/端点/preset/启停/宣告文字/鉴权 env)+ 新建表单(选 preset、填技能宣告、可选鉴权 env)
- **出站 Servers**:列表(名/远端 URL/预设/启停/超时)+ 新建(填 URL、选 preset、可选 token env)
- **任务**:按实例过滤/取消
- **入站监控**:每实例对端列表(来源/首末次/任务/关闭)
- **服务身份**:实例 name/description/version 编辑(按实例)

所有写操作经 loopback-only `/a2a/api`。

---

## 10. 安全性

- token 走环境变量名(每实例 `authTokenEnv`),不落明文
- `/a2a/api` 仅回环
- 每入站实例独立鉴权
- AgentCard 只声明安全方案,不暴露 token 值

---

## 11. 目录结构(重构后)

```text
src/
  index.ts                 # Cordis 插件入口(组装两个 Manager)
  protocol.ts              # A2A v1.0.1 协议常量 + 类型(全量)
  jsonrpc.ts               # JSON-RPC 2.0 帧
  servers/
    inbound-manager.ts     # 入站 server 实例集合(路由/生命周期)
    outbound-manager.ts    # 出站 server 实例集合(连接/工具)
    instance.ts            # 单实例装配(端点+卡片+preset+鉴权)
  server/                  # 单实例内部件
    a2a-server.ts          # JSON-RPC/SSE 服务(参数化 endpoint/card)
    card.ts                # AgentCard 构建(宣告驱动)
    executor/ …            # session/subagent 执行器(preset 化)
    store.ts               # 任务/实例持久化
    identity.ts            # 实例身份
  outbound/                # 出站单连接内部件
  client/                  # 浏览器面板(多实例 UI)
  api.ts                   # loopback GUI API(多实例)
  service.ts               # ctx.a2a facade
  commands.ts
```

---

## 12. 迁移与兼容

- **旧版配置完全删除,不迁移**(用户确认)。v0.2 的 `server.enabled`/`client.agents` 等配置不再被读取。
- 新安装:无实例,AgentCard 端点 404,GUI 显示"创建第一个 server"。
- 任务记录向后兼容(serverId 可选)。

---

## 13. 测试

- 单测:多实例路由隔离、preset 绑定、宣告构建、出站连接 × preset、API 多实例、协议序列化(`TASK_STATE_*`)
- 组合:多个入站 server 实例互不干扰、GUI 建删启停
- 协议互操作:用官方 SDK/examples 交叉核对(设计期已审计,测试补覆盖)

---

## 14. P1 / 明确不做

- push notifications 的 webhook 投递(方法面已声明/返回不支持)
- OAuth 2.0 / gRPC 绑定 / REST 绑定
- 官方 conformance 套件(以 spec 审计 + 交叉测试替代)

---

## 15. 评审确认点(已确认)

1. 出站 preset 语义 = b) 与远端对话时本端会话按该 preset 组装 —— **已确认**
2. 技能宣告完全取代工具白名单派生 —— **已确认**
3. 旧版本完全删除,不迁移 —— **已确认**
4. 协议权威 = `.research/A2A`(官方 1.0.1) —— **已确认**(方法名/枚举/结构已按此对齐)