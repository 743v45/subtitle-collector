# SubCatch 品牌重塑设计 — subtitle-collector 扩展

> 状态：**待用户审查** · 日期：2026-07-05 · 范围：`apps/subtitle-collector`

## 1. 背景

当前 `subtitle-collector` 扩展的品牌层缺失：

- manifest `name` 为 `"Bilibili Subtitle Collector"`（[manifest.json:3](apps/subtitle-collector/manifest.json#L3)），**无 `short_name`**（扩展栏显示冗长全名）。
- **完全没有自定义图标**：manifest 无 `icons`、`action` 无 `default_icon`（[manifest.json:26](apps/subtitle-collector/manifest.json#L26)），Chrome 显示默认灰色拼图块。
- popup `<title>` 同旧名（[popup.html:5](apps/subtitle-collector/popup.html#L5)），popup 内顶部无品牌头。
- **定位偏差**：实际是多平台字幕采集器——[platforms.ts:24-33](apps/subtitle-collector/src/popup/platforms.ts#L24) 已预取 B 站 / 抖音 / 小红书 / YouTube 四家官方 logo path，但旧名只提 B 站。

目标：换成生产级品牌——新名字、完整多尺寸图标、popup 品牌条，并修正为多平台定位。

## 2. 命名规范

| 字段 | 旧值 | 新值 |
|---|---|---|
| manifest `name` | Bilibili Subtitle Collector | `SubCatch — 字幕捕手` |
| manifest `short_name`（新增） | — | `SubCatch` |
| manifest `description` | 采集 B 站视频字幕到本地服务端 | `一键捕获 B 站 / 抖音 / 小红书 / YouTube 视频字幕，采集到本地服务端` |
| popup `<title>` | Bilibili Subtitle Collector | `SubCatch` |
| `action.default_title`（新增） | — | `SubCatch — 字幕捕手` |

**不改**：内部目录名 / 包名 `subtitle-collector` / `@bilibili-ext/subtitle-collector`（[package.json:2](apps/subtitle-collector/package.json#L2)）。纯技术标识，不影响用户，避免无谓的路径/workspace 迁移。

**中文副标题**（popup 品牌条用）：`字幕捕手 · 多平台视频字幕采集`。

## 3. 图标系统

### 3.1 视觉

- **符号**：CC（Closed Caption）白色描边双弧。CC 是国际通用字幕符号，**平台中性**——天然适配多平台定位。
- **底色**：对角渐变 `#FB7299 → #00A1D6`（粉→蓝）。保留为 **SubCatch 自己的品牌色**（用户已确认方案 A），不绑定 B 站。
- **形状**：圆角方块 `rx=16`（viewBox 72），满铺。

### 3.2 源文件与尺寸

| 文件 | 用途 | CC 描边（viewBox=72） |
|---|---|---|
| `icons/icon.svg` | 48 / 128 主版 | stroke-width 4.5 |
| `icons/icon-small.svg` | 16 / 32 加粗版（小尺寸保清晰） | stroke-width 6 |
| `icons/icon-{16,32,48,128}.png` | manifest 实际引用（生成产物） | — |

两份 master SVG 手写（纯几何，不含 `<text>`，避免字体差异）。

### 3.3 生成脚本

新增 [apps/subtitle-collector/scripts/generate-icons.mjs](apps/subtitle-collector/scripts/generate-icons.mjs)：

- 用 **`@resvg/resvg-js`**（纯 Rust→wasm，无系统依赖，npm 即用）把两份 SVG 渲染为 4 尺寸 PNG。
  - 实现期若 `@resvg/resvg-js` 在该环境异常，回退 `sharp`（功能等价，依赖 libvips prebuilt）。
- 输出到 `apps/subtitle-collector/icons/icon-{16,32,48,128}.png`。
- `package.json` 增加：
  - `devDependencies`: `@resvg/resvg-js`
  - `scripts.gen:icons`: `node scripts/generate-icons.mjs`
  - `scripts.build` 前置图标生成：`node scripts/generate-icons.mjs && vite build`

### 3.4 manifest 引用

[manifest.json](apps/subtitle-collector/manifest.json) 增加：

```json
"icons": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
"action": {
  "default_popup": "popup.html",
  "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
  "default_title": "SubCatch — 字幕捕手"
}
```

由 `@crxjs/vite-plugin` 在 build 时把这些静态资源打包进 `dist/`（实现期验证 `dist/icons/` 存在）。

## 4. popup 顶部品牌条

在 [Popup.tsx](apps/subtitle-collector/src/popup/Popup.tsx) 返回结构最顶部插入一个品牌条组件，**不改变下方既有结构**：

- **左**：SubCatch 图标（26px，封装为内联 SVG React 组件 `<SubCatchLogo size={26} />`，与 §3.2 master 同构；不引外部图片资源，避免 popup 启动加载）+ 主标题 `SubCatch`（700 字重）+ 副标题 `字幕捕手 · 多平台视频字幕采集`（11px 灰）。
- **右**：4 个平台 logo 方块（24×24，圆角 6），从 [platforms.ts](apps/subtitle-collector/src/popup/platforms.ts) 的 `LOGOS` 引用 path（**不硬编码**），方块底色用各平台品牌色：
  - B 站 `bg-brand`（已有 token，[platforms.ts:40](apps/subtitle-collector/src/popup/platforms.ts#L40)）/ 抖音 `bg-[#000]` / 小红书 `bg-[#FF2442]` / YouTube `bg-[#FF0000]`，logo path `fill="currentColor"` 取白。
- **背景**：淡粉蓝渐变 `bg-gradient-to-r from-[#FB7299]/12 to-[#00A1D6]/12`，下边框 `border-b border-slate-200`。
- 全程 **Tailwind 工具类**（遵守全局样式规则），禁内联 `style`、禁手写 CSS。

品牌条展示 4 平台 logo 体现多平台定位（不区分接入状态；当前仅 B 站在 `PLATFORMS` 中，接入进度属功能层、不在品牌条体现）。

## 5. 落地清单

| # | 文件 | 动作 |
|---|---|---|
| 1 | [apps/subtitle-collector/manifest.json](apps/subtitle-collector/manifest.json) | 改 name/short_name/description；加 icons + action.default_icon + action.default_title |
| 2 | [apps/subtitle-collector/popup.html](apps/subtitle-collector/popup.html) | 改 `<title>` 为 SubCatch |
| 3 | `apps/subtitle-collector/icons/icon.svg` | 新增（master 主版） |
| 4 | `apps/subtitle-collector/icons/icon-small.svg` | 新增（master 加粗版） |
| 5 | `apps/subtitle-collector/icons/icon-{16,32,48,128}.png` | 生成产物，**入 git**（便于审查、Chrome 可直接 load），build 时由 `gen:icons` 重新生成覆盖 |
| 6 | `apps/subtitle-collector/scripts/generate-icons.mjs` | 新增（图标生成脚本） |
| 7 | [apps/subtitle-collector/package.json](apps/subtitle-collector/package.json) | 加 `@resvg/resvg-js` devDep + `gen:icons` 脚本 + `build` 前置 |
| 8 | [apps/subtitle-collector/src/popup/Popup.tsx](apps/subtitle-collector/src/popup/Popup.tsx) | 顶部插入品牌条组件 |
| 9 | [apps/subtitle-collector/src/popup/platforms.ts](apps/subtitle-collector/src/popup/platforms.ts) | 仅复用已 export 的 `LOGOS`，**不改接入逻辑** |

## 6. 验收标准

- [ ] `pnpm build`（即 `vite build`）成功，且 build 前 `gen:icons` 产出 4 个 PNG。
- [ ] `apps/subtitle-collector/dist/manifest.json` 含 `name=SubCatch — 字幕捕手`、`short_name=SubCatch`、`icons`（4 尺寸）、`action.default_title`。
- [ ] `apps/subtitle-collector/dist/icons/` 含 4 个 PNG。
- [ ] popup 渲染顶部品牌条：图标 + SubCatch + 副标题 + 4 平台 logo 方块。
- [ ] Chrome `--load-extension=apps/subtitle-collector/dist` 加载后：工具栏显示 SubCatch 渐变图标（非默认拼图）、扩展栏名 `SubCatch`、鼠标悬停 tooltip `SubCatch — 字幕捕手`。

## 7. 测试

按项目测试政策（[CLAUDE.md §3](CLAUDE.md)）：subtitle-collector 豁免 Playwright，用 `vite build` 冒烟 + `scripts/verify-*.mjs`。

- **冒烟**：`pnpm build` 通过（含图标生成）。
- **可选新增**：`scripts/verify-manifest.mjs`（puppeteer mock）断言 `dist/manifest.json` 含 icons/name/short_name，且 `dist/icons/icon-128.png` 存在。
- 本任务不改 inject/content/background 逻辑，既有 verify 脚本不受影响。

## 8. 不做（YAGNI）

- 不改目录名 / 包名 `subtitle-collector`。
- 不做 Chrome 商店 tile 图 / 大截图 / 宣传图（后续发布时再做）。
- 不改 platforms.ts 平台接入逻辑（仅复用 `LOGOS` 做展示）。
- 不为每尺寸做像素级手工调整——脚本从 SVG 渲染的 PNG 质量对本几何图标足够。
- 不区分 4 平台 logo 的「已接入/即将接入」视觉状态。

## 9. 测试轮次记录表

| 轮次 | 日期 | 测试内容 | 结果 | 备注 |
|---|---|---|---|---|
| 1 | 2026-07-05 | `pnpm --filter @bilibili-ext/subtitle-collector build`（含 `gen:icons`）+ `dist/manifest.json` 校验 + 图标视觉核验 | ✅ 通过 | 77 modules / 765ms；4 PNG 进 `dist/icons/`；name/short_name/description/icons/action.default_title 全对；128px CC 完整清晰、16px 加粗版 CC 可辨认 |
| 2 | 待用户 | Chrome `--load-extension=dist` 人工核对工具栏图标 / 扩展名 / tooltip / popup 品牌条 | — | 需用户实际加载扩展 |
