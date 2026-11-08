/**
 * youyudshm —— 宿主侧。
 *
 * 四件事：
 *   1. GET  /plugins/youyudshm/state             运行时事实 + 已存密码的服务器 + 每个会话勾选的服务器
 *   2. POST /plugins/youyudshm/credentials       保存/清除某台服务器的密码（0600）
 *   3. POST /plugins/youyudshm/session           设置某个会话可以使用的服务器（勾选框）
 *   4. POST /plugins/youyudshm/connect           用保存的密码去连（转调 dsh-ssh-servers 的 /connect）
 *      工具 ssh_connect + 一条 tools.guard()：本会话没勾选的服务器，ssh_* 一律拒绝。
 *
 * 刻意不做的事：不实现 SSH 传输层。连接状态与 ssh2 会话都在 dsh-ssh-servers 那一行里。
 *
 * 另外两个端点负责「防砖」：
 *   GET  /plugins/youyudshm/guard          守卫状态 + 日志尾部 + 被隔离的 profile
 *   POST /plugins/youyudshm/guard/install  安装 / 修复启动守卫（给核心入口加钩子）
 *   POST /plugins/youyudshm/guard/rollback 回滚守卫
 *   POST /plugins/youyudshm/repair         顺手把 ssh2 的 WASM poly1305 换成纯 JS 版
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import * as guard from './guard.js'
import * as polyfill from './ssh2-polyfill.js'

export const name = 'youyudshm'

export const inject = []

const PREFIX = '/plugins/youyudshm'
const SSH_PREFIX = '/plugins/dsh-ssh-servers'
const GLOBAL_SESSION = '__global'

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

function homeDir() {
  const h = process.env.DSH_HOME || ''
  return typeof h === 'string' ? h : ''
}

function dataDir() {
  return path.join(homeDir(), 'youyudshm')
}

function writeJsonAtomic(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode === undefined ? {} : { mode: mode })
  fs.renameSync(tmp, file)
  if (mode !== undefined) {
    try { fs.chmodSync(file, mode) } catch (e) { /* 平台不支持就算了 */ }
  }
}

// ------------------------------------------------------------------ 密码保管
function vaultFile() { return path.join(dataDir(), 'credentials.json') }

function readVault() {
  const raw = readJson(vaultFile())
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of Object.keys(raw)) if (typeof raw[key] === 'string') out[key] = raw[key]
  return out
}

function writeVault(vault) { writeJsonAtomic(vaultFile(), vault, 0o600) }

// -------------------------------------------------------------- 会话授权表
function sessionFile() { return path.join(dataDir(), 'session-servers.json') }

/** { [sessionId]: string[] } —— 内存副本，供同步守卫读。 */
const allowCache = { map: null }

function loadAllow() {
  if (allowCache.map !== null) return allowCache.map
  const raw = readJson(sessionFile())
  const map = {}
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw)) {
      if (Array.isArray(raw[key])) map[key] = raw[key].filter((v) => typeof v === 'string')
    }
  }
  allowCache.map = map
  return map
}

function writeAllow(map) {
  allowCache.map = map
  writeJsonAtomic(sessionFile(), map)
}

function allowFor(sessionId) {
  const map = loadAllow()
  const key = sessionId && String(sessionId).length > 0 ? String(sessionId) : GLOBAL_SESSION
  const list = map[key]
  return Array.isArray(list) ? list : []
}

// ---------------------------------------------------------------- 服务器缓存
/** 供同步守卫把「名称/地址」解析成 id。由 /state 与 /connect 顺带刷新。 */
const profileCache = { list: [] }

function profileById(id) {
  const needle = String(id || '').toLowerCase()
  return profileCache.list.find((p) => String(p.id).toLowerCase() === needle)
}

function matchProfile(wanted) {
  const needle = String(wanted || '').trim().toLowerCase()
  if (needle.length === 0) return undefined
  return profileCache.list.find((p) => String(p.id).toLowerCase() === needle)
    || profileCache.list.find((p) => String(p.label || '').toLowerCase() === needle)
    || profileCache.list.find((p) => String(p.host || '').toLowerCase() === needle)
}

