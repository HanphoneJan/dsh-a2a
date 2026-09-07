# dsh-a2a 设计文档 v1.0（多实例重构稿）

状态:已实现（2026-09-06 随 v1.0 交付）。v1.0 按用户新业务需求重构:从"单入站 server + 单出站 client"升级为"多入站 server + 多出站 server",每个 server 实例绑定一个 DeepSeek Harness agent preset,全部配置与开关 GUI 可操作,协议面对齐官方 A2A v1.0.1(以 a2aproject/A2A 规范仓库为权威)。

> **2026-09-06 方案修订(与用户讨论后确定,先定方案再实现)**:三点语义在此定稿——
> 1. **preset 选项完全对齐应用内**:下拉只列 roster 的真实预设(id/name/描述,显示 `name`),无"默认"占位项;每个 server 实例**总绑定一个具体 preset**,初始值为部署默认(`agentPresets.defaultId`,web profile = `standard`)。
> 2. **preset 确定 → 技能确定(一切皆插件)**:技能宣告**纯自动**,从该 preset 的技能目录派生——`agentPresets.standingKeyFor(preset)` 取得该 preset standing mount 的 scope key,再 `ctx.skills.list({ scope })` 取模型可调(`invocation.modelInvocable`)条目,填入 AgentCard;创建者不再手写宣告文字。远端用 `metadata.skill` 指定技能,任务进该 preset 会话执行,模型经会话内的 `tool-skill` 装载并运行该技能(闭环)。
> 3. **需求 6 的"创建者输入,默认取 preset 名"按以上 2 修订**:技能来源是 preset 组合,不是自由文本;原先的实现("宣告即声明"手写列表 + `defaultSkillFor` 兜底)已删除。

> **2026-09-07 GUI 打磨与鉴权填入方案(与用户讨论,待实施)**：对标 ryubyte/dsh-a2a 的成熟 GUI 并**超越之**,两项方案在此定稿——
> 1. **GUI 全面打磨**(§9 重写):Tab 分区信息架构、完整 `--dsw-alias-*` 样式系统(独立 `dashboard.css.ts` 模块,含状态点/hover-focus/`@container` 响应式/空态/徽章)、出站"导入→预览→连接"两阶段流程、每区块空态引导。功能面(多实例 CRUD/preset/派生技能)本就超越 ryubyte,本轮让观感与交互同级且更强。
> 2. **鉴权填入优化(无模式切换,§10.1 修订)**:GUI 表单就是**一个"Bearer Token(可选)"输入框**(空=匿名),不设"变量名/直接填"模式切换。填写保存时插件自动生成变量名(`A2A_INBOUND_<id>` / `A2A_OUTBOUND_<id>`),经 harness `ctx.credentials.set(credentialRef(name), value)` 写入用户层 `.env`/凭据存储(0o700 管理);实例记录只存该变量名。运行时统一 `ctx.credentials.resolve(name)` **分层读取**(进程环境 → 凭据存储 → `.env`),因此既支持 GUI 直填,也兼容外部 export 同名变量;token 明文绝不进 a2a 域/AgentCard,GUI 不回显 token 值(优于 ryubyte 的明文落 `a2a.json`)。

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
- `preset`: **必填**的 agent preset id(如 `standard`/`ptc`);创建时未选 = 部署默认(`agentPresets.defaultId`)。该实例的入站任务会话全部按此 preset 组装
- `authTokenEnv`: 可选,环境变量名(每实例独立鉴权;也可经 GUI 直接填 token,由插件写入凭据层,§10.1)
- `skills`: **派生视图(§5),不落库**——由 `preset` 实时派生,创建者不输入
- `enabled`: 开关

> GUI 预设下拉只列 roster 真实预设(id/name/描述),默认选中部署默认,无"默认"占位项(与应用内 select 完全一致;见 §9)。

### 3.2 路由

webServer 上每实例注册:
- `GET /.well-known/agent-card.json`(默认实例)或 `/a2a/<id>/agent-card.json`(命名实例)
- `POST /a2a/<id>`(JSON-RPC / SSE)

AgentCard 的 `supportedInterfaces[].url` 指向实例自己端点,`protocolBinding: "JSONRPC"`, `protocolVersion: "1.0"`。

### 3.3 入站任务 → preset 会话 → 技能执行

实例创建时把 `preset` 传入会话池:入站任务 `SendMessage` → 该实例的会话按 `agentPresets.resolve(preset) + mount(agentCtx, preset)` 组装(机制同 `ContextSessionPool`,预设来自实例配置)。不同入站 server 各自拥有不同的工作模式(如一个 `standard`、一个 `ptc`)。

技能的**宣告**与**执行**同源:宣告列表由该 preset 的 standing scope 技能目录派生(§5);远端任务带 `metadata.skill` 进入后,由该 preset 会话执行,模型经会话内的 `tool-skill`(目录/装载工具)装载并运行该技能——宣告集合 ⊂ 会话可用技能,闭环一致。

