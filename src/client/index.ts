/**
 * A2A settings dashboard — browser half.
 *
 * Registers one `settings.section` ("A2A 连接") listing who is connected TO
 * this DSH (inbound server state + tasks) and who this DSH is connected TO
 * (outbound agents), with per-agent controls (enable/disable/remove/refresh)
 * and the inbound-server toggle. All data and controls live behind the host's
 * loopback-only `/a2a/api` route (src/api.ts); this half is a thin read/write
 * client with no protocol knowledge and no direct storage access.
 *
 * Styling: one idempotent `<style>` injector built on the product's
 * `--dsw-alias-*` design tokens so light/dark themes follow the DSH shell.
 * No inline styles.
 * @module dsh-a2a/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useEffect, useState, type ReactElement } from 'react'

/** Services this plugin needs from the client runtime. */
export const inject = ['slots']

const NS = 'a2a'

function injectStyles(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = NS
  tag.dataset.pluginCss = `${NS}/dashboard`
  tag.textContent = `
.dsh-a2a-panel { display: flex; flex-direction: column; gap: 16px; padding: 12px 0; }
.dsh-a2a-card { border: 1px solid var(--dsw-alias-border, #d0d7de); border-radius: 8px; padding: 12px 14px; }
.dsh-a2a-card h3 { margin: 0 0 8px; font-size: 14px; }
.dsh-a2a-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.dsh-a2a-row .muted { color: var(--dsw-alias-text-secondary, #59636e); font-size: 12px; }
.dsh-a2a-row button { padding: 2px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border, #d0d7de); background: transparent; cursor: pointer; }
.dsh-a2a-row button.primary { background: var(--dsw-alias-accent, #0f6); color: var(--dsw-alias-bg, #fff); border-color: transparent; }
.dsh-a2a-state { font-weight: 600; font-size: 12px; padding: 1px 8px; border-radius: 10px; }
.dsh-a2a-state.ok { background: #1a7f3722; color: #1a7f37; }
.dsh-a2a-state.bad { background: #d1242f22; color: #d1242f; }
.dsh-a2a-form { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
.dsh-a2a-form input { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border, #d0d7de); background: transparent; color: inherit; }
.dsh-a2a-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-a2a-table th, .dsh-a2a-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border, #d0d7de); }
.dsh-a2a-error { color: #d1242f; font-size: 12px; }
`
  document.head.appendChild(tag)
  return () => tag.remove()
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles(), `${NS}: dashboard styles`)
  // settings.section is declared at runtime by ui-settings-general; slots.inject
  // defers registration until that declaration exists and follows its lifetime
  // (a bare register before the declaration can fail or land invisible).
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'a2a',
      order: 90,
      label: () => 'A2A 连接',
      inject: () => ({}),
    },
    A2aSection,
  ))
}

/** Wire types — mirror the host's src/api.ts snapshot. */
export interface ApiSnapshot {
  readonly server: { readonly enabled: boolean; readonly cardUrl?: string; readonly skills: readonly string[] }
  readonly tasks: readonly unknown[]
  readonly agents: readonly unknown[]
}

interface AgentView {
  readonly id: string
  readonly name: string
  readonly agentCardUrl: string
  readonly enabled: boolean
  readonly state: string
  readonly skillCount: number
  readonly toolCount: number
  readonly lastError?: string
}

interface TaskView {
  readonly id: string
  readonly contextId?: string
  readonly status?: { readonly state: string }
  readonly metadata?: { readonly skill?: string }
}

