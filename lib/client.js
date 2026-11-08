window.__ModuleLoader__.load({ id: 'youyudshm', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
  const ReactDOM = require('react-dom')
  const h = React.createElement
  const portal = ReactDOM !== undefined && ReactDOM !== null && typeof ReactDOM.createPortal === 'function'
    ? ReactDOM.createPortal
    : (node) => node

  const PANEL_ID = 'youyudshm'
  const ACCENT = '#2f81f7'
  const API = '/plugins/youyudshm'
  const SSH = '/plugins/dsh-ssh-servers'
  const POLL_MS = 5000

  function log() {
    try {
      if (typeof console !== 'undefined' && console.log) {
        console.log.apply(console, ['[youyudshm]'].concat(Array.prototype.slice.call(arguments)))
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 不让点击把焦点带走。
   *
   * 输入框有焦点时（刚打完字），点任何按钮都会先把焦点交给它，某些 WebView 会因此
   * 重新拉起软键盘。preventDefault 挡住焦点转移，再主动 blur 一次把已有焦点收掉。
   */
  function stopFocus(e) {
    if (e !== undefined && e !== null && typeof e.preventDefault === 'function') e.preventDefault()
    if (e !== undefined && e !== null && typeof e.stopPropagation === 'function') e.stopPropagation()
    try {
      const el = document.activeElement
      if (el !== null && el !== undefined && typeof el.blur === 'function') el.blur()
    } catch (err) { /* 忽略 */ }
  }

  /**
   * 短时压制输入框焦点。
   *
   * 只拦 mousedown 不够：对话页重新挂载时会自己把焦点塞回编辑器
   * （官方 InputBar 的 `focusDraftEditor(editor, …)`，依赖 [locked, sessionId, editor] 的 effect），
   * 那一步在 click 之后才发生，软键盘就跟着弹出来。
   * 所以回到对话后的一小段时间里反复 blur，把这次自动聚焦吃掉。
   * 900 ms 之后完全停手，不影响随后正常点输入框打字。
   */
  function suppressImeBurst() {
    const start = Date.now()
    const tick = () => {
      try {
        const el = document.activeElement
        if (el !== null && el !== undefined && el !== document.body
          && typeof el.blur === 'function') el.blur()
      } catch (err) { /* 忽略 */ }
      if (Date.now() - start < 900) setTimeout(tick, 60)
    }
    tick()
  }

  /** 同上，但不拦冒泡（给按钮用）。 */
  function keepFocusHere(e) {
    if (e !== undefined && e !== null && typeof e.preventDefault === 'function') e.preventDefault()
    try {
      const el = document.activeElement
      if (el !== null && el !== undefined && typeof el.blur === 'function') el.blur()
    } catch (err) { /* 忽略 */ }
  }

  // ------------------------------------------------------------------ tokens
  // Codex 风格：高密度、等宽数字、细分隔线、少阴影。
  const C = {
    accent: '#2f81f7',
    ok: '#2ea043',
    bad: '#f85149',
    warn: '#d29922',
    dim: 'var(--text-secondary, #8b949e)',
    line: 'var(--border-color, #d8d8d8)',
    surface: 'var(--surface-color, transparent)',
    bg: 'var(--dsw-alias-bg-layer-1, #fff)',
    hover: 'rgba(127,127,127,.09)',
    on: 'rgba(47,129,247,.10)',
    onLine: 'rgba(47,129,247,.45)',
  }
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  const s = {
    wrap: { display: 'grid', gap: 12 },
    row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' },
    panel: { border: '1px solid ' + C.line, borderRadius: 10, padding: 12, display: 'grid', gap: 10, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' },
    title: { fontWeight: 700, fontSize: 13, letterSpacing: 0.2 },
    sub: { fontSize: 11, opacity: 0.65 },
    mono: { fontFamily: mono, fontSize: 11 },
    kbd: { fontFamily: mono, fontSize: 10, border: '1px solid ' + C.line, borderRadius: 4, padding: '1px 5px' },
    btn: (primary) => ({
      padding: '5px 12px', borderRadius: 7, cursor: 'pointer', fontSize: 12, lineHeight: 1.4,
      border: primary ? '1px solid transparent' : '1px solid ' + C.line,
      background: primary ? C.accent : 'transparent',
      color: primary ? '#fff' : 'inherit',
    }),
    input: {
      padding: '5px 8px', borderRadius: 6, border: '1px solid ' + C.line,
      background: 'transparent', color: 'inherit', fontSize: 12, width: '100%', boxSizing: 'border-box',
    },
    grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 10, minWidth: 0 },
    kv: { display: 'grid', gap: 2 },
    dot: (on) => ({ width: 7, height: 7, borderRadius: '50%', background: on ? C.ok : C.dim, flex: '0 0 auto' }),
    err: { color: C.bad, fontSize: 12, whiteSpace: 'pre-wrap' },
    scroll: { maxHeight: 260, overflowY: 'auto', overflowX: 'hidden', minWidth: 0 },
  }

  function Field({ label, hint, children }) {
    return h('label', { style: { display: 'grid', gap: 4 } },
      h('span', { style: { fontWeight: 600, fontSize: 12 } }, label),
      hint ? h('span', { style: s.sub }, hint) : null,
      children)
  }

  async function getJson(url) {
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r.json()
  }

  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    let payload = {}
    try { payload = await r.json() } catch (e) { payload = {} }
    if (!r.ok) throw new Error(payload.error || ('HTTP ' + r.status))
    return payload
  }

  /** 两个来源各取一份，任一失败不影响另一个。 */
  function useYouyuState() {
    const [host, setHost] = useState(null)
    const [ssh, setSsh] = useState({ profiles: [], connections: [], audit: [] })
    const [error, setError] = useState(null)

    const refresh = useCallback(async () => {
      const problems = []
      try { setHost(await getJson(API + '/state')) } catch (e) { problems.push('宿主状态：' + e.message) }
      try {
        const d = await getJson(SSH + '/state')
        setSsh({
          profiles: Array.isArray(d.profiles) ? d.profiles : [],
          connections: Array.isArray(d.connections) ? d.connections : [],
          audit: Array.isArray(d.audit) ? d.audit : [],
        })
      } catch (e) { problems.push('SSH：' + e.message) }
      setError(problems.length > 0 ? problems.join('\n') : null)
    }, [])

    useEffect(() => {
      let alive = true
      const tick = () => { if (alive) void refresh() }
      tick()
      const id = setInterval(tick, POLL_MS)
      return () => { alive = false; clearInterval(id) }
    }, [refresh])

    return { host, ssh, error, refresh }
  }

  function fmtAgo(iso) {
    if (!iso) return '—'
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return '—'
    const d = Math.max(0, Date.now() - t)
    const m = Math.floor(d / 60000)
    if (m < 1) return Math.floor(d / 1000) + 's'
    if (m < 60) return m + 'm'
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
  }

  // ------------------------------------------------------------- ssh select
  // 输入框右侧的下拉。只做一件事：给「当前会话」勾选可用的服务器。
  // 点名字不连接、不跳转、不做任何事 —— 连接走工作台的「测试」或让 agent 调 ssh_connect。
  function SshSelect(props) {
    const sessionId = props && props.sessionId ? String(props.sessionId) : ''
    const sessionKey = sessionId.length > 0 ? sessionId : '__global'
    const { ssh, host, refresh } = useYouyuState()
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState(null)
    const [pos, setPos] = useState(null)
    const btnRef = useRef(null)
    const menuRef = useRef(null)

    const table = host && host.sessionServers && typeof host.sessionServers === 'object' ? host.sessionServers : {}
    const checked = Array.isArray(table[sessionKey]) ? table[sessionKey] : []

    // 连接是宿主级的，可能由别的会话建立。这里只认「本会话勾选并且已连」的那几条，
    // 否则别的会话连上以后，本会话会亮绿标却用不了。
    // 注意：下面几行必须在 `checked` 声明之后 —— 之前写成前面调用 filter 会踩 TDZ，
    // 一有连接就抛 ReferenceError，整个组件从界面上消失。
    const mineLive = ssh.connections.filter((c) => checked.indexOf(c.profileId) >= 0).length
    const isChecked = (id) => checked.indexOf(id) >= 0
    const scopeLabel = sessionId.length > 0 ? '本会话' : '全局'

    // 菜单走 portal 挂到 body：输入区可能带 transform / overflow，
    // 直接放在里面会让 fixed 定位失效——右边界算错、或者被祖先裁掉看不见。
    const place = () => {
      const node = btnRef.current
      if (node === null || typeof node.getBoundingClientRect !== 'function') { setPos(null); return }
      const r = node.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const width = Math.min(232, Math.max(132, Math.round(vw * 0.62)))
      const maxLeft = Math.max(8, vw - width - 8)
      const left = Math.min(Math.max(8, Math.round(r.left)), maxLeft)
      const bottom = Math.max(8, Math.round(vh - r.top + 6))
      setPos({ left: left, width: width, bottom: bottom, maxHeight: Math.max(120, r.top - 16) })
    }

    // 点外面关掉：菜单在 body 里，必须自己判断
    useEffect(() => {
      if (!open) return undefined
      const onDown = (e) => {
        const t = e.target
        if (btnRef.current !== null && btnRef.current.contains(t)) return
        if (menuRef.current !== null && menuRef.current.contains(t)) return
        setOpen(false)
      }
      document.addEventListener('mousedown', onDown)
      return () => document.removeEventListener('mousedown', onDown)
    }, [open])

    const toggle = async (id) => {
      const next = isChecked(id) ? checked.filter((x) => x !== id) : checked.concat([id])
      setBusy(true); setMsg(null)
      try {
        await postJson(API + '/session', { sessionId: sessionKey, profileIds: next })
        await refresh()
      } catch (e) { setMsg(e.message) } finally { setBusy(false) }
    }

    const trigger = h('button', {
      type: 'button',
      ref: btnRef,
      title: '勾选本会话可用的服务器',
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        padding: '4px 10px', fontSize: 11.5, fontFamily: mono, lineHeight: 1.3,
        border: '1px solid ' + C.line, borderRadius: 999, background: 'transparent', color: 'inherit',
      },
      // 阻止默认按下行为：否则焦点会落到输入框上，输入法被带起来。
      onMouseDown: (e) => { e.preventDefault(); e.stopPropagation() },
      onPointerDown: (e) => { e.preventDefault(); e.stopPropagation() },
      onClick: (e) => {
        e.preventDefault(); e.stopPropagation()
        try {
          const el = document.activeElement
          if (el !== null && el !== undefined && typeof el.blur === 'function') el.blur()
        } catch (err) { /* 忽略 */ }
        if (open) { setOpen(false) } else { place(); setOpen(true) }
      },
    },
      h('span', { style: s.dot(mineLive > 0) }),
      h('span', null, 'SSH ' + checked.length + (mineLive > 0 ? ' · ' + mineLive : '')),
      h('span', { style: { opacity: 0.5, fontSize: 9 } }, open ? '▾' : '▴'),
    )

    const rows = ssh.profiles.length === 0
      ? [h('div', { key: 'empty', style: Object.assign({}, s.sub, { padding: '8px 6px' }) }, '还没有服务器')]
      : ssh.profiles.map((profile) => {
        const isLive = ssh.connections.some((c) => c.profileId === profile.id)
        const name = profile.label || profile.host
        const shown = name.length > 10 ? name.slice(0, 10) + '…' : name
        const on = isChecked(profile.id)
        return h('div', {
          key: profile.id,
          title: name,
          onMouseDown: (e) => { e.preventDefault(); e.stopPropagation() },
          onPointerDown: (e) => { e.preventDefault(); e.stopPropagation() },
          onClick: (e) => {
            e.preventDefault(); e.stopPropagation()
            // 输入法：preventDefault 只挡住「这次点击」的焦点转移；
            // 若输入框本来就有焦点，还得主动 blur，否则软键盘会重新弹出来。
            try {
              const el = document.activeElement
              if (el !== null && el !== undefined && typeof el.blur === 'function') el.blur()
            } catch (err) { /* 忽略 */ }
            if (!busy) void toggle(profile.id)
          },
          style: {
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '5px 6px', borderRadius: 7, cursor: 'pointer', minWidth: 0,
            background: on ? 'rgba(47,129,247,.10)' : 'transparent',
            userSelect: 'none',
          },
        },
          h('input', {
            type: 'checkbox',
            checked: on,
            readOnly: true,
            tabIndex: -1,
            style: { width: 14, height: 14, flex: '0 0 auto', accentColor: C.accent, pointerEvents: 'none' },
          }),
          h('span', { style: { whiteSpace: 'nowrap', fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, shown),
          isLive
            ? h('span', {
              style: {
                marginLeft: 'auto', fontSize: 10,
                color: on ? C.ok : C.dim,
                opacity: on ? 1 : 0.7,
              },
            }, on ? '已连' : '他处已连')
            : null,
        )
      })

    const menuNode = open ? h('div', {
      ref: menuRef,
      style: {
        position: 'fixed',
        left: pos !== null ? pos.left : 8,
        width: pos !== null ? pos.width : 200,
        bottom: pos !== null ? pos.bottom : 96,
        zIndex: 70,
        maxHeight: pos !== null ? Math.min(320, pos.maxHeight) : 240,
        overflowY: 'auto', overflowX: 'hidden',
        padding: '5px 5px', display: 'grid', gap: 0, boxSizing: 'border-box',
        border: '1px solid ' + C.line, borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1, #fff)', boxShadow: '0 8px 24px rgba(0,0,0,.16)',
      },
      onMouseDown: (e) => { e.preventDefault(); e.stopPropagation() },
      onPointerDown: (e) => { e.preventDefault(); e.stopPropagation() },
      onClick: (e) => { e.stopPropagation() },
    },
      h('div', { style: Object.assign({}, s.sub, { padding: '1px 6px 3px', fontSize: 10 }) }, '勾选后' + scopeLabel + '可用'),
      rows,
      msg ? h('div', { style: { padding: '2px 6px 4px', fontSize: 11, color: C.bad, overflowWrap: 'anywhere' } }, msg) : null,
    ) : null

    const menu = menuNode !== null && typeof document !== 'undefined'
      ? portal(menuNode, document.body)
      : menuNode

    return h('div', { style: { position: 'relative', display: 'inline-flex' } }, trigger, menu)
  }


  // -------------------------------------------------------------- panel glyph
  // 左侧导航栏的图标。slot 会传 { size, active }。
  function PanelIcon(props) {
    const size = props && props.size ? props.size : 18
    const active = props && props.active === true
    return h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: active ? C.accent : 'currentColor', strokeWidth: 1.7,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    },
      h('path', { d: 'M3 7.5h18' }),
      h('path', { d: 'M3 12h11' }),
      h('path', { d: 'M3 16.5h7' }),
      h('circle', { cx: 18.5, cy: 16.5, r: 2.4 }),
    )
  }

  // ------------------------------------------------------------- server admin
  // 服务器增删改 + 密码保管 + 一键连接。
  // 密码存到宿主（$DSH_HOME/youyudshm/credentials.json，0600），浏览器里不留。
  const BLANK = { id: '', label: '', host: '', port: 22, username: '', remoteCwd: '~' }

  function ServerAdmin({ ssh, host, refresh, compact }) {
    const [draft, setDraft] = useState(BLANK)
    const [draftPw, setDraftPw] = useState('')
    const [pwFor, setPwFor] = useState('')
    const [pw, setPw] = useState('')
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState(null)
    const saved = host && Array.isArray(host.savedCredentials) ? host.savedCredentials : []
    const hasPw = (id) => saved.indexOf(id) >= 0

    const edit = (key) => (event) => {
      const v = event.target.value
      setDraft((d) => Object.assign({}, d, { [key]: key === 'port' ? Number(v) : v }))
    }

    const putPassword = async (id, value) => {
      await postJson(API + '/credentials', { profileId: id, password: value })
    }

    const save = async () => {
      setBusy(true); setMsg(null)
      try {
        const res = await postJson(SSH + '/profiles', { profile: draft })
        if (draftPw.length > 0) {
          let id = draft.id
          if (id.length === 0) {
            const list = Array.isArray(res.profiles) ? res.profiles : []
            const hit = list.find((x) => x.host === draft.host && x.username === draft.username
              && (x.label || '') === (draft.label || ''))
            id = hit !== undefined ? hit.id : ''
          }
          if (id.length > 0) await putPassword(id, draftPw)
        }
        setDraft(BLANK); setDraftPw('')
        setMsg('已保存')
        await refresh()
      } catch (e) { setMsg(e.message) } finally { setBusy(false) }
    }

    const remove = async (id) => {
      setBusy(true); setMsg(null)
      try {
        await postJson(SSH + '/profiles', { action: 'delete', profile: { id: id } })
        await postJson(API + '/credentials/delete', { profileId: id })
        await refresh()
      } catch (e) { setMsg(e.message) } finally { setBusy(false) }
    }

    // 「测试」只验密码：连一下，成功就立刻断开，不在后台留连接。
    const testConn = async (id) => {
      setBusy(true); setMsg(null)
      try {
        await postJson(API + '/connect', { profileId: id })
        setMsg('密码正确，连接成功（已自动断开）')
        await postJson(SSH + '/disconnect', { profileId: id }).catch(() => {})
      } catch (e) {
        setMsg('测试失败：' + e.message)
      } finally { setBusy(false); await refresh() }
    }

    const disconnect = async (id) => {
      setBusy(true); setMsg(null)
      try {
        await postJson(SSH + '/disconnect', { profileId: id })
        await refresh()
      } catch (e) { setMsg(e.message) } finally { setBusy(false) }
    }

    const commitPw = async (id) => {
      setBusy(true); setMsg(null)
      try {
        await putPassword(id, pw)
        setMsg(pw.length > 0 ? '密码已保存' : '密码已清除')
        setPw(''); setPwFor('')
        await refresh()
      } catch (e) { setMsg(e.message) } finally { setBusy(false) }
    }

    const list = ssh.profiles.map((profile) => {
      const live = ssh.connections.some((c) => c.profileId === profile.id)
      const editing = pwFor === profile.id
      return h('div', {
        key: profile.id,
        style: { display: 'grid', gap: 8, padding: '8px 10px', border: '1px solid ' + C.line, borderRadius: 9, minWidth: 0, boxSizing: 'border-box' },
      },
        h('div', { style: s.row },
          h('span', { style: s.dot(live) }),
          h('div', { style: { display: 'grid', gap: 1, minWidth: 0, flex: '1 1 120px' } },
            h('div', { style: { fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              profile.label || profile.host),
            h('div', { style: Object.assign({}, s.mono, { opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) },
              profile.username + '@' + profile.host + ':' + profile.port),
          ),
          h('span', { style: { fontSize: 10, fontFamily: mono, color: hasPw(profile.id) ? C.ok : C.dim, whiteSpace: 'nowrap' } },
            hasPw(profile.id) ? '密码已存' : '无密码'),
        ),
        h('div', { style: s.row },
          live
            ? h('button', { style: s.btn(false), disabled: busy, onClick: () => void disconnect(profile.id) }, '断开')
            : h('button', {
              style: s.btn(true), disabled: busy || !hasPw(profile.id),
              title: hasPw(profile.id) ? '只测试密码是否正确：连上就立刻断开' : '先设一个密码',
              onClick: () => void testConn(profile.id),
            }, busy ? '测试中…' : '测试'),
          h('button', { style: s.btn(false), onClick: () => { setPwFor(editing ? '' : profile.id); setPw('') } }, editing ? '取消' : '设密码'),
          h('button', { style: s.btn(false), onClick: () => setDraft(Object.assign({}, profile)) }, '编辑'),
          h('button', { style: s.btn(false), disabled: busy, onClick: () => void remove(profile.id) }, '删除'),
        ),
        editing ? h('div', { style: s.row },
          h('input', {
            style: Object.assign({}, s.input, { flex: '1 1 120px', minWidth: 0 }),
            type: 'password', autoComplete: 'off', placeholder: '留空则清除已保存的密码',
            value: pw, onChange: (e) => setPw(e.target.value),
          }),
          h('button', { style: s.btn(true), disabled: busy, onClick: () => void commitPw(profile.id) }, '保存'),
        ) : null,
      )
    })

    return h('div', { style: s.wrap },
      compact ? null : h('div', { style: s.sub },
        '地址、用户名、远程工作目录、密码都只存在本机。密码落在 $DSH_HOME/youyudshm/credentials.json（0600）；'
        + '浏览器不留，模型也读不到，只能用 ssh_connect 触发一次连接。'),
      msg ? h('div', { style: s.sub }, msg) : null,
      ssh.profiles.length > 0 ? h('div', { style: s.wrap }, list) : h('div', { style: s.sub }, '还没有服务器。'),
      h('div', { style: s.panel },
        h('div', { style: s.title }, draft.id ? '编辑服务器' : '添加服务器'),
        h('div', { style: s.grid2 },
          h(Field, { label: '名称' }, h('input', { style: s.input, value: draft.label, onChange: edit('label'), placeholder: '计算节点' })),
          h(Field, { label: '地址' }, h('input', { style: s.input, value: draft.host, onChange: edit('host'), placeholder: '192.168.1.10' })),
          h(Field, { label: '端口' }, h('input', { style: s.input, type: 'number', value: draft.port, onChange: edit('port') })),
          h(Field, { label: '用户名' }, h('input', { style: s.input, value: draft.username, onChange: edit('username'), placeholder: 'root' })),
        ),
        h(Field, { label: '远程工作目录', hint: 'ssh_* 工具默认在这个目录下执行。' },
          h('input', { style: s.input, value: draft.remoteCwd, onChange: edit('remoteCwd'), placeholder: '/home/user/project' })),
        h(Field, { label: '密码', hint: '存下来以后就能一键连接；留空表示不存。' },
          h('input', { style: s.input, type: 'password', autoComplete: 'off', value: draftPw, onChange: (e) => setDraftPw(e.target.value) })),
        h('div', { style: Object.assign({}, s.row, { justifyContent: 'flex-end' }) },
          draft.id ? h('button', { style: s.btn(false), onClick: () => { setDraft(BLANK); setDraftPw('') } }, '取消') : null,
          h('button', {
            style: s.btn(true), disabled: busy || draft.host.length === 0 || draft.username.length === 0,
            onClick: () => void save(),
          }, '保存'),
        ),
      ),
    )
  }

  // ---------------------------------------------------------------- workbench
  function Stat({ label, value, hint }) {
    return h('div', { style: { display: 'grid', gap: 3, padding: '9px 11px', border: '1px solid ' + C.line, borderRadius: 9, minWidth: 0, boxSizing: 'border-box' } },
      h('div', { style: { fontSize: 10, letterSpacing: 0.6, opacity: 0.6, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
      h('div', { style: { fontFamily: mono, fontSize: 14, fontWeight: 700, overflowWrap: 'anywhere', minWidth: 0 } }, value),
      hint ? h('div', { style: { fontSize: 10, opacity: 0.55, fontFamily: mono } }, hint) : null,
    )
  }

  function AuditTable({ audit }) {
    if (!audit || audit.length === 0) {
      return h('div', { style: s.sub }, '没有连接记录。')
    }
    return h('div', { style: Object.assign({}, s.scroll) },
      h('div', { style: { display: 'grid', gap: 4 } },
        audit.slice(0, 20).map((entry, i) => h('div', {
          key: String(i),
          style: { display: 'grid', gridTemplateColumns: '42px minmax(0, 1.5fr) minmax(0, 1fr)', gap: 6, fontSize: 11, fontFamily: mono, minWidth: 0 },
        },
          h('span', { style: { opacity: 0.55, whiteSpace: 'nowrap' } }, fmtAgo(entry.at)),
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (entry.label || entry.profileId || '?') + ' · ' + entry.action),
          h('span', {
            style: {
              color: String(entry.result || '').indexOf('ok') === 0 ? C.ok : C.bad,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right',
            },
          }, String(entry.result || '')),
        )),
      ),
    )
  }

  // ------------------------------------------------------------- 启动守卫卡片
  // 「装了坏插件就再也进不来」这个问题的兜底：守卫在 runProfile 之前检查上次启动，
  // 没走完就把 profile 退回核心种子。这里只负责展示状态与安装/回滚。
  function GuardCard() {
    const [data, setData] = useState(null)
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState(null)
    const [showLog, setShowLog] = useState(false)

    const load = () => {
      if (typeof fetch !== 'function') return
      fetch(API + '/guard', { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d !== null && d !== undefined) setData(d) })
        .catch(() => {})
    }

    useEffect(() => {
      load()
      const id = setInterval(load, 10000)
      return () => clearInterval(id)
    }, [])

    const call = async (path, label) => {
      setBusy(true); setMsg(null)
      try {
        const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        const d = r.ok ? await r.json() : null
        const note = d && d.guard ? d.guard.note : (d && d.polyfill ? d.polyfill.note : null)
        setMsg(label + '：' + (note || ('HTTP ' + r.status)))
        load()
      } catch (e) {
        setMsg(label + ' 失败：' + String(e && e.message ? e.message : e))
      } finally { setBusy(false) }
    }

    const g = data && data.guard ? data.guard : null
    const rep = data && data.report ? data.report : null
    const poly = data && data.polyfill ? data.polyfill : null
    const healthy = g !== null && g.healthy === true
    const logLines = rep && Array.isArray(rep.log) ? rep.log : []
    const bads = rep && Array.isArray(rep.badProfiles) ? rep.badProfiles : []

    return h('div', { style: s.panel },
      h('div', { style: s.row },
        h('span', { style: s.dot(healthy) }),
        h('div', { style: s.title }, '启动守卫'),
        h('span', { style: Object.assign({}, s.sub, { fontFamily: mono }) },
          healthy ? '已在位' : (g === null ? '未知' : '未安装')),
        h('span', { style: { flex: 1 } }),
        h('button', {
          style: s.btn(healthy ? false : true), disabled: busy,
          onMouseDown: keepFocusHere, onPointerDown: keepFocusHere,
          onClick: (e) => { keepFocusHere(e); void call(healthy ? '/guard/install' : '/guard/install', '安装') },
        }, busy ? '…' : (healthy ? '重新安装' : '安装守卫')),
        h('button', {
          style: s.btn(false), disabled: busy,
          onMouseDown: keepFocusHere, onPointerDown: keepFocusHere,
          onClick: (e) => { keepFocusHere(e); void call('/guard/rollback', '回滚') },
        }, '回滚'),
        h('button', {
          style: s.btn(false), disabled: busy,
          onMouseDown: keepFocusHere, onPointerDown: keepFocusHere,
          onClick: (e) => { keepFocusHere(e); void call('/repair', '修复 ssh2') },
        }, '修复 ssh2'),
      ),
      msg ? h('div', { style: s.sub }, msg) : null,
      h('div', { style: Object.assign({}, s.sub, { fontFamily: mono, overflowWrap: 'anywhere' }) },
        g !== null && g.libDir ? g.libDir : '找不到核心树'),
      poly !== null && poly.found
        ? h('div', { style: Object.assign({}, s.mono, { opacity: 0.65 }) },
          'ssh2 poly1305：' + (poly.allPatched ? '纯 JS 版' : '仍是 WASM 版（-jitless 下会崩）'))
        : h('div', { style: Object.assign({}, s.mono, { opacity: 0.5 }) }, 'ssh2 poly1305：未装 ssh2'),
      bads.length > 0
        ? h('div', { style: Object.assign({}, s.mono, { opacity: 0.7, overflowWrap: 'anywhere' }) },
          '已隔离 profile ' + bads.length + ' 份：' + bads.join('、'))
        : null,
      h('div', { style: s.row },
        h('button', {
          style: Object.assign({}, s.btn(false), { padding: '2px 8px', fontSize: 11 }),
          onMouseDown: keepFocusHere, onPointerDown: keepFocusHere,
          onClick: (e) => { keepFocusHere(e); setShowLog(!showLog); load() },
        }, showLog ? '收起日志' : '守卫日志'),
        rep !== null && rep.ledger !== null && rep.ledger !== undefined
          ? h('span', { style: Object.assign({}, s.mono, { opacity: 0.55 }) },
            '上次启动 pid=' + String(rep.ledger.pid))
          : null,
      ),
      showLog
        ? h('div', {
          style: {
            maxHeight: 180, overflowY: 'auto', overflowX: 'hidden',
            border: '1px solid ' + C.line, borderRadius: 8, padding: '6px 8px',
            fontFamily: mono, fontSize: 10, lineHeight: 1.5, opacity: 0.8,
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          },
        }, logLines.length > 0 ? logLines.join('\n') : '(还没有日志)')
        : null,
    )
  }

  function Workbench(props) {
    const { host, ssh, error, refresh } = useYouyuState()
    const live = ssh.connections.length
    const getSvc = props && typeof props.getSvc === 'function' ? props.getSvc : undefined
    const enterSessionRef = useRef(null)

    // 进面板前记下当前会话；离开时还原。
    // 不还原的话，回到对话页会走 uiWorkspace 的初始恢复逻辑，
    // 自动挑「最近工作区的第一个会话」——看起来就像被强行切了会话。
    if (enterSessionRef.current === null && typeof getSvc === 'function') {
      // 当前会话记在 uiWorkspace.selection（一个持久化的 snapshot store，
      // 落盘名 dsh.sessions.current）。先读它，再退回 sessions 上的同名 store。
      const readFrom = (owner) => {
        const sel = owner !== undefined && owner !== null ? owner.selection : undefined
        if (sel === undefined || sel === null || typeof sel.getSnapshot !== 'function') return ''
        const snap = sel.getSnapshot()
        return snap !== null && snap !== undefined && typeof snap.sessionId === 'string' ? snap.sessionId : ''
      }
      try {
        let id = readFrom(getSvc('uiWorkspace'))
        if (id.length === 0) id = readFrom(getSvc('sessions'))
        if (id.length > 0) enterSessionRef.current = id
      } catch (e) { /* 忽略 */ }
    }

    useEffect(() => () => {
      suppressImeBurst()
      const id = enterSessionRef.current
      if (id === null || typeof getSvc !== 'function') return
      try {
        const uiWs = getSvc('uiWorkspace')
        if (uiWs !== undefined && uiWs !== null && typeof uiWs.openSession === 'function') uiWs.openSession(id)
      } catch (e) { /* 忽略 */ }
    }, [])

    const goBack = () => {
      // 对话页会自己把焦点塞回编辑器，这里先起一段压制，再切视图。
      suppressImeBurst()
      try {
        const layout = typeof getSvc === 'function' ? getSvc('layout') : undefined
        if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
          layout.selectPanel(null)
          return
        }
      } catch (e) { /* 忽略 */ }
      try {
        const uiWs = typeof getSvc === 'function' ? getSvc('uiWorkspace') : undefined
        if (uiWs !== undefined && uiWs !== null && typeof uiWs.openSession === 'function'
          && enterSessionRef.current !== null) uiWs.openSession(enterSessionRef.current)
      } catch (e) { /* 忽略 */ }
    }
    const thirdParty = host && host.bundles ? host.bundles.filter((b) => b.indexOf('@deepseek-ai/') !== 0) : []

    return h('div', {
      style: Object.assign({}, s.wrap, {
        padding: 12, width: '100%', maxWidth: '100%', margin: 0,
        boxSizing: 'border-box', minWidth: 0,
        height: '100%', overflowY: 'auto', overflowX: 'hidden',
      }),
    },
      h('div', { style: { position: 'relative', padding: '2px 0 10px', textAlign: 'center' } },
        h('div', { style: { fontSize: 17, fontWeight: 800, letterSpacing: 0.2 } }, '有鱼 · 工作台'),
        h('div', { style: Object.assign({}, s.sub, { marginTop: 2 }) }, '运行时事实、插件与远程连接，一处看完。'),
        h('button', {
          style: Object.assign({}, s.btn(false), { position: 'absolute', left: 0, top: 0 }),
          onMouseDown: keepFocusHere,
          onPointerDown: keepFocusHere,
          onClick: (e) => { keepFocusHere(e); goBack() },
        }, '返回'),
        h('button', {
          style: Object.assign({}, s.btn(false), { position: 'absolute', right: 0, top: 0 }),
          onMouseDown: keepFocusHere,
          onPointerDown: keepFocusHere,
          onClick: (e) => { keepFocusHere(e); void refresh() },
        }, '刷新'),
      ),

      error ? h('div', { style: s.err }, error) : null,

      h('div', { style: s.grid2 },
        h(Stat, { label: '核心', value: host && host.coreVersion ? host.coreVersion : '—', hint: host && host.port ? '127.0.0.1:' + host.port : '' }),
        h(Stat, { label: 'Node', value: host && host.node ? host.node : '—', hint: host && host.jitless ? 'jitless · 无 WASM' : '' }),
        h(Stat, { label: '运行时长', value: host && host.startedAt ? fmtAgo(host.startedAt) : '—', hint: host && host.pid ? 'pid ' + host.pid : '' }),
        h(Stat, { label: 'SSH', value: live + ' / ' + ssh.profiles.length, hint: live > 0 ? '已连接' : '未连接' }),
      ),

      h(GuardCard, null),

      h('div', { style: s.panel },
        h('div', { style: s.row },
          h('div', { style: s.title }, '插件'),
          h('span', { style: s.sub }, 'profile 组合里非官方的 bundle'),
        ),
        thirdParty.length > 0
          ? h('div', { style: s.row }, thirdParty.map((b) => h('span', { key: b, style: Object.assign({}, s.mono, { border: '1px solid ' + C.line, borderRadius: 999, padding: '2px 9px', maxWidth: '100%', overflowWrap: 'anywhere' }) }, b)))
          : h('div', { style: s.sub }, '只有官方 bundle。'),
        h('div', { style: Object.assign({}, s.sub, { fontFamily: mono }) },
          '工作区 ' + (host && host.workspace ? host.workspace : '—')),
      ),

      h('div', { style: s.panel },
        h('div', { style: s.title }, 'SSH 服务器'),
        h(ServerAdmin, { ssh: ssh, host: host, refresh: refresh, compact: false }),
      ),

      h('div', { style: s.panel },
        h('div', { style: s.title }, '连接记录'),
        h('div', { style: s.sub }, '最近 20 条，只记动作与结果，不含任何凭据。'),
        h(AuditTable, { audit: ssh.audit }),
      ),
    )
  }

  // ------------------------------------------------------------ settings tab
  function SettingsTab() {
    const { host, ssh, error, refresh } = useYouyuState()
    return h('div', { style: s.wrap },
      h('div', { style: s.sub }, 'youyudshm 0.1.0 · 左侧导航栏面板 + 输入区状态条 + SSH 管理，都在这一个插件里。'),
      error ? h('div', { style: s.err }, error) : null,
      h('div', { style: s.panel },
        h('div', { style: s.title }, '运行时'),
        h('div', { style: s.grid2 },
          h(Stat, { label: '核心版本', value: host && host.coreVersion ? host.coreVersion : '—' }),
          h(Stat, { label: '端口', value: host && host.port ? String(host.port) : '—' }),
          h(Stat, { label: '平台', value: host && host.platform ? host.platform : '—' }),
          h(Stat, { label: 'bundle 数', value: host && host.bundles ? String(host.bundles.length) : '—' }),
        ),
      ),
      h('div', { style: s.panel },
        h('div', { style: s.title }, 'SSH 服务器'),
        h(ServerAdmin, { ssh: ssh, host: host, refresh: refresh, compact: true }),
      ),
      h('div', { style: s.panel },
        h('div', { style: s.title }, '连接记录'),
        h(AuditTable, { audit: ssh.audit }),
      ),
    )
  }

  // ---------------------------------------------------------------- style
  const STYLE_ID = 'youyudshm-ui-style'
  const CSS = [
    ':root{',
    '--dsw-radius-sm:4px;--dsw-radius-md:6px;--dsw-radius-lg:8px;--dsw-radius-xl:12px;',
    '--dsh-content-font-size:13px;--dsh-content-font-size-secondary:11.5px;',
    '--ds-font-family-code:ui-monospace,"SF Mono",Menlo,Consolas,monospace;',
    '}',
    'button{transition:background-color .16s ease,border-color .16s ease,color .16s ease,',
    'transform .08s ease,opacity .16s ease,box-shadow .16s ease}',
    'button:active:not(:disabled){transform:scale(.975)}',
    'button:disabled{opacity:.45;transform:none}',
    'button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,' + ACCENT + ');outline-offset:2px}',
    '[class*="card"],[class*="row"],[class*="item"]{transition:background-color .16s ease,border-color .16s ease}',
    'pre{border-radius:8px}',
    'pre code{font-size:11.5px;line-height:1.55}',
    '::-webkit-scrollbar{width:7px;height:7px}',
    '::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.35));border-radius:4px}',
    '::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.55))}',

    /* 输入框上方的一排小按钮，同一套观感 */
    '.yy-chip{display:inline-flex;align-items:center;gap:5px;cursor:pointer;',
    'max-width:calc(50vw - 18px);min-width:0;flex:0 1 auto;',
    'padding:2px 8px;border-radius:8px;border:1px solid ' + C.line + ';background:transparent;',
    'color:inherit;font-size:10.5px;line-height:1.45;font-family:' + mono + ';',
    'transition:background-color .18s ease,border-color .18s ease,box-shadow .18s ease,transform .08s ease}',
    '.yy-chip:hover{background:' + C.hover + ';border-color:rgba(127,127,127,.45)}',
    '.yy-chip[data-open="1"]{background:' + C.on + ';border-color:' + C.onLine + '}',
    '.yy-chip:active{transform:scale(.97)}',
    '.yy-chip .yy-ico{flex:0 0 auto;opacity:.7;transition:opacity .18s ease}',
    '.yy-chip[data-open="1"] .yy-ico,.yy-chip:hover .yy-ico{opacity:1}',
    '.yy-chip .yy-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:600}',
    '.yy-chip .yy-chev{transition:transform .2s cubic-bezier(.22,.61,.36,1);opacity:.5;flex:0 0 auto}',
    '.yy-chip[data-open="1"] .yy-chev{transform:rotate(180deg);opacity:.8}',
    '.yy-chip .yy-bars rect{transition:opacity .2s ease,fill .2s ease}',
    '.yy-chip .yy-bars rect[data-on="0"]{opacity:.28}',

    /* 弹层 */
    '@keyframes yy-pop{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}',
    '.yy-pop{animation:yy-pop .18s cubic-bezier(.22,.61,.36,1);transform-origin:bottom left}',

    /* 滑块 */
    '.yy-range{-webkit-appearance:none;appearance:none;width:100%;height:20px;background:transparent;',
    'cursor:pointer;margin:0;display:block}',
    '.yy-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;',
    'background:linear-gradient(to right,',
    'var(--yy-accent,' + ACCENT + ') 0,var(--yy-accent,' + ACCENT + ') var(--yy-pct,0%),',
    'var(--yy-line,#d8d8d8) var(--yy-pct,0%),var(--yy-line,#d8d8d8) 100%)}',
    '.yy-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;',
    'border-radius:50%;background:#fff;border:2px solid var(--yy-accent,' + ACCENT + ');margin-top:-5px;',
    'transition:transform .14s cubic-bezier(.22,.61,.36,1),box-shadow .18s ease}',
    '.yy-range:hover::-webkit-slider-thumb{box-shadow:0 0 0 5px rgba(47,129,247,.12)}',
    '.yy-range:active::-webkit-slider-thumb{transform:scale(1.15);box-shadow:0 0 0 8px rgba(47,129,247,.16)}',
    '.yy-range:focus-visible{outline:none}',

    /* 隐藏输入框内的官方「模型 + 强度」座位：功能已经在上方芯片里。
       ModelSelect 的根节点类名带 CSS Modules 哈希（_7KE1Ra_root），这里按前缀匹配；
       同一个按钮同时显示模型名与档位，隐藏它就等于两样都收起来。 */
    '[class*="_7KE1Ra_root"]{display:none !important}',

    /* 列表行 */
    '.yy-row{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;',
    'padding:5px 7px;border:none;border-radius:7px;background:transparent;color:inherit;',
    'cursor:pointer;text-align:left;font-size:11.5px;font-family:inherit;min-width:0;',
    'transition:background-color .14s ease}',
    '.yy-row:hover{background:' + C.hover + '}',
    '.yy-row[data-on="1"]{background:' + C.on + '}',
    '.yy-row .yy-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.yy-row .yy-sub{flex:0 0 auto;font-size:9.5px;opacity:.5;max-width:45%;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '.yy-row .yy-tick{flex:0 0 auto;opacity:0;transition:opacity .14s ease}',
    '.yy-row[data-on="1"] .yy-tick{opacity:1}',

    '@media (prefers-reduced-motion: reduce){button,.yy-pop{transition:none;animation:none}',
    'button:active:not(:disabled){transform:none}}',
  ].join('')

  function installStyle() {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID) !== null) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = CSS
    document.head.appendChild(el)
  }

  // ---------------------------------------------------------------- icons
  const ICON = {
    effort: (idx) => h('svg', {
      className: 'yy-bars yy-ico', width: 10, height: 10, viewBox: '0 0 11 11', 'aria-hidden': 'true',
    }, [0, 1, 2].map((i) => h('rect', {
      key: String(i), x: 0.5 + i * 3.6, y: 8 - i * 3, width: 2.2, height: 3 + i * 3, rx: 1,
      fill: i <= idx ? ACCENT : C.dim, 'data-on': i <= idx ? '1' : '0',
    }))),
    model: () => h('svg', {
      className: 'yy-ico', width: 10, height: 10, viewBox: '0 0 12 12', 'aria-hidden': 'true',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
    },
      h('path', { d: 'M6 1.6 10.4 4 6 6.4 1.6 4z' }),
      h('path', { d: 'M1.6 6.6 6 9l4.4-2.4' }),
      h('path', { d: 'M1.6 9.1 6 11.5l4.4-2.4' }),
    ),
    coin: () => h('svg', {
      className: 'yy-ico', width: 10, height: 10, viewBox: '0 0 12 12', 'aria-hidden': 'true',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
    },
      h('circle', { cx: 6, cy: 6, r: 4.4 }),
      h('path', { d: 'M6 3.6v4.8M4.6 5.1h2.2a1 1 0 0 1 0 2H4.9a1 1 0 0 0 0 2h2.3' }),
    ),
  }

  const CHEV = h('svg', {
    className: 'yy-chev', width: 8, height: 8, viewBox: '0 0 8 8', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M1.2 3.1 4 5.9 6.8 3.1', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))

  const TICK = h('svg', {
    className: 'yy-tick', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M1.5 5.2 4 7.6 8.6 2.6', fill: 'none', stroke: ACCENT,
    strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))

  /** 钱包数组 → `¥0.79` / `$1.00` / `¥0.79 / $1.00`；空数组 → `—`。 */
  function formatWallets(wallets) {
    if (!Array.isArray(wallets) || wallets.length === 0) return '—'
    const parts = wallets.map((w) => {
      const n = Number(w && w.balance)
      const shown = Number.isFinite(n) ? n.toFixed(2) : String(w && w.balance)
      return (w && w.currency === 'CNY' ? '¥' : '$') + shown
    })
    return parts.join(' / ')
  }

  function ComposerMenu(props) {
    const sessionId = props ? props.sessionId : undefined
    const getModels = props ? props.getModels : undefined
    const getSvc = props ? props.getSvc : undefined
    const svc = useCallback((name) => (typeof getSvc === 'function' ? getSvc(name) : undefined), [getSvc])

    // ---- 模型服务（可能晚就绪）
    const [, setTick] = useState(0)
    useEffect(() => {
      if (typeof getModels !== 'function') return undefined
      if (getModels() !== undefined && getModels() !== null) return undefined
      let n = 0
      const id = setInterval(() => {
        n += 1
        if (getModels() !== undefined && getModels() !== null) { clearInterval(id); setTick((v) => v + 1) }
        else if (n > 20) { clearInterval(id) }
      }, 500)
      return () => clearInterval(id)
    }, [getModels])

    const models = typeof getModels === 'function' ? getModels() : undefined

    let directoryObj
    let directory
    if (models !== undefined && models !== null && typeof models.directoryFor === 'function') {
      try {
        const d = models.directoryFor(sessionId)
        directoryObj = d !== null && d !== undefined ? d : undefined
        directory = directoryObj !== undefined ? directoryObj.store : undefined
      } catch (e) { directoryObj = undefined; directory = undefined }
    }

    const state = useSyncExternalStore(
      useCallback((notify) => (directory !== undefined && directory !== null
        && typeof directory.subscribe === 'function' ? directory.subscribe(notify) : () => {}), [directory]),
      useCallback(() => (directory !== undefined && directory !== null
        && typeof directory.getSnapshot === 'function'
        ? directory.getSnapshot() : { current: null, groups: [] }), [directory]),
    )

    // ---- 余额（充值 / 赠送）。宿主侧同一份账户接口，60 秒刷一次。
    const [balance, setBalance] = useState({ recharge: '—', bonus: '—', ok: false })
    const verRef = useRef('0.2.1-rc.5')

    // 版本号必须非空，否则账户接口直接拒绝；优先按当前核心版本取，取不到用兜底值。
    useEffect(() => {
      let alive = true
      const readVersion = () => {
        if (typeof fetch !== 'function') return
        fetch('/plugins/youyudshm/state', { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!alive || d === null || d === undefined) return
            const v = String(d.coreVersion || '').split('+')[0]
            if (v.length > 0) verRef.current = v
          })
          .catch(() => {})
      }
      readVersion()
      return () => { alive = false }
    }, [])

    useEffect(() => {
      let alive = true
      const load = () => {
        if (!alive) return
        try {
          // account 可能是独立子服务（remote.account），也可能挂在 remote 上；两条都试。
          let account
          try { account = svc('remote.account') } catch (e) { account = undefined }
          if (account === undefined || account === null) {
            try {
              const remote = svc('remote')
              account = remote !== undefined && remote !== null ? remote.account : undefined
            } catch (e) { account = undefined }
          }
          if (account === undefined || account === null || typeof account.getBalance !== 'function') {
            log('balance', 'account 服务不可用')
            return
          }
          let locale = 'zh-CN'
          try {
            const loc = svc('locale')
            const snap = loc !== undefined && loc !== null && typeof loc.getSnapshot === 'function' ? loc.getSnapshot() : null
            if (snap !== null && typeof snap.active === 'string' && snap.active.length > 0) locale = snap.active
          } catch (e) { /* 忽略 */ }
          account.getBalance({
            version: verRef.current,
            locale: locale,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }).then((result) => {
            if (!alive) return
            const value = result !== undefined && result !== null && result.ok === true ? result.value : null
            if (value !== null && value !== undefined && value.status === 'ready') {
              setBalance({
                recharge: formatWallets(value.value),
                bonus: formatWallets(value.bonusWallets),
                ok: true,
              })
            } else {
              setBalance({ recharge: '—', bonus: '—', ok: false })
              log('balance', 'not-ready', String(value !== null && value !== undefined ? value.status : value))
            }
          }).catch((err) => { log('balance', 'rejected: ' + String(err && err.message ? err.message : err)) })
        } catch (e) { /* 忽略 */ }
      }
      load()
      const id = setInterval(load, 60000)
      return () => { alive = false; clearInterval(id) }
    }, [svc])

    useEffect(() => {
      if (directoryObj !== undefined && directoryObj !== null && typeof directoryObj.load === 'function') {
        try { directoryObj.load().catch(() => {}) } catch (e) { /* 忽略 */ }
      }
    }, [directoryObj])

    // ---- 交互状态
    const [openKey, setOpenKey] = useState(null)
    const [drag, setDrag] = useState(null)
    const [confirmPerm, setConfirmPerm] = useState(null)
    const [pos, setPos] = useState(null)
    const [inset, setInset] = useState(null)

    const wrapRef = useRef(null)
    const rowRef = useRef(null)
    const btnRefs = useRef({})
    const timer = useRef(null)
    const shownRef = useRef(0)
    const lastInsetRef = useRef(null)

    useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

    // 与输入框圆角线对齐：从可编辑元素往上找「有圆角且有边框或背景」的那个框。
    useEffect(() => {
      let alive = true
      const findEditable = () => {
        try {
          const list = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""],input[type="text"]')
          for (let i = 0; i < list.length; i++) {
            const el = list[i]
            const r = el.getBoundingClientRect()
            if (r.width > 60 && r.height > 0) return el
          }
        } catch (e) { /* 忽略 */ }
        return null
      }
      const roundedBoxOf = (el) => {
        let node = el
        let loose = null
        for (let i = 0; i < 8 && node !== null && node !== undefined; i++) {
          try {
            const cs = window.getComputedStyle(node)
            const rad = parseFloat(cs.borderTopLeftRadius) || 0
            if (rad > 0) {
              const bw = parseFloat(cs.borderLeftWidth) || 0
              const bg = String(cs.backgroundColor || '')
              const hasBg = bg.length > 0 && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)'
              if (bw > 0 || hasBg) return node
              if (loose === null) loose = node
            }
          } catch (e) { /* 忽略 */ }
          node = node.parentElement
        }
        return loose
      }
      const measure = () => {
        if (!alive) return
        const wrap = wrapRef.current
        if (wrap === null || typeof wrap.getBoundingClientRect !== 'function') return
        const editable = findEditable()
        if (editable === null) {
          if (lastInsetRef.current !== -1) { lastInsetRef.current = -1; log('inset', 'no-input-found') }
          return
        }
        const box = roundedBoxOf(editable)
        const target = box !== null && box !== undefined ? box : editable
        const a = wrap.getBoundingClientRect()
        const d = Math.round(target.getBoundingClientRect().left - a.left)
        if (lastInsetRef.current !== d) {
          lastInsetRef.current = d
          log('inset', 'd=' + d, 'tag=' + String(target.tagName),
            'cls=' + String(target.className || '').slice(0, 40),
            'box=' + String(box !== null && box !== undefined))
        }
        if (d >= -40 && d < 240) setInset((prev) => (prev === d ? prev : d))
      }
      measure()
      const id = setInterval(measure, 800)
      return () => { alive = false; clearInterval(id) }
    }, [])

    // 兜底：核心升级后 CSS Modules 哈希会变，按 aria 语义再找一遍输入框里的
    // 「模型 + 强度」座位并隐藏。只在输入框所在的那一层里找，避免误伤设置页等别处控件。
    useEffect(() => {
      let alive = true
      const hide = () => {
        if (!alive || typeof document === 'undefined') return
        try {
          let editable = null
          const edits = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""]')
          for (let i = 0; i < edits.length; i++) {
            const r = edits[i].getBoundingClientRect()
            if (r.width > 60 && r.height > 0) { editable = edits[i]; break }
          }
          if (editable === null) return
          // 输入框往上 5 层，就是 composer 那一块。
          let scope = editable
          for (let i = 0; i < 5 && scope !== null && scope !== undefined; i++) scope = scope.parentElement
          if (scope === null || scope === undefined) return
          const list = scope.querySelectorAll('button[aria-haspopup="menu"]')
          for (let i = 0; i < list.length; i++) {
            const el = list[i]
            const label = String(el.getAttribute('aria-label') || '')
            if (!/模型|强度|model|reasoning|effort/i.test(label)) continue
            const host = el.parentElement
            if (host === null || host === undefined) continue
            if (host.dataset.yyHidden === '1') continue
            host.dataset.yyHidden = '1'
            host.style.setProperty('display', 'none', 'important')
          }
        } catch (e) { /* 忽略 */ }
      }
      hide()
      const id = setInterval(hide, 1500)
      return () => { alive = false; clearInterval(id) }
    }, [])

    // 点外面关掉
    useEffect(() => {
      if (openKey === null) return undefined
      const onDown = (e) => {
        const t = e.target
        if (rowRef.current !== null && rowRef.current.contains(t)) return
        if (t && t.closest && t.closest('.yy-pop')) return
        setOpenKey(null); setConfirmPerm(null)
      }
      document.addEventListener('mousedown', onDown)
      return () => document.removeEventListener('mousedown', onDown)
    }, [openKey])

    const groups = state && Array.isArray(state.groups) ? state.groups : []
    const current = state ? state.current : null

    const effortNow = current !== null && current !== undefined && current.reasoningEffort !== undefined
      ? String(current.reasoningEffort) : 'default'
    useEffect(() => {
      log('state', 'models=' + (models !== undefined && models !== null),
        'store=' + (directory !== undefined && directory !== null),
        'groups=' + groups.length,
        'current=' + (current === null || current === undefined ? 'null' : String(current.model)),
        'effort=' + effortNow,
        'bal=' + balance.recharge + '/' + balance.bonus,
        'session=' + String(sessionId))
    }, [models, directory, groups.length,
      current === null || current === undefined ? 'null' : String(current.model),
      effortNow, balance.recharge, balance.bonus, sessionId])

    let model = null
    let providerName = ''
    if (current !== null && current !== undefined) {
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i]
        const ms = Array.isArray(g.models) ? g.models : []
        for (let j = 0; j < ms.length; j++) {
          if (ms[j].id === current.model && g.id === current.provider) {
            model = ms[j]; providerName = String(g.name || g.id || ''); break
          }
        }
        if (model !== null) break
      }
    }

    const reasoning = model !== null && model.reasoning ? model.reasoning : null
    const efforts = reasoning !== null && Array.isArray(reasoning.efforts) ? reasoning.efforts : []

    const effective = current !== null && current !== undefined && current.reasoningEffort !== undefined
      && current.reasoningEffort !== null
      ? current.reasoningEffort
      : (reasoning !== null && reasoning.defaultEffort !== undefined ? reasoning.defaultEffort : undefined)
    let index = efforts.findIndex((e) => e.id === effective)
    if (index < 0) index = 0

    useEffect(() => {
      if (drag === null) return
      const target = efforts[Math.round(drag)]
      if (target !== undefined && target.id === effective) {
        if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
        setDrag(null)
      }
    }, [drag, effective, efforts.length])

    const dismissIme = () => {
      try {
        const el = document.activeElement
        if (el !== null && el !== undefined && typeof el.blur === 'function') el.blur()
      } catch (e) { /* 忽略 */ }
    }
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); dismissIme() }

    const pad = inset !== null ? inset : 0

    const openPanel = (key, width) => {
      const node = btnRefs.current[key]
      const vw = window.innerWidth
      const w = Math.min(width, Math.round(vw * 0.86))
      let next = { left: 8, width: w, bottom: 96 }
      if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function') {
        const r = node.getBoundingClientRect()
        next = {
          left: Math.min(Math.max(8, Math.round(r.left)), Math.max(8, vw - w - 8)),
          width: w,
          bottom: Math.max(8, Math.round(window.innerHeight - r.top + 6)),
        }
      }
      setPos(next)
      setConfirmPerm(null)
      setOpenKey(key)
    }

    const togglePanel = (key, width) => {
      if (openKey === key) { setOpenKey(null); setConfirmPerm(null) } else { openPanel(key, width) }
    }

    const panelStyle = {
      position: 'fixed',
      left: pos !== null ? pos.left : 8,
      width: pos !== null ? pos.width : 240,
      bottom: pos !== null ? pos.bottom : 96,
      zIndex: 60,
      display: 'grid', gap: 0, boxSizing: 'border-box',
      padding: 6,
      border: '1px solid ' + C.line, borderRadius: 12,
      background: C.bg, boxShadow: '0 12px 32px rgba(0,0,0,.16)',
      maxHeight: '48vh', overflowY: 'auto', overflowX: 'hidden',
    }

    const setRef = (key) => (node) => { btnRefs.current[key] = node }

    // ---- 触发器：四块共用一套外观
    const chip = (key, icon, label, title, width) => h('button', {
      type: 'button',
      ref: setRef(key),
      className: 'yy-chip',
      'data-open': openKey === key ? '1' : '0',
      title: title,
      onMouseDown: stop,
      onPointerDown: stop,
      onClick: (e) => {
        e.preventDefault(); e.stopPropagation(); dismissIme()
        togglePanel(key, width)
      },
    }, icon, h('span', { className: 'yy-label' }, label), CHEV)

    // ---- 强度
    const shown = drag !== null ? drag : index
    const shownIdx = Math.max(0, Math.min(Math.max(efforts.length - 1, 0), Math.round(shown)))
    const effortLabel = efforts[shownIdx] !== undefined ? efforts[shownIdx].name : '—'
    const pct = efforts.length > 1 ? (shown / (efforts.length - 1)) * 100 : 0
    shownRef.current = shownIdx

    const commitEffort = (value) => {
      const target = efforts[value]
      if (target === undefined) return
      try {
        models.directoryFor(sessionId).select({
          provider: current.provider, model: current.model, reasoningEffort: target.id,
        })
      } catch (e) { /* 忽略 */ }
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setDrag(null), 1200)
    }

    const effortPanel = openKey === 'effort' ? h('div', {
      className: 'yy-pop', onMouseDown: stop, onPointerDown: stop,
      onClick: (e) => e.stopPropagation(),
      style: Object.assign({}, panelStyle, { padding: '11px 13px 10px', gap: 7 }),
    },
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontSize: 11, fontWeight: 600, letterSpacing: 0.2, whiteSpace: 'nowrap' } }, '推理强度'),
        h('span', {
          style: {
            fontFamily: mono, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: drag !== null ? ACCENT : 'inherit', transition: 'color .16s ease',
          },
        }, effortLabel),
      ),
      efforts.length >= 2 ? h('input', {
        className: 'yy-range',
        type: 'range', min: 0, max: efforts.length - 1, step: 'any', value: shown,
        'aria-label': '推理强度',
        style: { '--yy-pct': pct + '%' },
        onChange: (e) => setDrag(Number(e.target.value)),
        onPointerUp: () => commitEffort(shownRef.current),
        onPointerCancel: () => commitEffort(shownRef.current),
        onMouseUp: () => commitEffort(shownRef.current),
        onTouchEnd: () => commitEffort(shownRef.current),
        onKeyUp: () => commitEffort(shownRef.current),
      }) : h('div', { style: { fontSize: 10.5, opacity: 0.6 } }, '该模型不提供推理档位'),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 9.5, opacity: 0.5, gap: 8 } },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          efforts[0] !== undefined ? efforts[0].name : ''),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          efforts[efforts.length - 1] !== undefined ? efforts[efforts.length - 1].name : ''),
      ),
    ) : null

    // ---- 模型
    const modelLabel = model !== null && model.name ? String(model.name)
      : (current !== null && current !== undefined ? String(current.model).split(':').pop() : '模型')

    const commitModel = (provider, modelId, reasoningEffort) => {
      try {
        const sel = { provider: provider, model: modelId }
        if (reasoningEffort !== undefined && reasoningEffort !== null) sel.reasoningEffort = reasoningEffort
        models.directoryFor(sessionId).select(sel)
      } catch (e) { /* 忽略 */ }
    }

    const modelRows = []
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      const ms = Array.isArray(g.models) ? g.models : []
      if (ms.length === 0) continue
      modelRows.push(h('div', {
        key: 'g-' + String(g.id),
        style: {
          fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase', opacity: 0.5,
          padding: '6px 7px 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }, String(g.name || g.id || '')))
      for (let mi = 0; mi < ms.length; mi++) {
        const m = ms[mi]
        const on = current !== null && current !== undefined
          && m.id === current.model && g.id === current.provider
        modelRows.push(h('button', {
          key: String(g.id) + '/' + String(m.id),
          type: 'button', className: 'yy-row', 'data-on': on ? '1' : '0',
          title: String(m.name || m.id),
          onMouseDown: stop, onPointerDown: stop,
          onClick: (e) => {
            e.preventDefault(); e.stopPropagation()
            const eff = m.reasoning && m.reasoning.defaultEffort !== undefined ? m.reasoning.defaultEffort : undefined
            commitModel(g.id, m.id, eff)
            setOpenKey(null)
          },
        },
          h('span', { className: 'yy-name' }, String(m.name || m.id)),
          TICK,
        ))
      }
    }

    const modelPanel = openKey === 'model' ? h('div', {
      className: 'yy-pop', onMouseDown: stop, onPointerDown: stop,
      onClick: (e) => e.stopPropagation(),
      style: panelStyle,
    },
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '3px 7px 5px' } },
        h('span', { style: { fontSize: 11, fontWeight: 600, letterSpacing: 0.2, whiteSpace: 'nowrap' } }, '模型'),
        h('span', {
          style: { fontFamily: mono, fontSize: 10, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, providerName),
      ),
      modelRows.length > 0 ? modelRows : h('div', { style: { fontSize: 10.5, opacity: 0.6, padding: '6px 7px' } }, '没有可用模型'),
    ) : null

    // ---- 余额面板
    const balanceRow = (name, value, strong) => h('div', {
      style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '5px 7px' },
    },
      h('span', { style: { fontSize: 10.5, opacity: 0.6, whiteSpace: 'nowrap' } }, name),
      h('span', {
        style: {
          fontFamily: mono, fontSize: strong ? 12.5 : 11.5, fontWeight: strong ? 700 : 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, value),
    )

    const balancePanel = openKey === 'balance' ? h('div', {
      className: 'yy-pop', onMouseDown: stop, onPointerDown: stop,
      onClick: (e) => e.stopPropagation(),
      style: Object.assign({}, panelStyle, { padding: '8px 7px' }),
    },
      balanceRow('充值余额', balance.recharge, true),
      h('div', { style: { height: 1, background: C.line, opacity: 0.6, margin: '2px 7px' } }),
      balanceRow('赠送余额', balance.bonus, false),
      balance.ok ? null
        : h('div', { style: { fontSize: 9.5, opacity: 0.5, padding: '2px 7px 0' } }, '账户余额暂不可读'),
    ) : null

    return h('div', {
      ref: wrapRef,
      style: { display: 'block', width: '100%', paddingLeft: pad, boxSizing: 'border-box' },
    },
      h('div', {
        ref: rowRef,
        style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
      },
        h('div', { style: { position: 'relative', display: 'inline-flex', minWidth: 0 } },
          chip('effort', ICON.effort(shownIdx), effortLabel, '推理强度：' + effortLabel, 236), effortPanel),
        h('div', { style: { position: 'relative', display: 'inline-flex', minWidth: 0 } },
          chip('model', ICON.model(), modelLabel, '模型：' + modelLabel, 268), modelPanel),
        h('div', { style: { position: 'relative', display: 'inline-flex', minWidth: 0 } },
          chip('balance', ICON.coin(), balance.recharge,
            '充值余额 ' + balance.recharge + ' · 赠送 ' + balance.bonus, 220), balancePanel),
      ),
    )
  }

  // ------------------------------------------------------------------- mount
  // 每个注册各自兜住：某个 slot 契约变了，只该退掉这一块，不该拖垮整个 WebUI。
  function guard2(where, fn) {
    try { fn() } catch (cause) {
      if (typeof console !== 'undefined' && console.error) console.error('[youyudshm] ' + where + ' failed:', cause)
    }
  }

  /**
   * 先直接 register；槽还没定义（会抛）再退回 inject。
   *
   * 为什么要两条路：`sidebar.panellist` 是 `sidebar` 注册时声明的 child slot，
   * 对 child slot 用 `inject` 不保证会触发（官方包自己两种写法都用）。
   * 直接 register 在槽已存在时立刻生效，是最短路径。
   */
  function registerSlot(ctx, options, Component, where) {
    try {
      ctx.slots.register(options, Component)
      return
    } catch (first) {
      guard2(where + ' direct', () => { throw first })
    }
    guard2(where + ' inject', () => {
      ctx.slots.inject(options.name, () => guard2(where + ' deferred', () => {
        ctx.slots.register(options, Component)
      }))
    })
  }

  /** 会话标题栏的一个入口：即使左栏图标没出现，也能进工作台。 */
  function HeaderAction() {
    return h('button', {
      type: 'button',
      title: '打开有鱼工作台',
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        padding: '3px 9px', fontSize: 11, fontFamily: mono,
        border: '1px solid ' + C.line, borderRadius: 6, background: 'transparent', color: 'inherit',
      },
      onClick: () => {
        // 点击时再取一次 layout：apply 那一刻服务可能还没就绪。
        const owner = ctxRef.current
        const layout = owner !== null && typeof owner.get === 'function' ? owner.get('layout') : null
        if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') {
          layout.selectPanel(PANEL_ID)
        }
      },
    }, '有鱼')
  }

  // HeaderAction 需要 ctx，但 slot 组件拿不到；用一个模块级引用接住。
  const ctxRef = { current: null }

  function apply(ctx) {
    ctxRef.current = ctx
    guard2('style', () => installStyle())

    registerSlot(ctx, { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => '有鱼' }, PanelIcon, 'sidebar.panellist')
    registerSlot(ctx, {
      name: 'main', key: PANEL_ID,
      inject: () => ({ getSvc: (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined) }),
    }, Workbench, 'main')
    registerSlot(ctx, {
      name: 'conversation.input.right', id: PANEL_ID, order: 30,
      inject: (sessionId) => ({ sessionId: sessionId }),
    }, SshSelect, 'conversation.input.right')
    registerSlot(ctx, { name: 'settings.plugins.tab', id: PANEL_ID, order: 45, label: '有鱼', inject: () => ({}) }, SettingsTab, 'settings.plugins.tab')
    registerSlot(ctx, { name: 'conversation.session.header.actions', id: PANEL_ID, order: 60 }, HeaderAction, 'conversation.session.header.actions')

    // 输入框上方那排芯片要 modelDirectories，但注册本身只依赖 slots。
    // 服务在组件里按需解析（ctx.get），拿不到就重试，绝不阻塞注册。
    registerSlot(ctx, {
      name: 'conversation.input.dock',
      id: PANEL_ID,
      order: 25,
      inject: (sessionId) => ({
        sessionId: sessionId,
        getModels: () => (typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined),
        getSvc: (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined),
      }),
    }, ComposerMenu, 'conversation.input.dock')
  }

  module.exports = {
    name: 'youyudshm-client',
    inject: ['slots'],
    apply: apply,
  }
  return module.exports
} })