### 3.4 实例生命周期

GUI 可:创建(选 preset/设鉴权 env)、启用/停用、删除、编辑。删除会 dispose 该实例的全部 effect 与环境。技能列表随 preset 派生,创建/编辑时无需手工输入。

---

## 4. 多出站 server

### 4.1 实例定义

每个出站 server 连接实例:

- `id`: 稳定标识(`a2a-out-<uuid>` 或用户命名)
- `name`: 展示名(工具命名空间)
- `agentCardUrl`: 远端 AgentCard 地址
- `bearerTokenEnv`: 可选,环境变量名(或经 GUI 直接填 token,由插件写入凭据层,§10.1)
- `preset`: **必填**,本端在与该远端交互时按该 preset 组装(调用远端时本地维护的会话);创建时未选 = 部署默认
- `enabled` / `timeoutMs`

> **出站 preset 语义(已确认)**:需求 4 按用户确认的 (b) 解读——出站 server 的 preset 决定"与这个远端对话时本 DSH 维护的本地会话组装"。出站不宣告 AgentCard(无入站端点),preset 的技能目录仅作信息展示。

### 4.2 出站技能 → 工具

每连接每技能注册为模型工具 `a2a__<name>__<skill>`(规范名,冲突哈希)。

---

## 5. 技能宣告(从 preset 技能目录派生)

### 5.1 语义(2026-09-06 与用户讨论后定稿)

**preset 确定 → 技能确定;一切皆插件。** harness 中技能是真实机制:`ctx.skills`(`@deepseek-ai/dsh-skill`)是按 scope 分层的技能注册表,插件(提供者,如 preset 内的 `skill-filesystem`)往所在 scope 的层注册技能条目;`tool-skill` 是技能的目录/装载工具(模型经它看到、装载技能)。技能条目含 `name`(kebab-case 技能 id)、`description`(必填)、`whenToUse?`、`invocation.modelInvocable`。

### 5.2 派生机制(纯自动,取代手写宣告)

每个入站实例的技能列表 = 该 preset 的真实可用技能:

1. `agentPresets.standingKeyFor(preset)` → 该 preset standing mount 的 scope key(不启动 agent、不占会话;`dsh-agent-presets` 为这种"无 agent 读取"场景专门提供);
2. `ctx.skills.list({ scope })` → 该 preset agent 可见的完整技能目录(**preset 层贡献 + 部署全局层**——全局技能该 agent 确实能调,宣告"这台 server 实际能做的"正是这份清单);
3. 过滤 `invocation.modelInvocable === false`(远端调用是模型面),映射为 `AgentSkill[]`:`id = name`、`name = name`、`description = description`(可拼 `whenToUse`)。

- **不落库**:技能实时派生(standing mount 保证确定),preset 或技能目录变化后重启/编辑即刷新;
- **兜底**:`agentPresets`/`skills` 服务或 standing mount 不可用时(最小组合/单测),宣告内置 `chat` 技能("Conversational assistance over a DSH agent session")以保持可启动、可端到端验证;
- **与执行闭环**:宣告集合 ⊂ 该 preset 会话可用技能;远端 `metadata.skill` → preset 会话执行 → 模型经 `tool-skill` 装载运行(§3.3)。

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

浏览器端注册 **A2A 连接** 设置页(React,`src/client/`)。对标 ryubyte/dsh-a2a 的成熟面板并超越之(功能面本就更广:多入站/多出站 CRUD、preset 选择、派生技能、鉴权 env;本轮让观感与交互同级):

### 9.1 信息架构(Tab 分区)

- 页首 **intro** 一行引导文案 + 错误/通知条;
- **Tab 分区**(下划线样式,与应用内设置页一致):
  - **入站 Servers** — 实例列表(名称/端点/preset 徽章/派生技能 chips/状态点/启停-编辑-删除) + 新建/编辑表单(名称/描述/版本、preset 下拉,只列真实 roster 预设、默认选中部署默认、无"默认"占位、鉴权填入);技能随 preset 派生展示(不可手输);
  - **出站 Servers** — 连接列表(名称/远端 URL/状态点/技能数/工具数/最近活动/启停-刷新-删除-编辑) + **两阶段添加**(§9.3);
  - **连接与任务** — 入站对端表(来源/地址/首次连接/最近活动/任务/流/操作) + 任务表(按实例过滤/取消);
- 每区标题带**计数徽章**;页尾 **footer**:快照时间 + 每 3 秒自动刷新。

### 9.2 样式系统(独立模块)