async function fetchSnapshot(): Promise<ApiSnapshot> {
  const res = await fetch('/a2a/api', { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`)
  return (await res.json()) as ApiSnapshot
}

async function postControl(payload: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly message: string }> {
  const res = await fetch('/a2a/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as { ok: boolean; message: string }
  return body
}

type SectionProps = PropsRuntime<'settings.section'>

export function A2aSection(_props: SectionProps): ReactElement {
  const [snap, setSnap] = useState<ApiSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [agentName, setAgentName] = useState('')
  const [agentUrl, setAgentUrl] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchSnapshot()
        if (alive) { setSnap(next); setError(undefined) }
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const control = async (payload: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      const result = await postControl(payload)
      if (!result.ok) setError(result.message)
      setSnap(await fetchSnapshot())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const server = snap?.server
  const agents = (snap?.agents ?? []) as readonly AgentView[]
  const tasks = (snap?.tasks ?? []) as readonly TaskView[]

  return createElement(
    'div',
    { className: 'dsh-a2a-panel' },
    error !== undefined ? createElement('div', { className: 'dsh-a2a-error' }, error) : null,

    // ── inbound server ───────────────────────────────────────────────────
    createElement(
      'div',
      { className: 'dsh-a2a-card' },
      createElement('h3', null, '入站 Server'),
      server === undefined
        ? createElement('div', { className: 'muted' }, '加载中…')
        : createElement(
            'div',
            { className: 'dsh-a2a-row' },
            createElement(
              'span',
              { className: `dsh-a2a-state ${server.enabled ? 'ok' : 'bad'}` },
              server.enabled ? '已启用' : '已停用',
            ),
            createElement(
              'button',
              {
                className: server.enabled ? '' : 'primary',
                disabled: busy,
                onClick: () => void control({ action: server.enabled ? 'server.disable' : 'server.enable' }),
              },
              server.enabled ? '停用' : '启用',
            ),
          ),
      server !== undefined && server.enabled
        ? createElement(
            'div',
            { className: 'dsh-a2a-row muted' },
            `AgentCard: ${server.cardUrl ?? '(n/a)'}  ·  技能: ${server.skills.join(', ') || '(chat)'}`,
          )
        : null,
    ),

    // ── outbound agents ──────────────────────────────────────────────────
    createElement(
      'div',
      { className: 'dsh-a2a-card' },
      createElement('h3', null, `出站 Agents（${agents.length}）`),
      agents.length === 0
        ? createElement('div', { className: 'muted' }, '未配置远程 agent。')
        : createElement(
            'table',
            { className: 'dsh-a2a-table' },
            createElement(
              'thead',
              null,
              createElement('tr', null,
                createElement('th', null, '名称'),
                createElement('th', null, '状态'),
                createElement('th', null, '工具'),
                createElement('th', null, '操作'),
              ),
            ),
            createElement(
              'tbody',
              null,
              ...agents.map((a) =>
                createElement(
                  'tr',
                  { key: a.id },
                  createElement('td', null,
                    createElement('div', null, a.name),
                    createElement('div', { className: 'muted' }, a.agentCardUrl),
                    a.lastError !== undefined ? createElement('div', { className: 'dsh-a2a-error' }, a.lastError) : null,
                  ),
                  createElement('td', null,
                    createElement('span', { className: `dsh-a2a-state ${a.state === 'connected' ? 'ok' : 'bad'}` }, a.state),
                  ),
                  createElement('td', null, `${a.toolCount} / ${a.skillCount}`),
                  createElement('td', null,
                    createElement('button', { disabled: busy, onClick: () => void control({ action: a.enabled ? 'agent.disable' : 'agent.enable', id: a.id }) }, a.enabled ? '停用' : '启用'),
                    ' ',
                    createElement('button', { disabled: busy, onClick: () => void control({ action: 'agent.refresh', id: a.id }) }, '刷新'),
                    ' ',
                    createElement('button', { disabled: busy, onClick: () => void control({ action: 'agent.remove', id: a.id }) }, '删除'),
                  ),
                ),
              ),
            ),
          ),
      createElement(
        'form',
        {
          className: 'dsh-a2a-form',
          onSubmit: (ev: { preventDefault(): void }) => {
            ev.preventDefault()
            if (!agentName.trim() || !agentUrl.trim()) return
            void control({ action: 'agent.add', name: agentName.trim(), agentCardUrl: agentUrl.trim() }).then(() => {
              setAgentName('')
              setAgentUrl('')
            })
          },
        },
        createElement('input', { value: agentName, placeholder: '名称', onChange: (e: { target: { value: string } }) => setAgentName(e.target.value) }),
        createElement('input', { value: agentUrl, placeholder: 'AgentCard URL', onChange: (e: { target: { value: string } }) => setAgentUrl(e.target.value) }),
        createElement('button', { type: 'submit', className: 'primary', disabled: busy }, '添加 Agent'),
      ),
    ),

    // ── tasks ────────────────────────────────────────────────────────────
    createElement(
      'div',
      { className: 'dsh-a2a-card' },
      createElement('h3', null, `任务（${tasks.length}）`),
      tasks.length === 0
        ? createElement('div', { className: 'muted' }, '暂无任务。')
        : createElement(
            'table',
            { className: 'dsh-a2a-table' },
            createElement('thead', null,
              createElement('tr', null,
                createElement('th', null, 'ID'),
                createElement('th', null, '技能'),
                createElement('th', null, '状态'),
                createElement('th', null, '操作'),
              ),
            ),
            createElement('tbody', null,
              ...tasks.slice(-20).reverse().map((t) =>
                createElement('tr', { key: t.id },
                  createElement('td', null, createElement('span', { className: 'muted' }, t.id)),
                  createElement('td', null, t.metadata?.skill ?? '-'),
                  createElement('td', null, t.status?.state ?? '-'),
                  createElement('td', null,
                    createElement('button', { disabled: busy, onClick: () => void control({ action: 'task.cancel', id: t.id }) }, '取消'),
                  ),
                ),
              ),
            ),
          ),
    ),
  )
}