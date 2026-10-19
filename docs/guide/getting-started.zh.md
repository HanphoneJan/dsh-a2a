---
name: 快速开始
description: 安装 @hanphone/dsh-a2a，发布第一个入站 A2A server，用 curl 调用，并把远端 agent 接成模型工具
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.4.0
relative-docs:
  - docs/guide/concepts.zh.md
  - docs/guide/operations.zh.md
  - docs/reference/http-api.zh.md
---

# 快速开始

[English](getting-started.md) · **中文**

本页从零开始，跑通两个方向：

1. **入站**——其他 A2A 客户端把任务发给这个 DSH。
2. **出站**——这个 DSH 把远端 A2A agent 当成模型工具调用。

两个方向都在 **设置 → A2A 连接** 面板里操作。`/a2a` 聊天命令和仅回环的 HTTP API
是等价的控制面；面板是主入口。

## 1. 前置条件

- DeepSeek Harness **0.2.1-rc.2**（本版本核对的 harness），使用 `web` profile。
- 正在运行的 `dsh web`，默认地址 `http://127.0.0.1:3080/`。
- `dsh` 命令；如果从源码 checkout 运行，则是 `pnpm dsh`。

基础 `web` profile 已经挂载本插件需要的宿主服务：`storageDomain`、`webServer`、
`tools`、`agents`、`agentPresets`、`skills`、`credentials`。自定义组合如果缺少其中某个，
只会让对应的一半空闲；见[运维指南](operations.zh.md#宿主服务)。

## 2. 安装

```sh
dsh plugin --profile web add @hanphone/dsh-a2a
```

从 harness checkout 运行时：

```sh
cd deepseek-harness
pnpm dsh plugin --profile web add @hanphone/dsh-a2a
```

安装后**重启一次** web（`dsh web` 或 `pnpm dsh web`）。浏览器端插件表在 host 启动时扫描，
只刷新页面不够。

确认插件已挂载：

```text
/a2a status
```

命令会输出一个 JSON 快照，含 `inbounds` 与 `outbounds` 数组。同一快照也能从
`GET http://127.0.0.1:3080/a2a/api` 读到。

## 3. 发布第一个入站 server

打开 **设置 → A2A 连接 → 入站 Servers → 新建入站 Server**，填写：

| 字段 | 含义 |
|---|---|
| 名称 | 显示在 AgentCard 和面板里的名字 |
| 版本 | AgentCard 的版本字符串（默认 `1.0.0`） |
| Agent preset | 该入站 server 的会话由哪个 DSH preset 组装；技能从该 preset 派生 |
| Bearer Token | 可选。设置后请求必须带 `Authorization: Bearer <token>` |
| 描述 | AgentCard 描述 |

创建后面板会显示端点和 AgentCard URL：

```text
http://127.0.0.1:3080/a2a/<id>
http://127.0.0.1:3080/a2a/<id>/agent-card.json
```

技能**不需要手写**。AgentCard 宣告的是所选 preset 技能目录中模型可调用的条目。
如果组合里没有 skills 服务或 preset 挂载，则回退到内置的 `chat` 技能。

### 验证 AgentCard

```sh
curl -sS http://127.0.0.1:3080/a2a/<id>/agent-card.json
```

返回标准 A2A `AgentCard`，含 `name`、`version`、`supportedInterfaces`、`capabilities`
和 `skills`。配置了 Bearer 的 server 还会宣告 `bearer` 安全方案；token 值不会出现在卡片里。

### 发送任务

`SendMessage` 会创建任务并**阻塞到任务落定**：

```sh
curl -sS http://127.0.0.1:3080/a2a/<id> \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "SendMessage",
    "params": {
      "message": {
        "role": "ROLE_USER",
        "parts": [{ "text": "Reply with exactly OK" }],
        "metadata": { "skill": "chat" }
      }
    }
  }'
```

成功时返回的任务 `status.state` 为 `TASK_STATE_COMPLETED`，回复在 `artifacts` 里：

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "id": "a2a-...",
    "contextId": "...",
    "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "..." },
    "artifacts": [{ "artifactId": "result", "parts": [{ "text": "OK" }] }],
    "metadata": { "skill": "chat" }
  }
}
```

如果不想等，可以发 `SendStreamingMessage`（或 `SubscribeToTask`），并带
`Accept: text/event-stream`：

```sh
curl -N http://127.0.0.1:3080/a2a/<id> \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "role": "ROLE_USER",
        "parts": [{ "text": "Count to three slowly" }],
        "metadata": { "skill": "chat" }
      }
    }
  }'
```

每个 SSE 帧是一行 `data: <StreamResponse>`；最后一帧是落定的 `task`。帧的完整口径见
[HTTP API 与 A2A 协议](../reference/http-api.zh.md#a2a-端点)。

如果入站 server 配置了 token，加上：

```sh
-H 'authorization: Bearer <token>'
```

## 4. 把远端 agent 接成工具

你需要远端 agent 的 **AgentCard URL**（例如
`https://remote.example/a2a/<id>/agent-card.json`），以及远端要求时的 Bearer Token。

打开 **设置 → A2A 连接 → 出站 Servers**：

1. 填 AgentCard URL（以及 token，如有），点 **导入**。
2. 确认读到的名称、版本、描述、端点和技能列表。
3. 填本地名称、preset、超时，点 **连接**。

成功后卡片显示 `connected`、导入的技能数和注册的工具数。每个远端技能变成一个模型工具：

```text
a2a__<连接名>__<技能 id>
```

连接名 `weather`、远端技能 `chat`，工具就是 `a2a__weather__chat`。它只有一个参数：

```json
{ "prompt": "要发给远端 agent 的任务或指令" }
```

让模型调用它，例如：

```text
调用 a2a__weather__chat，prompt 为 "Reply with exactly OK"，然后原样输出结果。
```

工具会通过 A2A 调用远端 agent，返回落定任务的文本。远端任务失败会抛工具错误并带上远端消息；
`INPUT_REQUIRED` 或 `AUTH_REQUIRED` 会以文本形式返回，而不是抛错。

## 5. 检查两个方向

```text
/a2a inbound list
/a2a outbound list
/a2a tasks
/a2a sessions
```

也可以看面板的 **连接与任务** 页：入站对端、按 `contextId` 的会话、任务，以及取消/关闭操作。

## 下一步

- [核心概念](concepts.zh.md)——preset、技能、任务、上下文、执行器怎么串起来。
- [运维指南](operations.zh.md)——GUI 字段、`/a2a` 参考、配置、存储、安全。
- [HTTP API 与 A2A 协议](../reference/http-api.zh.md)——精确的请求体和协议方法。
- [排障](troubleshooting.zh.md)——空回复、401、连接失败、工具不可见。
