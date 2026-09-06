# dsh-a2a 设计文档 v0.2(讨论稿)

状态:待评审。v0.2 按剃刀法则裁剪:删除 P2 路线图;事件域从 5 个减到 1 个;派生模式、配额、异步收割、设置面板等无当前消费方的功能移除或降级。裁剪记录与理由见文末 §14。

## 1. 定位与目标

一句话:**把 DSH 变成 A2A 的一等公民——入站任务持久可审计、执行可插拔、能力由你发布;出站可消费多个远程 Agent;协议完整到可与任意第三方 A2A 实现互操作。**

三条支柱:

1. **规范完整性(入场券)**:A2A v1.0 双端核心方法;持久化任务、服务端生成任务 ID、`A2A-Version` 协商;P1 补齐 push notifications;conformance 清单。
2. **DSH 原生治理(差异化)**:入站任务经 `a2a/inbound-task` 策略挂钩(门禁/审计/审批);AgentCard 从真实工具注册表派生;执行器内部可插拔(会话/子代理)。
3. **零配置起步(社区友好)**:内置 `chat` 技能开箱即用;token 走环境变量;`/a2a` 命令运维;不依赖 UI 渠道即可用。

与 ryubyte/dsh-a2a 的差异对照(P0 事实,每项均有其源码证据):

| 维度 | ryubyte/dsh-a2a | 本设计 |
|---|---|---|
| 入站 skills | `a2a.json` 手写静态列表 | 从 `ctx.tools` 按 explicit 清单派生,内置 chat 技能 |
| 入站执行 | 每 contextId 一个串行会话,只回最终文本 | 会话 / 子代理(工具过程流式回传)两种执行器 |
| 任务存储 | 内存,重启即失 | SQLite(经 `ctx.storage` 域),可 resume、可审计 |
| 人工回合 | 无 | `INPUT_REQUIRED` ⟷ 审批/ask-user(P1) |
| 鉴权 | 共享 Bearer 明文落盘 | 环境变量引用,不落配置明文 |
| 出站 | 单 AgentCard,同步等结果 | 多 AgentCard 注册表;同步+超时(P1 被动结果注入) |
| 扩展性 | 单体插件 | `a2a/inbound-task` 事件 + 内部执行器接口 |

## 2. 架构总览

```
┌─ Client(outbound) ───────────────────────────────────┐
│ registry(多 AgentCard) → tools(a2a__<name>__<skill>)  │
│   P0: 同步调用 + timeoutMs                             │
│   P1: 发送后被动结果注入(不阻塞对话)                    │
└───────────────┬──────────────────────────────────────┘
                │  ctx.a2a(A2AService)
                │  a2a/inbound-task(waterfall,唯一事件)
┌───────────────┴──────────────────────────────────────┐
│ Server(inbound)                                      │
│ AgentCard ◀── card.ts 从 ctx.tools 派生(explicit)     │
│ JSON-RPC/SSE ◀── routes.ts / jsonrpc.ts               │
│ TaskStore ◀── store.ts(SQLite, 经 ctx.storage)        │
│ executors: session | subagent(内部接口)                │
│ 门禁/审计 ◀── a2a/inbound-task                         │
└──────────────────────────────────────────────────────┘
```

依赖的公开服务(均已核实存在):

| ctx 键 | 所属包 | 用途 |
|---|---|---|
| `ctx.tools` | `@deepseek-ai/dsh-tools` | 派生入站 skills;注册出站工具 |
| `ctx.webServer` | `@deepseek-ai/dsh-host-webserver` | 挂载 AgentCard / JSON-RPC / SSE 路由 |
| `ctx.storage` + `ctx.storageDomain` | `@deepseek-ai/dsh-storage` 组 | 任务与映射持久化(SQLite backend) |
| `ctx.subagents` | `@deepseek-ai/dsh-subagent` | subagent executor(P0) |
| `ctx.agents` | `@deepseek-ai/dsh-agent` | 会话创建/resume(session executor) |
| `ctx.commands` | 人工命令 | `/a2a` 命令面 |
| `ctx.approval` / `ctx.userQuestions` | `@deepseek-ai/dsh-user-approval` / `tool-ask-user` | 入站审批(P1) |

