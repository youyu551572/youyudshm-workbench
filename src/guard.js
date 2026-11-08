/**
 * 启动守卫安装器。
 *
 * 解决的问题：装了坏插件之后，宿主在 15 s 内没等到 3120 端口应答就报「启动失败」，
 * 而此刻 Node 线程还活着 ⇒ 点“重试”被 `DshHost.start()` 的 `isRunning()` 短路成假成功，
 * 失败标记 `.dshm-boot-failed` 又只在 `main.js` 的 `fail()` 里写（超时路径走不到），
 * 于是下次启动不会自愈，只能重装。
 *
 * 守卫做的事：在核心的 `profile-boot.js` 末尾追加一行副作用 import，
 * 让它在下一次 `runProfile()` 之前检查「上次启动有没有真的写出 host-ready.json」；
 * 没写出就把 profile 的 package.json 退回核心树种子里。这样坏插件最多让你多重启一次。
 *
 * 这个模块只在首次安装 / 修复时被调用，平时不做事；所有步骤 best-effort，绝不抛。
 */
import fs from 'node:fs'
import path from 'node:path'

export const HOOK_LINE = 'try{await import("./dshm-guard.mjs")}catch(e){}'
export const GUARD_FILE = 'dshm-guard.mjs'
export const BACKUP_SUFFIX = '.youyudshm-upstream'

/** 守卫本体。全同步、无定时器、无 await；它自己挂掉不能影响启动。 */
const GUARD_SOURCE = `// dshm-guard.mjs —— 启动守卫（由 youyudshm 安装）。
// 只做一件事：把"上一次启动没走完"变成"这一次自动退回种子 profile"。
// 约束：全同步、无定时器、无 await、每步 try/catch。它挂掉不能影响启动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = 'ondevice';
const H = process.env.DSH_HOME || '';
const PDIR = path.join(H, 'profiles', PROFILE);
const MARK = path.join(H, '.dshm-boot-inflight.json');
const READY = path.join(H, 'host-ready.json');
const LOGF = path.join(H, 'dshm-guard.log');
const STALE_MS = 17000;

function log(m) {
  try { fs.appendFileSync(LOGF, '[' + new Date().toISOString() + '] ' + m + '\\n'); } catch (e) { }
}
function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function coreDir() {
  const env = (process.env.DSHM_CORE_DIR || '').trim();
  if (env) return env;
  return path.resolve(HERE, '../../../..');
}
function seedPkg() {
  return readJson(path.join(coreDir(), 'profiles', PROFILE, 'package.json'));
}
function safeMode(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bad = path.join(H, 'profiles', PROFILE + '.bad-' + stamp);
  const cur = path.join(PDIR, 'package.json');
  try { fs.mkdirSync(bad, { recursive: true }); } catch (e) { }
  try { if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(bad, 'package.json')); } catch (e) { }
  try {
    const rows = path.join(PDIR, '.dshm-plugin-rows.yml');
    if (fs.existsSync(rows)) fs.copyFileSync(rows, path.join(bad, '.dshm-plugin-rows.yml'));
  } catch (e) { }
  const seed = seedPkg();
  if (!seed) { log('safe-mode 放弃：读不到种子 package.json（coreDir=' + coreDir() + '）'); return; }
  try {
    fs.writeFileSync(cur, JSON.stringify(seed, null, 2) + '\\n');
    log('safe-mode 已生效：' + reason + '；旧清单留在 ' + bad);
  } catch (e) { log('safe-mode 写 package.json 失败：' + e.message); }
}

try {
  const now = Date.now();
  const prev = readJson(MARK);
  const ready = readJson(READY);
  const readyPid = ready && ready.pid !== undefined ? String(ready.pid) : '';
  if (prev && prev.pid !== undefined && String(prev.pid) !== String(process.pid)) {
    if (readyPid === String(prev.pid)) {
      log('上次 pid=' + prev.pid + ' 正常就绪，无需处置');
    } else {
      const age = now - (Number(prev.at) || 0);
      if (age >= STALE_MS) {
        safeMode('上次 pid=' + prev.pid + ' 未写出 host-ready.json，已过 ' + Math.round(age / 1000) + 's');
      } else {
        log('跳过：上次 pid=' + prev.pid + ' 距今 ' + Math.round(age / 1000) + 's，不足 ' + Math.round(STALE_MS / 1000) + 's');
      }
    }
  }
  try { fs.writeFileSync(MARK, JSON.stringify({ pid: process.pid, at: now }) + '\\n'); } catch (e) { log('写 inflight 标记失败：' + e.message); }
} catch (e) {
  log('guard 异常（已忽略，不影响启动）：' + (e && e.message ? e.message : String(e)));
}
`

/** 从 $DSH_HOME 反推核心树根：`…/dsh/home` → `…/dsh/cores/<ver>`。 */
export function resolveCoreDir() {
  const env = (process.env.DSHM_CORE_DIR || '').trim()
  if (env.length > 0 && fs.existsSync(env)) return env
  const home = (process.env.DSH_HOME || '').trim()
  if (home.length === 0) return ''
  const coresRoot = path.join(path.dirname(home), 'cores')
  try {
    const names = fs.readdirSync(coresRoot).filter((n) => !n.startsWith('.'))
    if (names.length === 0) return ''
    // 目录名带版本号，取字典序最大的那个即可（rc.5+dshm.109 这种）
    names.sort()
    return path.join(coresRoot, names[names.length - 1])
  } catch (e) {
    return ''
  }
}

