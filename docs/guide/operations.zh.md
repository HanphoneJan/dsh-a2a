---
name: 运维指南
description: GUI 与 /a2a 命令参考、生命周期语义、配置、宿主服务、存储与对外暴露
create-time: 2026-10-19
update-time: 2026-10-24
version: v0.5.0
relative-docs:
  - docs/guide/concepts.zh.md
  - docs/reference/http-api.zh.md
  - docs/harness-compatibility.zh.md
---

# 运维指南

[English](operations.md) · **中文**

本页是日常参考：控件在哪、每个字段做什么、实例跨重启怎么表现、存储与安全怎么配。
内容对应 `0.5.0` / DeepSeek Harness `0.2.1-rc.2`。

## 1. 控制面

驱动插件有三种等价方式：

| 控制面 | 用途 |
|---|---|
| **设置 → A2A 连接** | 主 UI：创建/编辑/启停/删除，查看对端、会话、任务 |
| **`/a2a` 命令** | DSH 聊天会话里的文字备用路线 |
| **仅回环 `/a2a/api`** | 脚本、测试、集成；见 [HTTP API](../reference/http-api.zh.md) |

三者调用同一个 facade，所以状态不会互相矛盾。面板每 3 秒自动刷新。

## 2. 面板

### 2.1 版本与更新

页签上方的版本条显示当前 `dsh-a2a` 版本与 Node 运行环境。点「检查更新」会同时
查询 npm registry 与插件 `package.json` 中 GitHub 仓库的最新版本，取较高者，并
如实报告：已是最新 / 有新版本 / 暂时查不到（查询失败绝不会显示成已是最新）。
结果缓存 6 小时；按钮会强制刷新。有新版本时给出两步更新命令（先 `remove` 再
`add`）和复制按钮。检查是只读的——不安装、不重启、不改 profile。

入站卡片同时显示该实例在 AgentCard 中宣告的版本；出站卡片在连接后显示远端
AgentCard 的版本。

### 2.2 入站 Servers

每张卡片显示名称、端点路径、preset 徽章、鉴权状态、派生技能 chips，以及实时 AgentCard URL。操作：

| 操作 | 效果 |
|---|---|
| **启用 / 停用** | 注册或注销卡片与端点路由；记录与会话池保留 |
| **编辑** | 改名称/描述/版本/preset/token；重建卡片/技能并换装活实例 |
| **删除** | dispose 活实例并删除持久化记录 |
| **清除鉴权** | 删除已存 Bearer Token，以匿名实例重建 |

创建/编辑表单有名称、版本、preset、Bearer Token、描述。技能创建后显示，不需要手填。
preset 选择器只列真实 roster 预设，并预选部署默认。

### 2.3 出站 Servers

添加是两阶段流程：

1. 填远端 AgentCard URL（和可选 token），点 **导入**。
2. 核对读到的名称/版本/描述/端点/技能，调整本地名称、preset、超时，点 **连接**。

已连接卡片显示状态点、导入技能数、工具数，失败时显示 `lastError`。操作：
**启用/停用**、**刷新**（重读卡片并重注册工具）、**编辑**（名称/preset/超时/token）、**删除**。

Token 通过凭据服务单独存储；编辑时 token 留空会保留原值。入站表单有**清除鉴权**；
出站没有清除按钮：通过 `outbound.setAuth` 提交空 `token`；编辑表单里 token 留空会保留原值。

### 2.4 连接与任务

三张表：

- **入站对端**——谁在调用这个 DSH：来源身份、任务数/活跃数、流式指示、首次/最近时间、**关闭**。
- **入站会话**——每个 `contextId` 一行：实例、preset、运行中/空闲、任务/活跃数、流式、首次/最近时间、
  **取消活跃**、**关闭**。
- **任务**——最近 20 条任务：id、技能、来源实例、状态、**取消**。

语义：

- **取消活跃**中止该上下文所有非终态任务；会话保持打开。
- **关闭**额外释放该上下文的活跃会话句柄。它是资源释放，不是会话墓碑：同一
  `contextId` 的下一个任务会重新打开新句柄。