## 3. 服务契约 `ctx.a2a`

通过 `declare module '@deepseek-ai/cordis'` 声明,单服务按职责分区。仅保留有当前消费者的方法。

```ts
export interface A2AService {
  // ── 状态与 server 控制 ──────────────────────────────────
  status(): A2aStatus                       // server 开关、AgentCard URL、执行器种类、任务数
  enableServer(enable: boolean): Promise<Result>
  updateCard(patch: CardPatch): Promise<Result>   // 身份与 skills 清单更新

  // ── 入站任务(观测/控制,服务 /a2a 命令与 P1 面板)─────────
  getTask(taskId: string): Promise<TaskView | undefined>
  listTasks(filter?: TaskFilter): Promise<TaskView[]>
  cancelTask(taskId: string): Promise<Result>     // 中止执行器信号 + 置 canceled

  // ── 出站注册表(服务工具层与 /a2a 命令)───────────────────
  agents(): OutboundAgentView[]
  addAgent(spec: OutboundAgentSpec): Promise<Result<{ id: string }>>
  removeAgent(id: string): Promise<Result>
  setAgentEnabled(id: string, enabled: boolean): Promise<Result>
  refreshAgentCard(id: string): Promise<Result>   // 重拉卡片并重注册工具
}
```

明确不做(出现真实消费者再引入):`registerExecutor` 公开注册、`callAgent` 编程式出站。

## 4. 事件域

P0 只定义**一个**事件;其余作为延期扩展点,等真实消费者出现再引入(不为猜测建插座)。

### a2a/inbound-task(waterfall)

入站任务执行前广播,策略在场。载荷 `decision: InboundTaskDecision`(可变):`taskId / contextId / skill / parts / executor / state`。监听器可改写(如改绑执行器、标注 `requiresApproval`),或短路 `reject(reason)` 拒绝。

内置消费者(给该事件一个真实用途):
- **技能门禁**:skills 清单之外的 skill 拒绝;
- **审计**:每次决策追加一行日志(含 `remotePeerId` 与策略快照),配合 SQLite 任务记录形成审计面。

示例(第三方挂审批策略,或 P1 内置交互集成):

```ts
ctx.on('a2a/inbound-task', (decision, next) => {
  if (decision.skill === 'coding') decision.requiresApproval = true
  next(decision)
})
```

waterfall 语义遵循 [Cordis primer](../../docs/cordis-primer.md):监听器必须 `next()` 让渡,短路即定案。

### 延期扩展点(明确不做,等消费者)

`a2a/inbound-card`(卡片编程改写)、`a2a/task-settled`(push 投递/面板实时刷新需要时)、`a2a/outbound-call` / `a2a/outbound-settled`(出站配额/遥测需要时)。

## 5. 数据模型

### 5.1 TaskRecord(SQLite,`storage` 域 `a2a`)

```ts
export interface TaskRecord {
  taskId: string            // 服务端生成:a2a-<ts>-<rand>(v1.0:客户端不得发明任务 ID)
  contextId: string         // 入站:远端提供;出站:本地会话键
  skill: string
  state: TaskState          // submitted|working|input-required|completed|failed|canceled|rejected
  createdAt: string; updatedAt: string
  sessionId: string | null  // 执行的 DSH 会话(subagent 执行器为隔离工作区会话)
  remotePeerId: string | null  // 入站:请求来源身份(哈希),审计用
  parts: Part[]             // 最新输入
  artifacts: Artifact[]     // 持久化产物(subagent 过程流式追加)
  executor: 'session' | 'subagent'  // 执行时快照
  summary: string | null
  error?: { code: string; message: string }
}
```

存储:复用 `ctx.storage` + `ctx.storageDomain`,backend 固定 `storage-sqlite`。`contextId → sessionId` 随记录持久化,重启后按需 resume 会话(dsh-session 本身落盘,resume = 重开会话记录,一行实现细节,不是独立功能)。

### 5.2 出站注册表(同库,`agents` 表)

```ts
interface OutboundAgentRecord {
  id: string
  name: string              // 工具前缀 a2a__<name>__<skill>
  agentCardUrl: string
  bearerTokenEnv?: string   // 环境变量名,不落明文
  enabled: boolean
  timeoutMs: number
  lastCardAt: string | null // 卡片缓存时间
}
```

