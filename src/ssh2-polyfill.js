/**
 * ssh2 的 WASM Poly1305 替换为纯 JS。
 *
 * 背景：`ssh2` 在 `lib/protocol/crypto.js:1596` 的模块定义阶段就执行 `init()`，
 * 里面 `require('./crypto/poly1305.js')()` 加载一个 Emscripten WASM 模块。
 * 本机宿主以 `--jitless` 启动，`WebAssembly` 是 undefined ⇒ 抛
 * `ReferenceError: WebAssembly is not defined` ⇒ 插件装载失败、`runProfile` 拿不到 webServer。
 *
 * 整个 ssh2 里只有这一个文件用到 WebAssembly，所以换掉它就够了。
 * 新实现与 Emscripten 模块同接口（`HEAPU8` / `_malloc` / `cwrap('poly1305_auth', …)`），
 * 算法是 RFC 8439 §2.5 的 BigInt 版本。
 *
 * 只在装着 ssh2 且原文件仍是 WASM 版时才动手；已经换过就跳过。
 */
import fs from 'node:fs'
import path from 'node:path'

const SHIM = `'use strict';
// 纯 JS Poly1305（替换 ssh2 自带的 Emscripten/WASM 版本），由 youyudshm 安装。
// 宿主带 --jitless 启动时 WebAssembly 是 undefined，原实现模块加载即抛 ReferenceError。
// 对外接口与 Emscripten 一致：HEAPU8 / _malloc(n) / cwrap('poly1305_auth', ...)。
// 算法：RFC 8439 §2.5，BigInt 实现。
const HEAP_BYTES = 65536;
const heap = new Uint8Array(HEAP_BYTES);
let bump = 0;
const P = (1n << 130n) - 5n;
const R_CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn;
const M128 = (1n << 128n) - 1n;

function leToBig(bytes, off, len) {
  let n = 0n;
  for (let i = len - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[off + i] & 0xff);
  return n;
}
function bigToLe(n, out, off, len) {
  for (let i = 0; i < len; i++) { out[off + i] = Number(n & 0xffn); n >>= 8n; }
}
function poly1305(parts, key) {
  const r = leToBig(key, 0, 16) & R_CLAMP;
  const s = leToBig(key, 16, 16);
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].length;
  const msg = new Uint8Array(total);
  let o = 0;
  for (let i = 0; i < parts.length; i++) { msg.set(parts[i], o); o += parts[i].length; }
  let acc = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const n = Math.min(16, msg.length - i);
    const block = new Uint8Array(n + 1);
    block.set(msg.subarray(i, i + n), 0);
    block[n] = 1;
    acc = ((acc + leToBig(block, 0, n + 1)) * r) % P;
  }
  acc = (acc + s) & M128;
  const tag = new Uint8Array(16);
  bigToLe(acc, tag, 0, 16);
  return tag;
}
function _malloc(n) {
  const p = bump;
  bump = (bump + n + 15) & ~15;
  if (bump > HEAP_BYTES) bump = 0;
  return p;
}
function cwrap(name) {
  if (name !== 'poly1305_auth') throw new Error('poly1305 shim: unsupported export ' + name);
  return function (outPtr, m1, m1len, m2, m2len, key) {
    const a = new Uint8Array(m1.buffer, m1.byteOffset, m1len);
    const b = new Uint8Array(m2.buffer, m2.byteOffset, m2len);
    const k = new Uint8Array(key.buffer, key.byteOffset, key.length);
    const tag = poly1305([a, b], k);
    heap.set(tag, outPtr);
  };
}
module.exports = function createPoly1305() {
  return Promise.resolve({ HEAPU8: heap, _malloc: _malloc, cwrap: cwrap });
};
`

const MARKER = 'pure JS poly1305'
const ORIG_MARKER = 'createPoly1305.ready'

/** 找真实装配出来的 ssh2（可能在 profile 的 node_modules 里）。 */
function findSsh2() {
  const home = (process.env.DSH_HOME || '').trim()
  if (home.length === 0) return []
  const hits = []
  const root = path.join(home, 'profiles', 'ondevice', 'node_modules')
  const direct = path.join(root, 'ssh2', 'lib', 'protocol', 'crypto', 'poly1305.js')
  if (fs.existsSync(direct)) hits.push(direct)
  try {
    for (const name of fs.readdirSync(root)) {
      const nested = path.join(root, name, 'node_modules', 'ssh2', 'lib', 'protocol', 'crypto', 'poly1305.js')
      if (fs.existsSync(nested)) hits.push(nested)
    }
  } catch (e) { /* 忽略 */ }
  return hits
}

export function status() {
  const files = findSsh2()
  const rows = files.map((file) => {
    let patched = false
    let wasm = false
    try {
      const text = fs.readFileSync(file, 'utf8')
      patched = text.indexOf(MARKER) >= 0
      wasm = text.indexOf(ORIG_MARKER) >= 0 && !patched
    } catch (e) { /* 忽略 */ }
    return { file: file, patched: patched, wasm: wasm }
  })
  return {
    found: files.length > 0,
    files: rows,
    allPatched: rows.length > 0 && rows.every((r) => r.patched),
  }
}

export function install() {
  const out = { ok: false, changed: 0, note: '', files: [] }
  const files = findSsh2()
  if (files.length === 0) {
    out.ok = true
    out.note = '没有装 ssh2，跳过'
    return out
  }
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (text.indexOf(MARKER) >= 0) { out.files.push({ file: file, action: 'skip' }); continue }
      const backup = file + '.wasm-orig'
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
      const tmp = file + '.youyudshm-tmp'
      fs.writeFileSync(tmp, SHIM)
      fs.renameSync(tmp, file)
      out.changed += 1
      out.files.push({ file: file, action: 'patched' })
    } catch (e) {
      out.files.push({ file: file, action: 'failed: ' + String((e && e.message) || e) })
    }
  }
  out.ok = out.files.every((f) => f.action !== 'failed' && !String(f.action).startsWith('failed'))
  out.note = out.changed > 0 ? ('已替换 ' + out.changed + ' 个 poly1305.js') : '已经是纯 JS 版，无需改动'
  return out
}
