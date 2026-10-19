---
name: Troubleshooting
description: Diagnose empty replies, 401s, unreachable cards, failed outbound connections, missing tools, version preflight, and storage conflicts
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.3.8
relative-docs:
  - docs/guide/getting-started.md
  - docs/reference/http-api.md
  - docs/testing.md
---

# Troubleshooting

**English** · [中文](troubleshooting.zh.md)

Work in this order; each step narrows the layer:

1. **Plugin mounted?** `/a2a status` returns a snapshot.
2. **Instance exists and is enabled?** `/a2a inbound list` / `outbound list`.
3. **Card reachable?** `curl <cardUrl>`.
4. **Protocol reachable?** `SendMessage` with a tiny prompt.
5. **Task state?** `/a2a tasks`, `/a2a task get <id>`.
6. **Host logs and session logs?** DSH logs and `$DSH_HOME/sessions`.
7. **Version and compatibility?** see §7.

## 1. `(no reply)` or an empty artifact

A completed task whose artifact is `(no reply)` means the inbound session
executor finished without an assistant message. In `0.3.6` this was a known
bug: the executor sent the agent a message with
`source: { kind: 'plugin', plugin: 'a2a' }`. The JSONL v4 session codec refuses
`kind: 'plugin'`; the write failed in the session handle's background flush,
the agent loop contained the error, and the task settled `COMPLETED` with no
reply. **Fixed in 0.3.7** by using the producer-owned `{ kind: 'a2a' }`.

If you still see an empty reply on 0.3.7 or newer:

1. Confirm the installed version:
   ```sh
   node -p "require('/path/to/profile/node_modules/@hanphone/dsh-a2a/package.json').version"
   ```
   It must be `0.3.7` or newer. Reinstall and restart `dsh web` if not.
2. Check the task state and status message:
   ```text
   /a2a task get <taskId>
   ```
   `TASK_STATE_FAILED` carries an error message; `COMPLETED` with an empty
   artifact points back at the model/session layer.
3. In the panel, open **Connections and tasks → Inbound sessions**, find the
   `contextId`, and check whether the session is running or idle.
4. Check the model provider for the preset: an unauthenticated or misconfigured
   provider can produce an empty assistant message. Verify the same preset in a
   normal DSH session.
5. Look for `a2a` warnings in the DSH host log and in
   `$DSH_HOME/sessions/...` for the `a2a-<contextId>` session.

If the task is `CANCELED`, the caller or the panel canceled it; start a new
task on the same `contextId` to reopen the session.

## 2. Inbound request returns 401

The instance has a bearer token and the request does not match it.

- Send `Authorization: Bearer <token>`.
- The token is resolved per request from the credentials service, then the
  process environment. Check the managed name:
  - inbound: `A2A_INBOUND_<ID>` (uppercased, non-alphanumerics replaced by `_`);
  - outbound: `A2A_OUTBOUND_<ID>`.
- In the panel, the inbound card shows whether auth is configured. Use **Edit**
  to set a new token or **Clear auth** to remove it.
- Streaming requests are authorized before the `200`; a `401` is a clean
  status, not a broken stream.

## 3. AgentCard returns 404 or connection refused

- The instance may be **disabled**: `/a2a inbound list` and the panel show the
  enabled state. Enable it and retry.
- Use the **per-instance** card path printed by the panel
  (`/a2a/<id>/agent-card.json`). The well-known
  `/.well-known/agent-card.json` is not used for instances.
- Confirm the web server is listening on the address you are calling:
  ```sh
  curl -v http://127.0.0.1:3080/a2a/<id>/agent-card.json
  ```
- If the card URL uses a public/reverse-proxy host, confirm the proxy forwards
  the `/a2a/` prefix and preserves the `Host` header expected by the web app.

## 4. Outbound connection is `failed`

The panel shows `lastError`; the common causes are:

| Symptom | Check |
|---|---|
| `HTTP 401` | Remote requires a token; edit the connection and set it |
| `HTTP 404` | Wrong card URL; use the remote's full per-instance card path |
| `invalid agent card` | The URL returns HTML or a non-card JSON; verify content type and shape |
| `no JSON-RPC interface` | The card has no `supportedInterfaces` entry with a JSON-RPC URL |
| timeout | Raise the connection's `timeoutMs` or check network reachability |
| TLS/DNS error | Check the remote certificate/hostname and local network |