## 6. 动态 AgentCard 派生(card.ts)

输入:`ctx.tools` 注册的工具定义 + 配置 `server.skills`;输出最终卡片。

规则:**只支持 explicit 清单**——`ids`(具体工具 id/技能 id)+ `exclude`(再减)。派生时机:启动、`enableServer`、`/a2a` 手动刷新;不自监听工具注册事件(增量重派生留到有消费者时)。

P0 默认:**内置一个 `chat` 技能**(session 执行器,可对话)。它同时是端到端冒烟测试——新用户装完即可验证"AgentCard → JSON-RPC → 会话 → 回复"全链路,再按清单暴露真实工具。危险工具默认不暴露,暴露即显式配置。

## 7. 执行器(内部接口,不对外注册)

```ts
export interface A2aExecutor {
  execute(
    task: TaskRecord,
    opts: { signal: AbortSignal; onEvent: (e: A2aExecutorEvent) => void },
  ): Promise<{ parts: Part[] }>
}

export type A2aExecutorEvent =
  | { type: 'status'; state: TaskState; message?: string }
  | { type: 'artifact'; artifactId: string; parts: Part[]; name?: string; lastChunk?: boolean }
```

服务端层把事件映射为 TaskStore 更新与 SSE 帧;`CancelTask` 触发 `signal.abort()`。

内置实现(仅这两个,无关第三方):

- **session executor**:每 `contextId` 一个 DSH 会话,同对话串行,`whenIdle()` 取回复。chat 技能与最小 profile 的兜底。
- **subagent executor**(差异化核心):每任务 → `ctx.subagents` 委托子代理(默认 provider `in-process`),按技能绑定工具策略;把**工具调用过程**转成 `artifact` 事件流式回传;结果 = 最终消息 + 步骤列表 artifact;子代理工作区用隔离 cwd。

技能 ↔ 执行器绑定:配置 `server.executors: { <skillId>: 'session' | 'subagent' }`,缺省 `session`。

## 8. 关键流程(时序)

### 8.1 入站任务

```
POST /a2a(SendMessage)
  → jsonrpc 校验(A2A-Version、鉴权头)
  → 生成 taskId;构造 TaskRecord(submitted)
  → a2a/inbound-task(waterfall)
       ├─ 短路 reject → task 置 rejected,返回错误
       └─ 门禁通过 → 选执行器(按 skill 绑定)
  → 执行器执行:subagent 流式 onEvent → artifact 更新 → SSE 帧
  → 终态 → TaskStore 落盘
  → (P1) push notification webhook;(P1) requiresApproval → input-required → 审批流
```

### 8.2 出站工具调用(P0)

工具 `a2a__<name>__<skill>` 执行 `SendMessage`(带 `contextId`),流式/轮询到终态,返回文本;`timeoutMs` 兜底。P1 改为发送后立即返回,结果经会话注入被动送达(参考 dpskh 的被动回复模式,免 `ctx.jobs`)。

### 8.3 AgentCard 派生

启动 / enable / `/a2a` 手动刷新时:读 `ctx.tools` → 按 `ids`/`exclude` 过滤 → 附加 `chat` 技能 → 发布。

## 9. 配置(schemastery schema 草案)

```yaml
- id: a2a
  name: '@<scope>/dsh-a2a'
  config:
    server:
      enabled: false            # 入站开关,默认关
      name: My DSH Agent
      description: A DSH agent over A2A v1.0
      version: 0.1.0
      baseUrl: null             # null = 按 webServer 监听地址自动推导
      endpointPath: /a2a
      authTokenEnv: null        # 环境变量名,不写明文
      skills:
        ids: []                 # 暴露的工具 id/技能 id(显式)
        exclude: []
      executors: { chat: session }   # skillId → session|subagent
    client:
      agents: []                # name/agentCardUrl/bearerTokenEnv/enabled/timeoutMs
      toolPrefix: a2a
```

部署差异项全部走 Config;协议常量保持固定。

## 10. 安全模型