export function resolveLibDir(coreDir) {
  if (coreDir.length === 0) return ''
  return path.join(coreDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
}

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8') } catch (e) { return fallback }
}

function safeWrite(file, text) {
  const tmp = file + '.youyudshm-tmp'
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/** 当前状态：armed = 钩子行在、守卫文件在。全部 best-effort，读不到就当 false。 */
export function status() {
  const coreDir = resolveCoreDir()
  const libDir = resolveLibDir(coreDir)
  const entry = libDir.length > 0 ? path.join(libDir, 'profile-boot.js') : ''
  const guard = libDir.length > 0 ? path.join(libDir, GUARD_FILE) : ''
  const entryText = entry.length > 0 ? readOr(entry, '') : ''
  const armed = entryText.indexOf(HOOK_LINE) >= 0
  const guardPresent = guard.length > 0 && fs.existsSync(guard)
  return {
    coreDir: coreDir,
    libDir: libDir,
    entry: entry,
    armed: armed,
    guardPresent: guardPresent,
    healthy: armed && guardPresent,
    entryBytes: entryText.length,
  }
}

/** 安装 / 修复。返回可读结果，不抛。 */
export function install() {
  const result = { ok: false, changed: false, note: '' }
  try {
    const coreDir = resolveCoreDir()
    if (coreDir.length === 0) { result.note = '找不到核心树（$DSHM_CORE_DIR 与 cores 目录都不可用）'; return result }
    const libDir = resolveLibDir(coreDir)
    const entry = path.join(libDir, 'profile-boot.js')
    if (!fs.existsSync(entry)) { result.note = '核心入口不存在：' + entry; return result }

    // 1) 守卫文件（内容不一致就重写）
    const guardPath = path.join(libDir, GUARD_FILE)
    const currentGuard = readOr(guardPath, '')
    if (currentGuard !== GUARD_SOURCE) {
      safeWrite(guardPath, GUARD_SOURCE)
      result.changed = true
    }

    // 2) 入口钩子（幂等：已经有这行就不再动）
    const text = readOr(entry, '')
    if (text.indexOf(HOOK_LINE) < 0) {
      // 第一次改之前留一份逐字节备份
      const backup = entry + BACKUP_SUFFIX
      if (!fs.existsSync(backup)) fs.copyFileSync(entry, backup)
      const sep = text.endsWith('\n') ? '' : '\n'
      safeWrite(entry, text + sep + HOOK_LINE + '\n')
      result.changed = true
    }

    const after = status()
    result.ok = after.healthy
    result.note = after.healthy
      ? (result.changed ? '守卫已安装，下次启动生效' : '守卫已在位，无需改动')
      : '安装后自检未通过'
    return result
  } catch (e) {
    result.note = String((e && e.message) || e)
    return result
  }
}

/** 回滚：去掉钩子行、删守卫文件、保留备份。 */
export function rollback() {
  const result = { ok: false, changed: false, note: '' }
  try {
    const libDir = resolveLibDir(resolveCoreDir())
    if (libDir.length === 0) { result.note = '找不到核心树'; return result }
    const entry = path.join(libDir, 'profile-boot.js')
    const backup = entry + BACKUP_SUFFIX
    if (fs.existsSync(backup)) {
      safeWrite(entry, readOr(backup, ''))
      result.changed = true
    } else {
      const text = readOr(entry, '')
      const lines = text.split('\n').filter((l) => l.trim() !== HOOK_LINE)
      if (lines.join('\n') !== text) { safeWrite(entry, lines.join('\n')); result.changed = true }
    }
    const guardPath = path.join(libDir, GUARD_FILE)
    if (fs.existsSync(guardPath)) { fs.unlinkSync(guardPath); result.changed = true }
    result.ok = !status().armed
    result.note = result.ok ? '已回滚到原始启动' : '回滚后钩子仍在'
    return result
  } catch (e) {
    result.note = String((e && e.message) || e)
    return result
  }
}

/** 日志尾部 + 被隔离的 profile 列表，给工作台展示。 */
export function report(limit) {
  const home = (process.env.DSH_HOME || '').trim()
  const out = { log: [], badProfiles: [], ledger: null, hasMarker: false }
  if (home.length === 0) return out
  try {
    const text = readOr(path.join(home, 'dshm-guard.log'), '')
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    out.log = lines.slice(Math.max(0, lines.length - (limit || 30)))
  } catch (e) { /* 忽略 */ }
  try {
    const dir = path.join(home, 'profiles')
    out.badProfiles = fs.readdirSync(dir).filter((n) => n.indexOf('.bad-') >= 0).sort()
  } catch (e) { /* 忽略 */ }
  try {
    out.ledger = JSON.parse(readOr(path.join(home, '.dshm-boot-inflight.json'), 'null'))
    out.hasMarker = out.ledger !== null
  } catch (e) { /* 忽略 */ }
  return out
}
