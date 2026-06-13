# Bilibili Extensions 操作手册

> 实时记录开发调试过程中的发现、问题和解决方案。

---

## ⚡ 决定性突破（2026-06-13）：自动加载扩展 + content scripts 注入成功

### 核心结论

**用 Chrome for Testing + puppeteer 的 `--load-extension`（配合 `--disable-extensions-except`）可以让 content scripts 完整注入。** 这推翻了下方第 2 章「所有自动化方案都无法让 content scripts 正常注入」的旧结论。端到端验证全链路通过（inject.js 成功 hook `window.fetch`、拦截 player API 与字幕内容、postMessage 传出字幕数据）。

### 旧结论为什么错

旧结论针对的是**系统 Google Chrome**（`/Applications/Google Chrome.app`）。实测（[MANUAL.md:35](MANUAL.md#L35) 第 2 章表格的复测）：

- 系统 Chrome 即使开了开发者模式，`--load-extension` 也**不加载未打包扩展**（`Secure Preferences` 的 `extensions.settings` 里不注册，`chrome://extensions` 页面不显示）。加 `--disable-extensions-except` 同样无效。
- CDP `Extensions.loadUnpacked` domain 能注册扩展（返回 id），但 **content scripts 不注入**（`window.fetch` 仍为 native code）——这是 CDP domain 的固有设计限制（面向 popup/service-worker 测试）。
- `chrome.developerPrivate.loadUnpacked/loadDirectory`（chrome://extensions 页面特权 API）不接受 `path` 参数（报 `Unexpected property: path`），仍依赖系统文件对话框。

**根因**：系统 Chrome 对 `--load-extension` 有硬限制；而 **Chrome for Testing（puppeteer 自带）正常处理 `--load-extension`**，content scripts 注入、`window.fetch` 被 hook 成功。

### 正确方法（已验证）

```js
const browser = await puppeteer.launch({
  executablePath: '<Chrome for Testing 路径>',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
  ],
});
// content scripts 自动注入，inject.js 的 fetch hook 生效：String(window.fetch).includes('ORIGINAL_FETCH') === true
```

### 附带突破：CDP evaluate 可操作 chrome:// WebUI

CDP `Runtime.evaluate` 在 `chrome://extensions/` 页面**可以穿透 shadow DOM 操作 WebUI 组件**（旧结论「chrome:// evaluate 返回空」不准确——失败的只是 privileged `chrome.*` API，普通 DOM 操作可行）。已验证可点击开发者模式开关：

```js
document.querySelector('extensions-manager')
  .shadowRoot.querySelector('extensions-toolbar')
  .shadowRoot.querySelector('#devMode').click();  // before=false → after=true
```

### 端到端验证（绕过登录）

未登录下 B 站 player API 的 `subtitles` 字段普遍为空（实测全站排行榜 25 个视频全 `subs:[]`，测试视频 BV1qcEE6FEhn 的 UI 明确显示「暂无字幕」）。真实字幕需登录态。**用 puppeteer `setRequestInterception` mock 字幕响应**，可隔离验证扩展拦截链路（不依赖真实字幕/登录）：

- mock player API 返回 3 条字幕（AI 中文 / AI 英语机翻 / CC 简体中文）→ inject.js 拦截 → `postMessage('BILIBILI_SUBTITLE_META', subs)` ✅
- mock 字幕内容 URL（`aisubtitle` / `bfs/subtitle`）→ inject.js 拦截 → `postMessage('BILIBILI_SUBTITLE_CONTENT', {url,data})` ✅
- 字幕类型分析正确：`type:1` = AI 自动生成，`type:2` = UP 主上传（CC），多语言 `lan_doc` 区分 ✅

完整验证脚本：[`scripts/verify-extension.mjs`](scripts/verify-extension.mjs)（运行方式见脚本顶部注释）。

---


## 1. 项目结构

```
bilibili-extensions/
├── apps/
│   └── subtitle-extractor/    # 字幕提取扩展
│       ├── manifest.json      # MV3 扩展配置
│       ├── inject.js          # MAIN world — 拦截 fetch/XHR 捕获字幕数据
│       ├── content.js         # ISOLATED world — 桥接 inject.js ↔ popup
│       ├── popup.html         # 弹窗 UI（卡片式展示）
│       ├── popup.js           # 弹窗逻辑（轮询 + 渲染字幕）
│       └── package.json       # 子包配置
├── package.json               # Turborepo root（pnpm workspace）
├── pnpm-workspace.yaml
├── turbo.json
├── MANUAL.md                  # 本文档
└── .gitignore
```

## 2. 安装扩展到 Chrome

### 手动安装（唯一可靠方式）
1. 打开 `chrome://extensions/`
2. 开启右上角**开发者模式**
3. 点击 **"加载已解包的扩展程序"**
4. 选择 `apps/subtitle-extractor` 目录
5. 扩展图标出现在工具栏

### 命令行自动加载 — 全部失败

| # | 方法 | 结果 | 原因 |
|---|------|------|------|
| 1 | `--load-extension=路径` 启动参数 | ❌ | content scripts 不注入，扩展不工作 |
| 2 | AppleScript `keystroke` 输入路径 | ⚠️ | 按键可与 NSOpenPanel 交互，但需用户先手动点击按钮 |
| 3 | AppleScript `tell process "Google Chrome"` 点击 UI | ❌ | System Events 报告 Chrome 有 0 个窗口 |
| 4 | 手写 `Preferences` JSON 注册扩展 | ❌ | Chrome 启动时覆盖该文件 |
| 5 | MCP `click(uid)` 点击按钮 | ❌ | DOM 级模拟点击，不触发系统 NSOpenPanel 对话框 |
| 6 | `evaluate_script` 获取 chrome:// 元素 | ❌ | Chrome 内部页面禁止 JS 访问 DOM |
| 7 | Python CoreGraphics `CGEvent` 点击坐标 | ⚠️ | 光标能定位到按钮，但未确认是否触发 NSOpenPanel |
| 8 | CDP `Extensions.loadUnpacked` | ❌ | 返回成功但 content scripts 不注入，扩展不工作 |
| 9 | `--disable-extensions-except` + `--load-extension` | ❌ | service worker 启动但 content scripts 不注入 |
| 10 | 写 `toolbar.pinned_actions` 固定扩展 | ❌ | Chrome 启动时删除我们写的 ID |

**结论：所有自动化方案都无法让 content scripts 正常注入。必须通过 UI 手动"加载未打包"才是完整激活扩展的唯一方式。**

> ⚠️ **此结论已被部分推翻（2026-06-13）**：见本文档顶部「决定性突破」。用 **Chrome for Testing + puppeteer `--load-extension`** 可让 content scripts 完整注入，无需手动 UI。下表结论针对的是**系统 Google Chrome**，对该场景仍成立——系统 Chrome 确实无法自动加载未打包扩展，只有 Chrome for Testing 才支持。

## 3. B 站字幕 API 发现

### 字幕加载流程
1. 打开视频页 → 浏览器请求 `/x/player/wbi/v2`（播放器 API）
2. Player API 返回 `subtitle.subtitles[]` → **默认为空**（`need_login_subtitle: true`）
3. 用户**点击字幕按钮 → 选择字幕语言** → 浏览器才发起字幕内容请求
4. 字幕内容 URL 匹配模式：`aisubtitle` / `bfs/subtitle` / `bfs/ai_subtitle`
5. 字幕 JSON 格式：`{ body: [{ from, to, content, sid }] }`

### 关键发现
- **字幕不是页面加载时返回的**，需要用户主动点击字幕按钮
- `need_login_subtitle: true` 表示部分视频需登录才能获取字幕
- 字幕类型：`type: 1` = AI 自动生成，`type: 2` = UP 主上传（CC 字幕）
- 字幕 URL 格式：`//aisubtitle.hdslb.com/...`（协议相对 URL，需补 `https:`）
- Player API URL 格式：`api.bilibili.com/x/player/wbi/v2?aid=...&cid=...`

### Player API 响应结构
```json
{
  "code": 0,
  "data": {
    "need_login_subtitle": true,
    "subtitle": {
      "allow_submit": false,
      "subtitles": []
    }
  }
}
```

### 字幕内容响应结构
```json
{
  "body": [
    { "from": 0.08, "to": 3.24, "content": "大家好", "sid": 1 }
  ]
}
```

### 测试用视频
- `https://www.bilibili.com/video/BV1qcEE6FEhn/`
- 该视频有 AI 自动生成字幕

## 4. Chrome DevTools MCP 使用笔记

### 可用操作
| 操作 | 说明 | 注意事项 |
|------|------|----------|
| `navigate_page` | 导航到 URL | ✅ 正常 |
| `take_snapshot` | 获取 a11y 树（含 uid） | ✅ 正常，chrome:// 页面也可用 |
| `take_screenshot` | 截图视口 | ✅ 可保存到 `filePath`，只能看到视口 |
| `click(uid)` | 点击元素 | ⚠️ DOM 级模拟，不触发系统对话框 |
| `evaluate_script` | 执行 JS | ⚠️ chrome:// 页面受限（返回空） |
| `list_network_requests` | 列出网络请求 | ✅ 可按 `resourceTypes` 过滤 |
| `get_network_request` | 获取请求详情 | ✅ 含完整响应体 |
| `press_key` | 发送键盘事件 | ✅ DOM 级，非系统级 |
| `upload_file` | 上传文件到 `<input>` | ❌ 不适用于"加载未打包"按钮 |

### Chrome 窗口信息（实测）
```
screenX=5, screenY=36
outerWidth=1200, outerHeight=880
innerWidth=1200, innerHeight=737
devicePixelRatio=2
浏览器工具栏高度: outerHeight - innerHeight = 143px
```

### 限制
- `evaluate_script` 在 `chrome://` 页面返回空数组
- `click` 无法触发系统文件对话框（NSOpenPanel）
- `take_screenshot` 只能看到浏览器视口，看不到系统级对话框
- `take_screenshot` 分辨率与 `devicePixelRatio` 有关

### 系统级截图（2026-06-10 更新）
- `screencapture -x /path.png` → ✅ 已获得屏幕录制权限，可以截取完整屏幕
- 系统截图**能看到 NSOpenPanel 文件对话框**（MCP `take_screenshot` 看不到）
- 截图文件通过 `Read` 上传 CDN 后可用 `analyze_image` 分析内容

## 5. macOS 自动化笔记

### AppleScript
- `tell application "Google Chrome" to activate` → ✅ 可将 Chrome 拉到前台
- `tell process "Google Chrome"` → System Events 报告 0 个窗口（权限不足）
- `keystroke` 会发到当前聚焦窗口，不一定是 Chrome
- **NSOpenPanel 弹出后**，AppleScript `keystroke` **可以**与其交互（实测有效）：
  - `keystroke "g" using {command down, shift down}` → ✅ 成功打开"前往文件夹"输入框
  - `keystroke "/path/to/dir"` → ✅ 可以输入路径（但需要确保焦点在正确窗口上）
  - `key code 36` (Enter) → ✅ 可以确认
  - `key code 53` (Escape) → ⚠️ 会关闭整个 NSOpenPanel 对话框
- **关键限制**：AppleScript 无法主动触发 NSOpenPanel，只能交互已打开的对话框

### Python CoreGraphics
- `CGWindowListCopyWindowInfo` → 可列出窗口，但所有 Chrome 窗口坐标报 (0,0)
- `CGEventCreateMouseEvent` → 可模拟鼠标点击，但需要精确屏幕坐标
- `screencapture -x` → ✅ 已获得屏幕录制权限，可以正常截图

### Chrome 启动参数
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/chrome-test \
  --no-first-run \
  "chrome://extensions/"
```
- `--user-data-dir` → ✅ 有效，可创建独立实例
- `--load-extension` → ❌ 在 macOS 上被忽略
- `--enable-features=ExtensionsToolbarMenu` → 不影响加载行为

## 6. 执行前检查清单

每次操作前必须：
- [ ] `osascript -e 'tell application "Google Chrome" to activate'` 激活 Chrome
- [ ] `take_snapshot` 确认当前页面状态
- [ ] `take_screenshot` 确认视觉状态
- [ ] 确认操作目标元素存在且 uid 正确
- [ ] 操作后再次 `take_snapshot` / `take_screenshot` 验证结果

## 7. 问题记录

### 2026-06-10 01:12 — AppleScript 按键发到 iTerm
- **问题**：AppleScript `keystroke` 发到了 iTerm 而不是 Chrome 文件对话框
- **原因**：`tell process "Google Chrome"` 控制不了系统级 NSOpenPanel；且按键发到当时聚焦的 iTerm
- **影响**：路径被粘贴到了 iTerm 终端
- **解决**：无自动解决方案，需手动加载扩展

### 2026-06-10 01:00 — --load-extension 在 macOS 不生效
- **问题**：`--load-extension=/path` 启动参数被 Chrome 忽略
- **验证**：`ps aux | grep load-extension` 确认进程参数存在，但 `ls Extensions/` 目录只有内置扩展
- **原因**：macOS 多实例环境下 Chrome 不处理该参数
- **解决**：无，需手动加载

### 2026-06-10 01:15 — 手写 Preferences 被 Chrome 覆盖
- **问题**：在 Chrome 启动前写入 `Default/Preferences` 注册扩展，启动后文件被覆盖
- **原因**：Chrome 启动时会重新生成 Preferences 文件
- **解决**：无

### 2026-06-10 01:20 — System Events 看不到 Chrome 窗口
- **问题**：`tell process "Google Chrome"` 报告 0 个窗口
- **原因**：macOS 辅助功能权限不完整（可能需要授予给特定进程）
- **解决**：`tell application "Google Chrome" to activate` 仍可用，但无法通过 UI 树定位元素

### 2026-06-10 01:30 — CoreGraphics 坐标点击不准
- **问题**：用 Python CGEvent 点击估算坐标，文件对话框没弹出
- **原因**：截图尺寸（997x665）与实际视口尺寸（1200x737 @2x DPI）不匹配，坐标换算错误
- **解决**：未解决，缺少屏幕录制权限无法用 `screencapture` 校准

### 2026-06-10 01:35 — screencapture 权限不足
- **问题**：`screencapture -x /path.png` 报 `could not create image from display`
- **原因**：终端/Claude Code 进程没有"屏幕录制"权限
- **解决**：系统设置 → 隐私与安全 → 屏幕录制 → 添加终端应用
- **状态**：✅ 已解决（2026-06-10 01:50 验证通过）

### 2026-06-10 01:50 — 半自动加载扩展流程验证
- **发现**：`screencapture` + `Read`（上传CDN）+ `analyze_image` 可以看到 NSOpenPanel 对话框
- **发现**：AppleScript `keystroke` 可以与已打开的 NSOpenPanel 交互（Cmd+Shift+G、输入路径）
- **问题**：用户手动点击"加载未打包"后，Claude 没有立即执行路径输入，而是先截图分析，导致操作链中断
- **问题**：Escape 会关闭整个 NSOpenPanel，需要重新手动点击"加载未打包"
- **结论**：可行的半自动流程为：
  1. 用户手动点击 Chrome 的"加载未打包的扩展程序"按钮
  2. Claude 立即执行 `Cmd+Shift+G` → 输入路径 → Enter → 等待 → Enter（确认选择）
  3. 无需截图确认，直接执行完整个键盘操作链

### 2026-06-10 02:15 — CDP Extensions.loadUnpacked 不工作
- **发现**：CDP `Extensions.loadUnpacked` 返回成功（含扩展 ID），但 content scripts 不注入
- **验证**：`window.fetch.toString()` 返回 `function fetch() { [native code] }`，inject.js 未执行
- **原因**：CDP 只是注册了扩展，没有像 UI 那样完整激活（注册 content scripts 等）
- **尝试**：`--load-extension` + `--disable-extensions-except` 启动参数 → service worker 能启动但 content scripts 仍不注入
- **结论**：所有非 UI 方式都无法让 content scripts 正常工作

### 2026-06-10 02:20 — 写 Preferences 固定扩展失败
- **发现**：`toolbar.pinned_actions` 数组存储固定到工具栏的扩展 ID
- **尝试**：Chrome 关闭时写入扩展 ID，重启后 Chrome 删除了我们写的 ID
- **结论**：无法通过写文件固定扩展

### 2026-06-10 02:20 — Chrome 调试端口不稳定
- **问题**：`curl localhost:9222/json/version` 频繁返回 503 Service Unavailable
- **原因**：可能是频繁的 websocket 连接/断开导致 Chrome 不稳定
- **影响**：CDP 操作需要频繁重连，影响可靠性

---

*最后更新：2026-06-10 02:25*