After fixing, click **Refresh** (or call `outbound.refresh`). A failed record is
kept so you can edit it; deleting and re-adding is not required.

## 5. Remote skill is missing or the model does not call the tool

- Confirm the connection is `connected` and `skillCount > 0`, `toolCount > 0`.
  A card with zero skills registers zero tools by design.
- Tool names are `a2a__<connection-name>__<skill-id>`, normalized to
  `[A-Za-z0-9_-]` and truncated to 64 characters. If the remote name has
  spaces or punctuation, inspect the actual registered name in the model's
  tool list or ask the model to list its tools.
- The tool argument is `{ "prompt": "..." }`, not a bare string.
- If the tool call fails, read the returned error: a `FAILED` remote task
  raises a tool error with the remote message; `INPUT_REQUIRED` /
  `AUTH_REQUIRED` are returned as text.
- A renamed connection changes the tool prefix. Refresh/re-edit after renaming.

## 6. Tool call returns a remote error

The remote agent's task settled non-terminal or failed. Use the remote's own
`GetTask`/panel to inspect it, or check the tool error text:

- `(remote agent returned no output)` — the remote completed with no artifacts.
- `Remote agent task failed: ...` — the remote reported `TASK_STATE_FAILED`.
- `[remote agent INPUT_REQUIRED] ...` — the remote needs more input; send a
  follow-up prompt.
- `[remote agent AUTH_REQUIRED] ...` — the remote needs authentication; update
  the connection token.

## 7. `incompatible-version` or the plugin is not loaded

DSH 0.1.7+ evaluates the plugin's `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peer ranges before importing it. A refusal means the
running harness is outside the declared ranges.

- Upgrade the plugin and/or the harness to a supported pair.
- Check the exact ranges in `package.json` and the verification record in
  [Harness compatibility](../harness-compatibility.md).
- `dsh plugin allow-version ... --accept-risk` is an explicit, exact-version
  exemption for an emergency; it is not a substitute for testing.
- Do not widen peer ranges without running the compatibility procedure
  (typecheck, tests, build, e2e).

## 8. Two DSH processes fight over storage

The `a2a` domain is a single store rooted at `DSH_HOME` (JSON by default). Two
processes sharing the same home write the same domain and can overwrite each
other's instances/tasks. Run one writer per `DSH_HOME`; use separate homes and
ports for two-instance tests. This is exactly what the hermetic e2e does.

## 9. Streaming behaves oddly

- Streaming requires `Accept: text/event-stream` on the `POST`. Without it, the
  server handles the request as non-streaming JSON-RPC.
- Only `SendStreamingMessage` and `SubscribeToTask` are valid on the streaming
  path; other methods return a method-not-found error frame.
- Frames are unnamed `data:` lines; use `curl -N` and do not buffer.
- `SendMessage` remains blocking even if the caller expects streaming; choose
  the streaming method explicitly.
- `returnImmediately` and `historyLength` are not honored in `0.3.8`.

## 10. Known limits

- No push notifications, gRPC, HTTP+JSON binding, OAuth, mTLS, or rate limiting.
- `ListTasks` returns every task and ignores filters/pagination.
- `GetTask` returns no history array.
- Live sessions and peers are memory-only; only tasks, bindings, and instances
  survive a restart.
- The `subagent` executor is not selected by the default skill map.
- Outbound `preset` is metadata; there is no local hand-off session yet.

## 11. What to include in a bug report

Please attach:

- plugin version (`0.3.8`), harness version, and OS;
- the exact command or panel action;
- the task JSON (`/a2a task get <id>`) and the AgentCard;
- whether the inbound instance has auth, and whether the request carried the
  header (never paste the token);
- the relevant host log lines and, if the session is the suspect, the
  `a2a-<contextId>` session log path;
- for outbound, the remote card URL shape (redact the host if needed) and the
  `lastError` text.

The automated layers that guard these paths are described in
[Testing](../testing.md). If you are contributing a fix, add the failing
assertion to the layer that can see it: mirror check for a type contract,
real-persistence integration for a durable-session shape, or the e2e smoke for
a released-artifact path.