// -------------------------------------------------------------------- 事实
function snapshot() {
  const home = homeDir()
  const ready = home ? readJson(path.join(home, 'host-ready.json')) : null
  const runtime = ready && ready.runtime ? ready.runtime : null
  const profile = home ? readJson(path.join(home, 'profiles', 'ondevice', 'package.json')) : null
  const bundles = profile && profile.dsh && profile.dsh.profile && Array.isArray(profile.dsh.profile.bundles)
    ? profile.dsh.profile.bundles : []
  const deps = profile && profile.dependencies && typeof profile.dependencies === 'object'
    ? Object.keys(profile.dependencies) : []
  let coreVersion = ''
  const core = (process.env.DSHM_CORE_DIR || '').trim()
  if (core.length > 0) {
    const parts = core.split('/')
    coreVersion = parts[parts.length - 1] || ''
  }
  return {
    pid: ready && ready.pid !== undefined ? ready.pid : null,
    port: ready && ready.port !== undefined ? ready.port : null,
    startedAt: ready && ready.startedAt ? ready.startedAt : '',
    workspace: ready && ready.workspace ? ready.workspace : '',
    coreVersion: coreVersion,
    profile: ready && ready.profile ? ready.profile : 'ondevice',
    node: runtime && runtime.nodeVersion ? runtime.nodeVersion : '',
    platform: runtime && runtime.platform ? runtime.platform : '',
    jitless: runtime && runtime.jitless === true,
    listen: runtime && runtime.listenAddress ? runtime.listenAddress : '',
    bundles: bundles,
    dependencies: deps,
    savedCredentials: Object.keys(readVault()),
    sessionServers: loadAllow(),
    now: Date.now(),
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req, limit) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 转调宿主自己的 webServer：loopback、不带 Origin，正好过 dsh-ssh-servers 的门。 */
function callSelf(method, urlPath, body) {
  return new Promise((resolve) => {
    const port = Number(process.env.DSHM_PORT || '3120')
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method, timeout: 20000,
      headers: payload === null
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = JSON.parse(text) } catch (e) { parsed = null }
        resolve({ status: res.statusCode || 0, json: parsed, text: text })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('转发超时')) })
    req.on('error', (e) => resolve({ status: 0, json: null, text: String((e && e.message) || e) }))
    if (payload !== null) req.write(payload)
    req.end()
  })
}

async function refreshProfiles() {
  const state = await callSelf('GET', SSH_PREFIX + '/state')
  const list = state.json && Array.isArray(state.json.profiles) ? state.json.profiles : []
  profileCache.list = list
  return list
}

/** 按 id / 名称 / 地址找服务器（会刷新缓存）。 */
async function findProfile(server) {
  const profiles = await refreshProfiles()
  if (profiles.length === 0) return { error: '还没有保存任何服务器', profiles: profiles }
  if (server === undefined || server === null || String(server).length === 0) {
    if (profiles.length === 1) return { profile: profiles[0], profiles: profiles }
    return { error: '有多台服务器，必须指定 server 参数', profiles: profiles }
  }
  const hit = matchProfile(server)
  if (hit === undefined) return { error: '找不到服务器「' + server + '」', profiles: profiles }
  return { profile: hit, profiles: profiles }
}

async function connectWithVault(profileId) {
  const vault = readVault()
  const password = vault[profileId]
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, note: '这台服务器没有保存密码。在有鱼工作台里给它设一次密码，之后就能直接连。' }
  }
  const result = await callSelf('POST', SSH_PREFIX + '/connect', { profileId: profileId, password: password })
  if (result.status === 200) return { ok: true, note: '已连接' }
  const reason = result.json && result.json.error ? result.json.error : result.text
  return { ok: false, note: String(reason).slice(0, 400) }
}

/** 会话是否有权使用这台服务器（同步，供守卫用）。 */
function sessionMayUse(sessionId, wanted) {
  const allowed = allowFor(sessionId)
  if (allowed.length === 0) return false
  if (wanted === undefined || wanted === null || String(wanted).length === 0) return allowed.length === 1
  const needle = String(wanted).trim().toLowerCase()
  for (const id of allowed) {
    if (String(id).toLowerCase() === needle) return true
    const p = profileById(id)
    if (p !== undefined) {
      if (String(p.label || '').toLowerCase() === needle) return true
      if (String(p.host || '').toLowerCase() === needle) return true
    }
  }
  return false
}