- 对端上的**关闭**会移除该对端的 registry 记录，不删除它的任务。

## 3. `/a2a` 命令参考

命令在 DSH 聊天会话里使用。列表与状态类输出 JSON。

| 命令 | 用途 |
|---|---|
| `/a2a status` | 整插件快照 |
| `/a2a presets` | Agent preset 名单 |
| `/a2a inbound list` | 入站实例 |
| `/a2a inbound create <name> [preset] [description]` | 创建入站实例 |
| `/a2a inbound remove <id>` | 删除 |
| `/a2a inbound enable\|disable <id>` | 启停路由 |
| `/a2a outbound list` | 出站实例 |
| `/a2a outbound create <agentCardUrl> [name] [preset]` | 创建出站连接 |
| `/a2a outbound remove <id>` | 删除 |
| `/a2a outbound enable\|disable <id>` | 启停 |
| `/a2a outbound refresh <id>` | 重读远端卡片 |
| `/a2a tasks` | 任务列表 |
| `/a2a task get <taskId>` | 单条任务 |
| `/a2a task cancel <taskId>` | 取消任务 |
| `/a2a sessions` | 按上下文的会话视图 |
| `/a2a session cancel <contextId>` | 取消该上下文的活跃任务 |
| `/a2a session close <contextId>` | 释放该上下文的活会话 |
| `/a2a peers` | 入站对端注册表 |
| `/a2a help` | 用法 |

参数以空白分隔。入站描述是可选 preset 之后的剩余单词；需要更丰富的字段时用面板或 HTTP API。

## 4. 生命周期语义

- **创建**——持久化记录、派生技能、解析鉴权、组装运行时；启用时注册路由。
- **更新**——持久化 patch，重新派生技能（preset 可能变了）、重新解析鉴权，
  在保留启用状态的前提下替换活实例。
- **启用/停用**——只注册/注销路由。记录、技能、会话池保留；停用实例在启动时仍会组装，但不路由。
- **删除**——dispose 活实例并写入空 tombstone 行；重启后不会复活。
- **出站连接**——读卡片、按技能注册工具、持久化记录。连接失败返回错误并保留失败视图便于排查；
  记录在连接尝试前已保存。
- **出站刷新**——从卡片重建 registry 并重注册工具。**编辑**用新的名称/preset/超时重建连接，
  并重新应用已存 token。
- **重启**——重新组装持久化的入站/出站实例；启用的会恢复。活跃会话与流订阅不恢复。

## 5. 配置

插件配置刻意最小。实例**不**在 `cordis.patch.yml` 里配置；它们存在于 `a2a` 域，由面板管理。

