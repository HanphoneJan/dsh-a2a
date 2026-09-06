/**
 * A2A settings dashboard — browser half.
 *
 * Registers one `settings.section` ("A2A 连接") managing the multi-instance
 * A2A composition: inbound server instances (create/start/stop/remove/edit,
 * each with its own agent preset, creator-declared skill declarations, and
 * auth env) and outbound server connections (create/start/stop/remove/refresh,
 * each with a remote URL and optional preset). All data and controls live
 * behind the host's loopback-only `/a2a/api` route (src/api.ts); this half is
 * a thin read/write client with no protocol knowledge and no direct storage
 * access.
 *
 * Styling: one idempotent `<style>` injector built on the product's
 * `--dsw-alias-*` design tokens so light/dark themes follow the DSH shell.
 * No inline styles beyond fixed-width inputs.
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
.dsh-a2a-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; flex-wrap: wrap; }
.dsh-a2a-row .muted { color: var(--dsw-alias-text-secondary, #59636e); font-size: 12px; }
.dsh-a2a-row button { padding: 2px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border, #d0d7de); background: transparent; cursor: pointer; }
.dsh-a2a-row button.primary { background: var(--dsw-alias-accent, #0f6); color: var(--dsw-alias-bg, #fff); border-color: transparent; }
.dsh-a2a-state { font-weight: 600; font-size: 12px; padding: 1px 8px; border-radius: 10px; }
.dsh-a2a-state.ok { background: #1a7f3722; color: #1a7f37; }
.dsh-a2a-state.bad { background: #d1242f22; color: #d1242f; }
.dsh-a2a-form { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
.dsh-a2a-form input, .dsh-a2a-form select, .dsh-a2a-form textarea { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border, #d0d7de); background: transparent; color: inherit; }
.dsh-a2a-form textarea { font-family: inherit; width: 100%; min-height: 64px; resize: vertical; }
.dsh-a2a-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-a2a-table th, .dsh-a2a-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border, #d0d7de); vertical-align: top; }
.dsh-a2a-skill { display: inline-block; margin: 1px 4px 1px 0; padding: 0 6px; border-radius: 10px; background: #6e778122; font-size: 12px; }
.dsh-a2a-error { color: #d1242f; font-size: 12px; }
.dsh-a2a-hint { color: var(--dsw-alias-text-secondary, #59636e); font-size: 12px; margin: 2px 0 6px; }
`
  document.head.appendChild(tag)
  return () => tag.remove()
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles(), `${NS}: dashboard styles`)
  // settings.section is declared at runtime by ui-settings-general; slots.inject
  // defers registration until that declaration exists and follows its lifetime.
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

/** Wire types — mirror the host's src/api.ts + src/service.ts views. */
export interface SkillView {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface InboundServerView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly endpointPath: string
  readonly preset?: string
  readonly authTokenEnv?: string
  readonly cardPath: string
  readonly cardUrl?: string
  readonly enabled: boolean
  readonly skills: readonly SkillView[]
}

export interface OutboundServerView {
  readonly id: string
  readonly name: string
  readonly agentCardUrl: string
  readonly preset?: string
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly state: string
  readonly skillCount: number
  readonly toolCount: number
  readonly lastError?: string
}

export interface PresetView {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Whether this preset is the deployment default when none is named. */
  readonly isDefault?: boolean
}

export interface ApiSnapshot {
  readonly inbounds: readonly InboundServerView[]
  readonly outbounds: readonly OutboundServerView[]
  readonly tasks: readonly unknown[]
  readonly peers: readonly unknown[]
}