- **入站**:可选共享 Bearer(值从环境变量读,`!!js process.env.A2A_INBOUND_TOKEN`);`remotePeerId` 记录来源供审计;skills 默认不暴露真实工具(open question 已定:chat 技能可、工具显式)。
- **出站**:每 Agent 独立 token(环境变量引用)。
- **执行边界**:subagent 执行器使用隔离 cwd;沙箱策略继承 DSH `ctx.sandbox` 能力。
- **管理面**:`/a2a` 命令走本机;P1 面板沿用 loopback/same-origin 信任边界,不承载机密。
- **明确不做**:OAuth 2.0、每客户端凭据(作为文档化限制,而非路线图)。

## 11. 目录结构

```
dsh-a2a/
  package.json          # name, dsh.bundle.patch → cordis.patch.yml
  cordis.patch.yml      # 插件行(默认关闭,opt-in)
  src/
    index.ts            # apply(ctx, config):按 mode 组装
    service.ts          # A2AService 实现 + declare module
    events.ts           # a2a/inbound-task 事件声明
    protocol.ts         # A2A v1.0 类型(对齐 a2a.proto)+ JSON-RPC 方法常量
    server/{routes,jsonrpc,executor,store,card}.ts
    server/exec/{session,subagent}.ts
    client/{registry,tools,calls}.ts
    commands.ts         # /a2a 命令(status/enable/refresh/list/cancel/agents)
  tests/{unit,composition}/
  docs/design.md        # 本文档
```

P1 追加:`server/dashboard.ts`(快照+`/a2a/api`)、`client-ui/`(设置面板,`dsh.client` 清单)。

## 12. 测试策略

1. **单元**:protocol 编解码、任务状态机、派生过滤、registry 状态机。
2. **组合(REAL)**:boot 测试用 `cordis.yml`(Loader + webServer + storage-sqlite + subagent in-process),断言:SendMessage 到终态、cancel 中止执行器、inbound-task 门禁拒绝、显式技能暴露、重启后任务可 resume。遵循仓库"产品可见插件必须有非单元组合测试"。
3. **互操作(P1)**:与官方 A2A JS/Python SDK 双向握手;conformance 清单:任务 ID 服务端生成、流关闭判定、`A2A-Version` 回显。

## 13. P0 / P1 / 明确不做

**P0**
- Server:动态 AgentCard(explicit + 内置 chat)、JSON-RPC + SSE(核心方法)、SQLite TaskStore、session + subagent 执行器、`a2a/inbound-task` 门禁+审计
- Client:多 AgentCard 注册表、skills→tools 映射、contextId 绑定、同步调用 + 超时
- 运维:`/a2a` 命令;token 环境变量化
- 测试:单元 + 组合

**P1(有真实理由,非 P0 必需)**
- push notifications(`tasks/pushNotificationConfig` + webhook 投递,规范入场券)
- `INPUT_REQUIRED` ⟷ 审批/ask-user(治理核心,需 interaction 集成)
- 出站被动结果注入(替代同步轮询,免 ctx.jobs)
- 设置面板 + `/a2a/api`(client-plugin 渠道,依赖最重故后置)
- 互操作测试

**明确不做(文档化限制,防止未来误入)**
OAuth 2.0、gRPC 绑定、多 server 路由、配额/成本控制、workflow 执行器、`prefix`/`all` 派生模式、事件域补全(inbound-card / task-settled / outbound-*)。

## 14. 定稿决定(已确认)

1. **协议层**:直接实现 JSON-RPC/SSE,不依赖官方 A2A JS SDK(conformance 控制权自持)。
2. **发布渠道**:npm 发布 + `dsh plugin add`;包名 `@hanphone/dsh-a2a`。
3. **双端**:P0 同时包含入站服务端与出站客户端,不做单端收缩。
4. **开发环境**:`dsh-a2a/` 与 `.research/`(竞品克隆)均保留在 harness checkout 内,作为本地开发环境。
5. **装完即用 + GUI 管理(2026-09-06 修订)**:`dsh plugin add` 后两端**默认启用**
   (bundle patch 不再 `enabled: false`),浏览器端注册 **A2A 连接** 设置页
   (`settings.section`),经回环专属 `/a2a/api` 完成入站开关、出站 agent
   增删启停刷新、任务查看/取消;改 `cordis.patch.yml` 只作为保留方式。