export function apply(ctx) {
  // 首次装载时顺手把守卫装上（幂等；已经装过就只做一次文件比对）。
  // 放在 try 里：它挂了不能影响插件本身，更不能影响启动。
  try {
    const before = guard.status()
    if (!before.healthy) {
      const done = guard.install()
      console.log('[youyudshm] guard install:', done.note)
    }
  } catch (e) {
    console.log('[youyudshm] guard install skipped:', String((e && e.message) || e))
  }

  // ---------------------------------------------------------------- HTTP API
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined || webServer === null) return
    if (typeof webServer.register !== 'function') return

    const handle = async (req, res) => {
      const url = String(req.url || '')
      if (!url.startsWith(PREFIX + '/')) return
      const route = url.slice(PREFIX.length).split('?')[0]
      try {
        if (route === '/state' && req.method === 'GET') {
          await refreshProfiles().catch(() => {})
          json(res, 200, snapshot())
          return
        }

        if (route === '/credentials' && req.method === 'POST') {
          const body = await readBody(req, 64 * 1024)
          const id = String(body.profileId || '')
          const password = typeof body.password === 'string' ? body.password : ''
          if (id.length === 0) { json(res, 400, { error: '缺少 profileId' }); return }
          const vault = readVault()
          if (password.length === 0) delete vault[id]
          else vault[id] = password
          writeVault(vault)
          json(res, 200, { ok: true, saved: password.length > 0 })
          return
        }

        if (route === '/credentials/delete' && req.method === 'POST') {
          const body = await readBody(req, 64 * 1024)
          const vault = readVault()
          delete vault[String(body.profileId || '')]
          writeVault(vault)
          json(res, 200, { ok: true })
          return
        }

        if (route === '/session' && req.method === 'POST') {
          const body = await readBody(req, 64 * 1024)
          const sessionId = String(body.sessionId || GLOBAL_SESSION)
          const ids = Array.isArray(body.profileIds) ? body.profileIds.filter((v) => typeof v === 'string') : []
          const map = Object.assign({}, loadAllow())
          if (ids.length === 0) delete map[sessionId]
          else map[sessionId] = ids
          writeAllow(map)
          json(res, 200, { ok: true, sessionServers: map })
          return
        }

        if (route === '/connect' && req.method === 'POST') {
          const body = await readBody(req, 64 * 1024)
          const found = await findProfile(body.profileId || body.server)
          if (found.error !== undefined) { json(res, 404, { error: found.error }); return }
          const result = await connectWithVault(found.profile.id)
          json(res, result.ok ? 200 : 400, result)
          return
        }

        if (route === '/guard' && req.method === 'GET') {
          json(res, 200, {
            guard: guard.status(),
            report: guard.report(40),
            polyfill: polyfill.status(),
          })
          return
        }

        if (route === '/guard/install' && req.method === 'POST') {
          json(res, 200, { guard: guard.install() })
          return
        }

        if (route === '/guard/rollback' && req.method === 'POST') {
          json(res, 200, { guard: guard.rollback() })
          return
        }

        if (route === '/repair' && req.method === 'POST') {
          json(res, 200, { polyfill: polyfill.install() })
          return
        }

        json(res, 404, { error: 'unknown route' })
      } catch (e) {
        json(res, 400, { error: String((e && e.message) || e) })
      }
    }

    for (const route of ['/state', '/credentials', '/credentials/delete', '/session', '/connect',
      '/guard', '/guard/install', '/guard/rollback', '/repair']) {
      scope.effect(
        () => webServer.register({ kind: 'exact', path: PREFIX + route, handler: handle }),
        'youyudshm: ' + route,
      )
    }
  })

  // ------------------------------------------------------------------- tools
  ctx.inject(['tools'], (scope) => {
    const tools = scope.get('tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return

    // 会话级授权：本会话没勾选的服务器，ssh_* 一律拒绝。
    // 同步守卫 → 只读内存里的 allowCache / profileCache，不发请求。
    if (typeof tools.guard === 'function') {
      scope.effect(() => tools.guard((exec) => {
        const tool = exec && exec.name ? String(exec.name) : ''
        if (!tool.startsWith('ssh_')) return undefined
        if (tool === 'ssh_status') return undefined
        const agent = exec ? exec.agent : undefined
        const sessionId = agent && agent.session && agent.session.id ? String(agent.session.id) : ''
        if (sessionId.length === 0) return undefined
        const allowed = allowFor(sessionId)
        if (allowed.length === 0) {
          return '当前会话没有勾选任何服务器。请在输入框的 SSH 下拉里勾选要用的服务器，本会话才能执行远程操作。'
        }
        const args = exec && exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
        const wanted = args.server
        if (wanted === undefined || wanted === null || String(wanted).length === 0) {
          return allowed.length === 1 ? undefined
            : '本会话勾选了多台服务器，调用 ' + tool + ' 时必须带 server 参数。'
        }
        if (sessionMayUse(sessionId, wanted)) return undefined
        return '服务器「' + wanted + '」没有在当前会话里勾选，拒绝执行。'
      }), 'youyudshm: session scope guard')
    }

    const definition = {
      name: 'ssh_connect',
      description:
        '用已保存的密码连接一台已配置的服务器。使用者说「连一下某台服务器」时调用它。'
        + '本会话只勾选了一台服务器时可省略 server。密码由使用者在界面上预先保存，本工具不接受密码参数。'
        + '只有在当前会话里勾选过的服务器才连得上。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '服务器 id、名称或地址；本会话只勾选了一台时可省略。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec ? exec.agent : undefined
        const sessionId = agent && agent.session && agent.session.id ? String(agent.session.id) : ''
        const allowed = allowFor(sessionId)
        const found = await findProfile(args && args.server)
        if (found.error !== undefined) {
          const names = (found.profiles || []).map((p) => (p.label || p.host) + ' (id=' + p.id + ')').join('、')
          return found.error + (names.length > 0 ? '。已保存：' + names : '')
        }
        if (sessionId.length > 0 && allowed.indexOf(found.profile.id) < 0) {
          return '服务器「' + (found.profile.label || found.profile.host) + '」没有在当前会话里勾选，拒绝连接。'
        }
        const result = await connectWithVault(found.profile.id)
        const label = found.profile.label || found.profile.host
        return result.ok
          ? '已连接 ' + label + '（' + found.profile.username + '@' + found.profile.host + ':' + found.profile.port + '）。之后可用 ssh_exec / ssh_read_file / ssh_write_file / ssh_list_dir。'
          : '连接 ' + label + ' 失败：' + result.note
      },
    }

    scope.effect(
      () => tools.register(definition, 'youyudshm: ssh_connect'),
      'youyudshm: ssh_connect',
    )
  })
}