interface InboundPeerView {
  readonly id: string
  readonly label: string
  readonly source?: string | null
  readonly firstSeen?: string
  readonly lastSeen?: string
  readonly taskCount: number
  readonly activeTaskIds: readonly string[]
  readonly streaming: boolean
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

async function fetchPresets(): Promise<PresetView[]> {
  const res = await fetch('/a2a/api/presets', { headers: { accept: 'application/json' } })
  if (!res.ok) return []
  return (await res.json()) as PresetView[]
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
  const [presets, setPresets] = useState<readonly PresetView[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  // Inbound create/edit form state.
  const [editingIn, setEditingIn] = useState<string | undefined>(undefined)
  const [inName, setInName] = useState('')
  const [inDesc, setInDesc] = useState('')
  const [inVersion, setInVersion] = useState('1.0.0')
  const [inPreset, setInPreset] = useState('')
  const [inAuthEnv, setInAuthEnv] = useState('')

  // Outbound create form state.
  const [outName, setOutName] = useState('')
  const [outUrl, setOutUrl] = useState('')
  const [outPreset, setOutPreset] = useState('')
  const [outTokenEnv, setOutTokenEnv] = useState('')
  const [outTimeout, setOutTimeout] = useState('60000')

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const [next, presetRows] = await Promise.all([fetchSnapshot(), fetchPresets()])
        if (alive) {
          setSnap(next)
          setPresets(presetRows)
          // Default an unset preset picker to the deployment default (if any).
          const def = presetRows.find((p) => p.isDefault)?.id
          setInPreset((current) => current === '' && def !== undefined ? def : current)
          setOutPreset((current) => current === '' && def !== undefined ? def : current)
          setError(undefined)
        }
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

  const startCreateInbound = (): void => {
    setEditingIn(undefined)
    setInName('')
    setInDesc('')
    setInVersion('1.0.0')
    setInPreset(presets.find((p) => p.isDefault)?.id ?? '')
    setInAuthEnv('')
  }

  const submitInbound = (): void => {
    if (!inName.trim()) return
    if (editingIn !== undefined) {
      void control({
        action: 'inbound.update',
        id: editingIn,
        name: inName.trim(),
        description: inDesc.trim(),
        version: inVersion.trim() || '1.0.0',
        ...(inPreset !== '' ? { preset: inPreset } : {}),
        ...(inAuthEnv.trim() !== '' ? { authTokenEnv: inAuthEnv.trim() } : {}),
      }).then(() => setEditingIn(undefined))
      return
    }
    void control({
      action: 'inbound.create',
      name: inName.trim(),
      description: inDesc.trim() || 'An A2A inbound server',
      version: inVersion.trim() || '1.0.0',
      ...(inPreset !== '' ? { preset: inPreset } : {}),
      ...(inAuthEnv.trim() !== '' ? { authTokenEnv: inAuthEnv.trim() } : {}),
    }).then(() => startCreateInbound())
  }

  const beginEditInbound = (v: InboundServerView): void => {
    setEditingIn(v.id)
    setInName(v.name)
    setInDesc(v.description)
    setInVersion(v.version)
    setInPreset(v.preset ?? presets.find((p) => p.isDefault)?.id ?? '')
    setInAuthEnv(v.authTokenEnv ?? '')
  }

  const submitOutbound = (): void => {
    if (!outName.trim() || !outUrl.trim()) return
    const timeout = Number.parseInt(outTimeout, 10)
    void control({
      action: 'outbound.create',
      name: outName.trim(),
      agentCardUrl: outUrl.trim(),
      ...(outPreset !== '' ? { preset: outPreset } : {}),
      ...(outTokenEnv.trim() !== '' ? { bearerTokenEnv: outTokenEnv.trim() } : {}),
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    }).then(() => {
      setOutName('')
      setOutUrl('')
      setOutPreset(presets.find((p) => p.isDefault)?.id ?? '')
      setOutTokenEnv('')
    })
  }

  const inbounds = snap?.inbounds ?? []
  const outbounds = snap?.outbounds ?? []
  const peers = (snap?.peers ?? []) as readonly InboundPeerView[]
  const tasks = (snap?.tasks ?? []) as readonly TaskView[]

  return createElement(
    'div',
    { className: 'dsh-a2a-panel' },
    error !== undefined ? createElement('div', { className: 'dsh-a2a-error' }, error) : null,

    // ── inbound server instances ────────────────────────────────────────
    createElement(
      'div',
      { className: 'dsh-a2a-card' },
      createElement('h3', null, `入站 Servers（${inbounds.length}）`),
      inbounds.length === 0
        ? createElement('div', { className: 'muted' }, '还没有入站 server。创建一个即可对外发布 A2A 端点。')
        : createElement(
            'table',
            { className: 'dsh-a2a-table' },
            createElement('thead', null,
              createElement('tr', null,
                createElement('th', null, '名称 / 端点'),
                createElement('th', null, 'Preset'),
                createElement('th', null, '技能宣告'),
                createElement('th', null, '状态'),
                createElement('th', null, '操作'),
              ),
            ),
            createElement('tbody', null,
              ...inbounds.map((v) =>
                createElement('tr', { key: v.id },
                  createElement('td', null,
                    createElement('div', null, v.name),
                    createElement('div', { className: 'muted' }, `${v.endpointPath} · ${v.cardUrl ?? v.cardPath}`),
                    v.authTokenEnv !== undefined && v.authTokenEnv !== ''
                      ? createElement('div', { className: 'muted' }, `鉴权: $${v.authTokenEnv}`)
                      : null,
                  ),
                  createElement('td', null, v.preset ?? createElement('span', { className: 'muted' }, '默认')),
                  createElement('td', null,
                    createElement('div', null,
                      ...v.skills.map((s) =>
                        createElement('span', { className: 'dsh-a2a-skill', key: s.id, title: s.description ?? '' }, s.name),
                      ),
                    ),
                  ),
                  createElement('td', null,
                    createElement('span', { className: `dsh-a2a-state ${v.enabled ? 'ok' : 'bad'}` }, v.enabled ? '运行中' : '已停用'),
                  ),
                  createElement('td', null,
                    createElement('button', { disabled: busy, onClick: () => void control({ action: v.enabled ? 'inbound.disable' : 'inbound.enable', id: v.id }) }, v.enabled ? '停用' : '启用'),
                    ' ',
                    createElement('button', { disabled: busy, onClick: () => beginEditInbound(v) }, '编辑'),
                    ' ',
                    createElement('button', { disabled: busy, onClick: () => void control({ action: 'inbound.remove', id: v.id }) }, '删除'),
                  ),
                ),
              ),
            ),
          ),
      createElement('h3', { style: { marginTop: '12px' } }, editingIn !== undefined ? '编辑入站 Server' : '新建入站 Server'),
      createElement(
        'form',
        {
          className: 'dsh-a2a-form',
          onSubmit: (ev: { preventDefault(): void }) => {
            ev.preventDefault()
            submitInbound()
          },
        },
        createElement('input', { value: inName, placeholder: '名称', onChange: (e: { target: { value: string } }) => setInName(e.target.value) }),
        createElement('input', { value: inVersion, placeholder: '版本', onChange: (e: { target: { value: string } }) => setInVersion(e.target.value), style: { width: '70px' } }),
        createElement('select', { value: inPreset, onChange: (e: { target: { value: string } }) => setInPreset(e.target.value) },
          ...presets.map((p) => createElement('option', { value: p.id, key: p.id, title: p.description ?? p.id }, p.name ?? p.id)),
        ),
        createElement('input', { value: inAuthEnv, placeholder: '鉴权 env 变量名（可选）', onChange: (e: { target: { value: string } }) => setInAuthEnv(e.target.value) }),
      ),
      createElement(
        'form',
        {
          className: 'dsh-a2a-form',
          onSubmit: (ev: { preventDefault(): void }) => {
            ev.preventDefault()
            submitInbound()
          },
          style: { alignItems: 'flex-end' },
        },
        createElement('input', { value: inDesc, placeholder: '描述', onChange: (e: { target: { value: string } }) => setInDesc(e.target.value), style: { flex: 1, minWidth: '260px' } }),
        createElement('button', { type: 'submit', className: 'primary', disabled: busy || !inName.trim() }, editingIn !== undefined ? '保存修改' : '创建 Server'),
        editingIn !== undefined ? createElement('button', { type: 'button', disabled: busy, onClick: () => startCreateInbound() }, '取消') : null,
      ),
      createElement('div', { className: 'dsh-a2a-hint' }, '该 server 绑定的 preset 决定其技能（一切皆插件）：AgentCard 技能 = 该 preset 可用的模型技能，创建后自动派生。'),
    ),

    // ── outbound server instances ───────────────────────────────────────
    createElement(
      'div',
      { className: 'dsh-a2a-card' },
      createElement('h3', null, `出站 Servers（${outbounds.length}）`),
      outbounds.length === 0
        ? createElement('div', { className: 'muted' }, '还没有出站 server。添加一个远端 A2A 连接即可把其技能注册为模型工具。')
        : createElement(
            'table',
            { className: 'dsh-a2a-table' },
            createElement('thead', null,
              createElement('tr', null,
                createElement('th', null, '名称 / 远端'),
                createElement('th', null, 'Preset'),
                createElement('th', null, '状态'),
                createElement('th', null, '工具'),
                createElement('th', null, '操作'),
              ),
            ),
            createElement('tbody', null,
              ...outbounds.map((v) =>
                createElement('tr', { key: v.id },
                  createElement('td', null,
                    createElement('div', null, v.name),
                    createElement('div', { className: 'muted' }, v.agentCardUrl),
                    v.lastError !== undefined ? createElement('div', { className: 'dsh-a2a-error' }, v.lastError) : null,
                  ),
                  createElement('td', null, v.preset ?? createElement('span', { className: 'muted' }, '默认')),
                  createElement('td', null,
                    createElement('span', { className: `dsh-a2a-state ${v.state === 'connected' ? 'ok' : 'bad'}` }, v.state === 'connected' ? '已连接' : v.state),
                  ),
                  createElement('td', null, `${v.toolCount} / ${v.skillCount}`),
                  createElement('td', null,
                    createElement('button', { disabled: busy, onClick: () => void control({ action: v.enabled ? 'outbound.disable' : 'outbound.enable', id: v.id }) }, v.enabled ? '停用' : '启用'),
                    ' ',
                    createElement('button', { disabled: busy, onClick: () => void control({ action: 'outbound.refresh', id: v.id }) }, '刷新'),
                    ' ',
                    createElement('button', { disabled: busy, onClick: () => void control({ action: 'outbound.remove', id: v.id }) }, '删除'),
                  ),
                ),
              ),
            ),
          ),
      createElement('h3', { style: { marginTop: '12px' } }, '新建出站 Server'),
      createElement(
        'form',
        {
          className: 'dsh-a2a-form',
          onSubmit: (ev: { preventDefault(): void }) => {
            ev.preventDefault()
            submitOutbound()
          },
        },
        createElement('input', { value: outName, placeholder: '名称', onChange: (e: { target: { value: string } }) => setOutName(e.target.value) }),
        createElement('input', { value: outUrl, placeholder: '远端 AgentCard URL', onChange: (e: { target: { value: string } }) => setOutUrl(e.target.value), style: { flex: 1, minWidth: '240px' } }),
        createElement('select', { value: outPreset, onChange: (e: { target: { value: string } }) => setOutPreset(e.target.value) },
          ...presets.map((p) => createElement('option', { value: p.id, key: p.id, title: p.description ?? p.id }, p.name ?? p.id)),
        ),
        createElement('input', { value: outTokenEnv, placeholder: 'Bearer env 变量名（可选）', onChange: (e: { target: { value: string } }) => setOutTokenEnv(e.target.value) }),
        createElement('input', { value: outTimeout, placeholder: '超时 ms', onChange: (e: { target: { value: string } }) => setOutTimeout(e.target.value), style: { width: '90px' } }),
        createElement('button', { type: 'submit', className: 'primary', disabled: busy || !outName.trim() || !outUrl.trim() }, '添加出站 Server'),
      ),
    ),

    // ── inbound peer monitoring ─────────────────────────────────────────
    createElement(
      'div',
      { className: 'dsh-a2a-card' },
      createElement('h3', null, `入站连接（${peers.length}）`),
      peers.length === 0
        ? createElement('div', { className: 'muted' }, '当前无远程对端正在调用本服务。')
        : createElement(
            'table',
            { className: 'dsh-a2a-table' },
            createElement('thead', null,
              createElement('tr', null,
                createElement('th', null, '来源'),
                createElement('th', null, '任务'),
                createElement('th', null, '流式'),
                createElement('th', null, '首次 / 最近'),
                createElement('th', null, '操作'),
              ),
            ),
            createElement('tbody', null,
              ...peers.map((p) =>
                createElement('tr', { key: p.id },
                  createElement('td', null, p.source ?? p.label),
                  createElement('td', null, `${p.taskCount}（活跃 ${p.activeTaskIds.length}）`),
                  createElement('td', null, p.streaming ? '●' : '—'),
                  createElement('td', null,
                    createElement('span', { className: 'muted' }, `${p.firstSeen ?? ''} / ${p.lastSeen ?? ''}`),
                  ),
                  createElement('td', null,
                    createElement('button', { disabled: busy, onClick: () => void control({ action: 'inbound.close', id: p.id }) }, '关闭'),
                  ),
                ),
              ),
            ),
          ),
    ),

    // ── tasks ───────────────────────────────────────────────────────────
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