- 新增 **`src/client/dashboard.css.ts`**(独立样式模块,idempotent `<style>` 注入,类名 `a2a-` 前缀防碰撞);
- 全面使用 `--dsw-alias-*` 设计 token:label-primary/secondary/tertiary、bg-layer-2、border-l2/l3、state-success/warn/error、button-primary、interactive-bg-hover、brand-primary;另用 `--ds-font-family-code`(mono);
- **状态点**(8px 圆点:connected 绿 / disconnected 灰 / reconnecting 橙 / disabled 橙)代替纯文字徽章;
- 按钮 hover/focus-visible/disabled + transition;输入框/下拉/文本域统一样式;空态与 hint 容器;`@container`(inline-size)**按设置抽屉宽度响应式**(非浏览器视口);
- 移除既有 inline `style` 属性与内联样式字符串。

### 9.3 出站两阶段添加(超越 ryubyte 的同类流程)

1. 输入远端 AgentCard URL(+ 可选 Bearer Token)→「导入」;
2. 预览卡片:名称/版本/状态点/描述/技能列表/端点(hook `discover` 仅读卡片不改状态);
3. 「连接」确认建立(`add`)或「取消」。

### 9.4 鉴权填入(§10.1)

- 入站创建/编辑与出站添加表单提供**一个**「Bearer Token(可选)」password 输入框(空 = 匿名/清除),**无"变量名/直接填"模式切换**;
- 填写保存 → 插件自动生成变量名(`A2A_INBOUND_<id>` / `A2A_OUTBOUND_<id>`),调用 `ctx.credentials.set(ref, value)` 写入用户层 `.env`/凭据存储;实例记录只存该变量名;
- 清空保存 → `ctx.credentials.unset(ref)` 并移除记录变量名(恢复匿名);
- 编辑时**不回显 token 值**,仅显示"已配置鉴权 (Bearer) / 未配置"。

所有写操作经 loopback-only `/a2a/api`。

---

## 10. 安全性

### 10.1 token 存储与读取(直接填,层级兼容)

- **GUI 直接填 Bearer Token**(唯一交互):填写保存 → 插件自动生成变量名(`A2A_INBOUND_<id>` / `A2A_OUTBOUND_<id>`),调用 harness `ctx.credentials.set(credentialRef(name), value)` 写入用户层 `.env`/凭据存储(目录 0o700 管理);实例记录只存该变量名;
- **运行时统一 `ctx.credentials.resolve(name)` 分层读取**(每操作重解析):进程环境(外部 `export` 同名变量)→ 凭据存储 → `.env` 回退;故外部部署仍可用旧式"预置环境变量 + 记录变量名"方式,与 GUI 直填并存;
- **硬约束(优于 ryubyte 的明文落 `a2a.json`)**:token 明文只存在于凭据服务管理的层,**绝不写入 `a2a` 域表/插件配置/AgentCard**;记录与卡片始终只有变量名;GUI 不反向回显 token 值。

### 10.2 其余

- `/a2a/api` 仅回环
- 每入站实例独立鉴权
- AgentCard 只声明安全方案(bearer scheme),不暴露 token 值

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

- 单测:多实例路由隔离、preset 绑定、**技能目录派生(standing scope + modelInvocable 过滤 + chat 兜底)**、出站连接 × preset、API 多实例、协议序列化(`TASK_STATE_*`)
- 组合:多个入站 server 实例互不干扰、GUI 建删启停、预设下拉默认选中部署默认
- 协议互操作:用官方 SDK/examples 交叉核对(设计期已审计,测试补覆盖)

---

## 14. P1 / 明确不做

- push notifications 的 webhook 投递(方法面已声明/返回不支持)
- OAuth 2.0 / gRPC 绑定 / REST 绑定
- 官方 conformance 套件(以 spec 审计 + 交叉测试替代)

---

## 15. 评审确认点(已确认)

1. 出站 preset 语义 = b) 与远端对话时本端会话按该 preset 组装 —— **已确认**
2. 预设下拉 = 只列 roster 真实预设,默认选中部署默认,无"默认"占位;每实例总绑定具体 preset —— **已确认(2026-09-06)**
3. 技能宣告 = preset 技能目录纯自动派生(standingKeyFor + `ctx.skills.list`,过滤 `modelInvocable`),创建者不手写 —— **已确认(2026-09-06,B' 方案)**
4. 旧版本完全删除,不迁移 —— **已确认**
5. 协议权威 = `.research/A2A`(官方 1.0.1) —— **已确认**(方法名/枚举/结构已按此对齐)
6. GUI 打磨方案(§9:Tab 分区、样式系统、两阶段连接、状态点、空态/引导;目标超越 ryubyte/dsh-a2a) —— **方案已定(2026-09-07,待实施)**
7. 鉴权填入优化(§10.1:直接填 Bearer Token 经 `ctx.credentials.set` 写入 .env,记录仅存变量名、token 不落域明文) —— **方案已定(2026-09-07,待实施)**