```yaml
- id: a2a
  config:
    baseUrl: http://127.0.0.1:3080   # 可选；省略时从 webServer 派生
    subagentProvider: in-process     # 默认
    defaultTimeoutMs: 60000          # 默认出站超时
    inboundTimeoutMs: 600000         # 每个入站任务的执行预算；0 关闭
    requestsPerMinute: 120           # 每个入站来源的限流；0 关闭
    maxConcurrentTasks: 32           # 每个入站实例的并发上限；0 关闭
    maxBodyBytes: 1048576            # 入站 HTTP 请求体上限
    outboundRefreshMs: 300000        # AgentCard 自动刷新间隔；0 关闭
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `baseUrl` | web server 端口，其次 `DSH_A2A_PORT`，最后 `3000` | 所有入站 AgentCard 的对外 base URL |
| `subagentProvider` | `in-process` | subagent 执行器接缝的 provider 名 |
| `defaultTimeoutMs` | `60000` | 出站连接每次调用的默认超时 |
| `inboundTimeoutMs` | `600000` | 每个入站任务的执行预算；超时落 `FAILED` |
| `requestsPerMinute` | `120` | 每个入站来源的滑动窗口限流；超限返回 HTTP 429 |
| `maxConcurrentTasks` | `32` | 每个入站实例的并发任务上限 |
| `maxBodyBytes` | `1048576` | 入站 A2A 请求体上限 |
| `outboundRefreshMs` | `300000` | 启用中的出站连接自动刷新 AgentCard 的间隔 |

入站会话工作目录是 `$DSH_HOME/a2a-sessions`（启动时创建）。`DSH_HOME` 默认 `~/.dsh`。

## 6. 宿主服务

只有 `storageDomain` 是必需的。其余服务都是探测式可选；缺少某个只会让对应能力空闲，
不会让整个插件挂掉。

| 服务 | 使用方 | 缺失时的效果 |
|---|---|---|
| `storageDomain` | 两端 | 必需；插件不挂载 |
| `webServer` | 入站路由、面板 API | 入站端点/卡片与面板 API 空闲 |
| `agents` | 入站 session 执行器 | 入站任务走 `refuse` 执行器 |
| `attachments` | 入站图片/文件 part | 原始附件降级为占位文本 |
| `agentPresets` | preset 选择、技能派生 | preset 默认与派生技能退化为 `chat` |
| `skills` | 技能派生 | 卡片回退到 `chat` |
| `credentials` | token 存储/解析 | GUI 写 token 失败；外部 export 的环境变量仍可用 |
| `subagents` | subagent 执行器 | subagent 执行器不接线 |
| `tools` | 出站工具注册 | 出站连接无法注册工具 |
| `commands` | `/a2a` | 聊天命令不注册 |

基础 `web` profile 已挂载全部。自定义组合若想要完整能力，应包含
`storageDomain`、`webServer`、`agents`、`agentPresets`、`skills`、`tools`、`commands`。

## 7. 存储

`a2a` 域默认走 profile 的 JSON 后端。表与内容见[核心概念](concepts.zh.md#9-身份存储与会话)。

只把 `a2a` 域路由到 SQLite：

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

运维注意：

- **一个 `DSH_HOME` 只允许一个写者。** 两个 DSH 进程共享 home 会写同一个 JSON 域；
  不要让两个实例指向同一个存储根。
- **任务与实例持久化。** 活跃会话、流订阅、对端注册表都在内存里，重启即清空。
- **域里存的是 JSON 字符串**，格式变化由域的 `version` 字段守护。升级前备份 JSON/SQLite 文件。
- **会话日志**由 DSH 正常的 session persistence 写到 `$DSH_HOME/sessions/...`；
  插件的工作目录是 `$DSH_HOME/a2a-sessions`。

## 8. 对外暴露与安全

Token 与面板的安全模型见[核心概念：安全模型](concepts.zh.md#10-安全模型)。运维要点：

- 面板 API 在设计上**仅回环**。把 web app 放到反向代理后面，也不会让 `/a2a/api` 可远程调用。
- A2A 端点与 GUI 共用同一个 web server。如果把该 server 暴露到网络，给每个入站实例配置
  Bearer Token，并在代理层终止 TLS。插件不提供 TLS；请求/请求体/并发限制都是进程内的，不是分布式配额。
- 每个入站实例用不同 token，避免一次泄露就拿到所有已发布 agent 的访问权。
  出站 token 每次调用时解析，轮换凭据后下一次工具调用即生效，无需重启。

## 9. 升级与卸载

升级：

```sh
dsh plugin --profile web add @hanphone/dsh-a2a@latest
```

安装后重启 `dsh web`。实例与任务在域里，升级后保留；活跃会话不保留。

卸载：

```sh
dsh plugin --profile web remove @hanphone/dsh-a2a
```

卸载不会删除 `a2a` 域数据。只有确认要丢弃实例定义与任务历史时，才删除域行（或存储文件）。

## 10. 兼容性

DSH 0.1.7+ 会跑 peer 预检，范围不覆盖运行时版本就拒绝加载。预检报错时，把插件与
harness 一起升级；不要在没有跑兼容性流程的情况下擅自放宽范围。精确范围与验证流程见
[Harness 兼容性](../harness-compatibility.zh.md)。