## 16. 开发环境接线(2026-09-06 定稿)

沿用 §14.4 的"独立于 workspace"，且本插件与 checkout 已是**平级目录**（接线
按 `../deepseek-harness/*` 重指），但明确**独立性**:`dsh-a2a` **不加入**
`pnpm-workspace.yaml`,不共享 harness 依赖管理(后续会移出 checkout)。接线方式:

- 自带嵌套 `pnpm-workspace.yaml`(`packages: ["."]`)+ 独立 package.json;
  `@deepseek-ai/*` 为 peerDependencies(宿主组合运行时提供),`zod` 是唯一自有依赖。
- 类型检查采用仓库标准产物面:`tsconfig.json` extends
  `../deepseek-harness/tsconfig.base.json`(平级重指),
  对四个被 import 的项目(`vendor/cordis`、`vendor/schemastery`、
  `packages/interaction/commands`、`packages/storage/storage-domain`)加
  `references`,`typecheck` = `tsc -b`(消费已构建的 `lib/types` 声明)。
- store 层对齐真实 `@deepseek-ai/dsh-storage-domain` 契约
  (`DomainFacility` / `Domain` / `KvTable`,`domainTable` 单参数、写入用 `put`)。
- 本地开发胶水(沙箱 pnpm store 只读时):`node_modules/{zod,@types/node,
  vitest,tsdown,typescript}` 符号链接进平级 checkout `.pnpm` store;vitest 经
  tsconfig paths 门面(extends 链)解析 `@deepseek-ai/*`。插件自行安装依赖后可移除。
- 验收补强(2026-09-06):出站 `config.client.agents` 由注册表 `seed()` 消费,
  出站在入站路由注册后初始化(回环可取本 server 卡),`DomainTaskStore` 自持
  写链可见的活跃视图。测试 58 → 65。
- 浏览器端(2026-09-06):`src/client/` 为 browser half(React,`settings.section`
  dashboard,数据走回环 `/a2a/api`);host 出站代码移至 `src/outbound/`。
  双程序:host `tsconfig.json`(node)+ client `tsconfig.client.json`
  (DOM/JSX,references 到 checkout client 包成品声明,emit 到 `lib/types/client`);
  tsdown 双入口产 `lib/index.js`(ESM)与 `lib/client.cjs` →
  `scripts/build-client.mjs` 包装为 `window.__ModuleLoader__.load` 的
  `lib/client.js`;`exports["./client"]` + `dsh.client` 声明注册浏览器面。
- 启用方式与示例见 [README](../README.md)。

详见 Agent Note:
`.agents/notes/implemented/architecture/2026-09-06-a2a-plugin-independent-development-wiring.md`。

## 15. v0.2 裁剪记录(剃刀法则)

| v0.1 功能 | 决定 | 理由 |
|---|---|---|
| public `registerExecutor` / `callAgent` | 移除 | 无当前消费方,开放插槽是猜测 |
| `a2a/outbound-*`、`a2a/task-settled`、`a2a/inbound-card` | 移除 | 对应消费者(配额/面板/push)均非 P0;不为猜测建插座 |
| workflow 执行器 | 移除 | 投机式泛化,无人要 |
| 派生模式 `prefix`/`all`、增量自监听重派生 | 移除 | 危险或猜测;手动刷新足够 |
| `mapSkills` 兜底工具、`parentTaskId` | 移除 | 复制冗余/无消费者 |
| 配额/预算(入站+出站) | 移除 | 社区用户无此场景,定位句中的伪需求 |
| OAuth 2.0、gRPC、多 server 路由 | 降为"明确不做" | 企业向幻想,不做路线图承诺 |
| storage-json 兜底 | 移除 | 部署懒惰;固定 SQLite |
| 设置面板 + `/a2a/api` | P0→P1 | client-plugin 渠道最重最不稳;命令即可运维 |
| 出站异步收割(`ctx.jobs`) | 改为 P1 被动结果注入 | 更简单、DSH 原生,免 jobs 依赖 |
| 事件域 5 个 | 减到 1 个 | inbound-task 有内置消费者(门禁+审计),其余无 |
| 定位句"可配额" | 删除 | 无此功能,不留此承诺 |