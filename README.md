# 有鱼工作台 · youyudshm

DSHM（DeepSeek Harness 鸿蒙端）的一体化工作台插件。一个包，装完即用。

**它解决的是这台设备上真实踩过的坑**，不是通用模板：装完插件重启、15 秒报「3120 端口未应答」、
重试没用、只能重装。这里每一条都是针对那个链条的。

## 装了什么

| 位置 | 组件 | 作用 |
|---|---|---|
| 宿主 | `/plugins/youyudshm/*` | 运行时事实、SSH 密码保管、会话级服务器授权、启动守卫 |
| 宿主 | 工具 `ssh_connect` | 模型可以自己连服务器，密码从保管箱取，模型看不到 |
| 宿主 | `tools.guard()` | 本会话没勾选的服务器，所有 `ssh_*` 一律拒绝 |
| 左侧面板 | `PanelIcon` → `Workbench` | 有鱼工作台：运行时四卡、**启动守卫**、插件清单、SSH 管理、连接记录 |
| 输入框右 | `SshSelect` | 给当前会话勾选可用的服务器 |
| 输入框上 | `ComposerMenu` | 三联下拉：推理强度（滑块）/ 模型 / 余额 |
| 设置页 | `SettingsTab` | 设置 → 插件 → 有鱼 |
| 标题栏 | `HeaderAction` | 会话标题栏的「有鱼」入口 |

## 一、启动守卫（防砖）

**为什么需要它**

1. 宿主只给 Node **15 秒**（`NodeRuntime.ets` 的 `READY_TIMEOUT_MS`）去让 `127.0.0.1:3120` 应答；
2. 超时后 Node 线程还活着，于是 `DshHost.start()` 开头的 `if (this.port.isRunning()) return {ok:true}`
   把「重试」短路成假成功 —— 一次端口都不等；
3. `.dshm-boot-failed` 只在 `main.js` 的 `fail()` 里写，**超时是从 ArkTS 侧抛的**，永远到不了那里
   ⇒ 下次启动不会自愈；
4. 结果：装完坏插件 → 报错页 → 重试没用 → 每次重开都加载同一个插件 → 只能重装。

**它做什么**

在核心的 `node_modules/@deepseek-ai/dsh/lib/profile-boot.js` 末尾追加一行：

```js
try{await import("./dshm-guard.mjs")}catch(e){}
```

守卫在 `runProfile()` **之前**跑（`main.js` 的 `await import(entry)` 早于 `runProfile(...)`），
所以当次启动就生效。判据不靠计时器：

- 读 `$DSH_HOME/.dshm-boot-inflight.json`（本次 pid）与 `host-ready.json` 的 pid
- pid 相等 = 上次真的就绪
- 不等且标记超过 **17 s** = 上次没走完 ⇒ 把当前 `package.json` 备份进
  `profiles/ondevice.bad-<时间戳>/`，用核心树种子覆盖回去

于是坏插件最多让你**多重启一次**，插件文件、密码、会话都还在。

**安装**：插件首次装载时自动装；也可以在工作台「启动守卫」卡片里点「安装守卫」。
回滚点「回滚」，会恢复 `profile-boot.js.youyudshm-upstream` 并删掉守卫文件。

## 二、SSH

- 密码保存在 `$DSH_HOME/youyudshm/credentials.json`（0600），浏览器不留
- 服务器列表与连接状态归 `dsh-ssh-servers` 那一行管，本插件只做「保管 + 一次连接转发」
- **会话级授权**：下拉里勾选哪几台，本会话的 `ssh_*` 才有权限用哪几台；
  `ssh_status` 放行（只读，不碰网络）
- 下拉用 portal 挂到 `document.body`（输入区带 `transform` 会让 `position: fixed` 失效，
  菜单会算错右边界或者被祖先裁掉）

## 三、输入框上方三联下拉

```
[▂▄▆ 高 ⌄] [◇ DeepSeek V4.1 Flash ⌄] [◉ ¥0.79 ⌄]
   强度            模型                  余额
```

- **强度**：`step: 'any'` 连续拖动、松手才提交；宿主回声一到立即解锁本地值，零回弹
- **模型**：按供应商分组，行内省略号，选中时带上该模型的 `defaultEffort`
- **余额**：默认显示**充值余额**（`getBalance` 的 `value`），点开看**赠送余额**（`bonusWallets`）
- 三个芯片共用一套样式与动效；窄屏换行不溢出；点击不抢焦点（软键盘不弹）
- 同时隐藏输入框内官方的「模型 + 强度」座位，避免同一功能出现两处

## 四、顺手修的 ssh2

`ssh2` 在模块定义阶段就 `require('./crypto/poly1305.js')()` 加载 Emscripten WASM。
本机宿主带 `--jitless` 启动，`WebAssembly` 是 `undefined` ⇒ 抛 `ReferenceError` ⇒
插件装载失败、`runProfile` 拿不到 webServer。

整个 ssh2 里只有这一个文件用 WASM，所以换成纯 JS 版（RFC 8439 §2.5，BigInt 实现，
接口与 Emscripten 一致）。工作台里点「修复 ssh2」或调 `POST /plugins/youyudshm/repair`，
原件备份为 `poly1305.js.wasm-orig`。**重装插件会丢，重装后点一次即可。**

## 安装

```sh
dsh plugin --profile ondevice add github:youyu551572/youyudshm-workbench
```

或直接把仓库地址发给 agent，让它走安装队列。

装完**重启一次应用**。首次装载会自动装启动守卫，`dshm-guard.log` 里能看到第一行。

## 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/plugins/youyudshm/state` | 运行时事实 + 已存密码的服务器 + 每个会话勾选的服务器 |
| GET | `/plugins/youyudshm/guard` | 守卫状态 + 日志尾部 + 被隔离的 profile + ssh2 状态 |
| POST | `/plugins/youyudshm/guard/install` | 安装 / 修复守卫 |
| POST | `/plugins/youyudshm/guard/rollback` | 回滚守卫 |
| POST | `/plugins/youyudshm/repair` | 替换 ssh2 的 WASM poly1305 |
| POST | `/plugins/youyudshm/credentials` | 保存 / 清除服务器密码 |
| POST | `/plugins/youyudshm/credentials/delete` | 删除密码 |
| POST | `/plugins/youyudshm/session` | 设置某会话可用的服务器 |
| POST | `/plugins/youyudshm/connect` | 用保存的密码连接 |

## 边界（如实说）

- **不是安全边界**：密码是明文存的（0600 文件），能读 `$DSH_HOME` 的人就能读到。
  它挡的是「模型看到密码」，不是「本机其他进程」。
- **守卫只退 profile**，不动核心树、不动 `node_modules`。卡在核心树本身它救不了。
- **守卫有已知误判**：应用启动到一半被系统杀掉，也会被当成「没走完」而触发一次 safe-mode，
  代价是插件被停用（数据在 `.bad-<时间戳>/` 里，可恢复）。
- **工作台不做 SSH 传输层**，`dsh-ssh-servers` 仍是必需依赖。

## 许可

MIT。
