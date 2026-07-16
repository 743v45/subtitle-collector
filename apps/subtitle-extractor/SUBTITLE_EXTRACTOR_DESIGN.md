# subtitle-extractor 设计文档

> 浏览器扩展:`@bilibili-ext/subtitle-extractor`。提取 B站视频音轨 → 在浏览器本地用 `@voicetxt/core`(Whisper / transformers.js)转写 → 出 SRT/文本。纯前端、零后端、任何电脑装上扩展即可用,数据不出本地。
>
> 配套记忆:[[bili-ai-subtitle-collect]](B站 AI 字幕加密采集)、voicetxt DESIGN.md §1(本扩展即其"后续阶段:浏览器扩展本体")。

---

## 1. 定位与边界

**单一职责**:拿音轨 → 调 `@voicetxt/core` 在浏览器本地 Whisper 转写 → 出字幕。

**两个配置维度**(用户要求):
- **功能开关**:启用/关闭"提取转写"整个流程。
- **模型参数**:model / device / language / wordTimestamps。

**MVP 测试音频**:`~/Desktop/我要一瓶beer.mp3`,Phase 0 手动喂。

**不做(YAGNI)**:
- 音轨来源扩到 B站以外(小宇宙等)——留 source 适配器接口,Phase 后置。
- 不强制回灌 server(server schema 已留 `origin:'asr'` + `asr_engine` 口子,[apps/collector-server/src/db/ingest.ts:137](../../collector-server/src/db/ingest.ts#L137),可选 Phase 后加)。

**形态决策**(已与用户确认):
- 浏览器内执行,不上 server(可移植 + 隐私)。
- 放 bilibili-extensions(不放 voicetxt),复用现成扩展基建。
- `@voicetxt/core` 用 `file:` 协议引 dist,voicetxt 仓库零改动。

---

## 2. 架构与数据流(MV3)

照 [subtitle-collector](../../subtitle-collector) 的 MV3 四件套,**新增第五件 = offscreen document**(仓库首例,跑 core 推理)。

```
  B站视频页                background(SW)           offscreen document          popup(React)
 ─────────────           ───────────────          ─────────────────          ───────────
 inject.js (MAIN)                                   开关 / 模型参数
   拦 player API             content.js                offscreen.js            选音频文件
   取 dash.audio[].baseUrl ─postMsg─▶ (ISOLATED)        import @voicetxt/core    ▼
                                │                    getModelStatus/           ① 手动喂 beer.mp3
                                │ sendMessage        downloadModel             (Phase 0)
                                ▼                    decodeAudio → resample
                            background ──createDoc──▶ → createEngine
                                ▲                      → transcribe
                                │                        │
                                │sendMessage             │ TranscribeResult
                                └────────────────────────┘
                            background ──SRT/文本──▶ popup 展示 / 下载

  ② B站音轨提取(Phase 2):inject 取 audio baseUrl → background 免CORS fetch m4s → arraybuffer → offscreen
```

### 关键决策:offscreen document 直接跑 core,不再起额外 worker

- core 的 worker 桥([voicetxt transcribe.worker.ts](../../../../../voicetxt/packages/web/src/workers/transcribe.worker.ts))是给**有 UI 的网站**避免卡主线程用的。
- offscreen document 本身就是隔离的、无用户交互的后台页,推理慢/阻塞可接受。
- **故 offscreen.js 里直接 `createEngine().transcribe()`,省一整层 worker 消息复杂度**。

### offscreen 生命周期

- service worker 用 `chrome.offscreen.createDocument({url:'offscreen.html', reasons:['WORKERS'], justification:'运行 transformers.js Whisper 推理,需 WASM/Worker 环境(SW 跑不了)'})` 按需创建([chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen));`reasons` 用 `WORKERS`(offscreen 承载推理,transformers 内部用 worker/wasm),实现时若 Chrome 拒绝再换。
- 复用:创建前 `hasDocument()` 检查;SW 被 chrome off 前不主动 close(让 offscreen 续命承载长推理),任务完再 close 释放内存。
- manifest 加 `"permissions": ["offscreen"]`(仓库首例)。

---

## 3. `@voicetxt/core` 引用方式

- subtitle-extractor/package.json:
  ```json
  "dependencies": {
    "@voicetxt/core": "file:../../../voicetxt/packages/core",
    "@huggingface/transformers": "^3.0.4"
  }
  ```
- **前置**:voicetxt 根 `pnpm build:core` 产出 `packages/core/dist`(已验证:tsup ESM,index.js + .d.ts)。
- **关键**:core dist **未 bundle transformers**(tsup external),dist 内是 bare import `@huggingface/transformers`,运行时从 subtitle-extractor 的 node_modules 解析——**故 transformers 必须由 subtitle-extractor 显式安装,不靠 transitive**。
- core 改动后需重 `pnpm build:core`(开发期可接受)。

---

## 4. 功能开关 + 模型参数(四段链路)

照 [subtitle-collector/connection-mode.mjs](../../subtitle-collector/connection-mode.mjs) + [reporting.mjs](../../subtitle-collector/reporting.mjs) 的"纯逻辑 .mjs + `chrome.storage.local` + `apply*()`/`loadPersistedState()` + popup hook + `<Switch>`/`<Select>`"四段链路。

### 4.1 开关(`extract-mode.mjs`,纯逻辑,可 node:test)
- key:`extractEnabled`(bool);`resolveExtractEnabled(v)`(默认 false,显式开才生效)。

### 4.2 模型参数(`whisper-config.mjs`,纯逻辑)
- `model`:`'tiny' | 'base' | 'small' | 'medium' | 'turbo' | 'sensevoice' | 'paraformer'`(对齐 [core ModelId](../../../../../voicetxt/packages/core/src/types.ts))。**Phase 0 默认 `tiny`**(最小,先跑通)。
- `device`:`'wasm' | 'webgpu'`,默认 `wasm`(core 默认;webgpu 对部分模型/显卡输出乱码,[voicetxt transcription/index.ts:18-24](../../../../../voicetxt/packages/core/src/transcription/index.ts#L18))。
- `language`:`'auto' | 'zh' | 'en' | ...`,默认 `auto`。
- `wordTimestamps`:bool,默认 false(逐句);karaoke 需要。
- 存 `chrome.storage.local`,key:`whisperConfig`(JSON)。

### 4.3 UI(popup)
- 开关:抄 [FooterActions 的 `<Switch>`](../../subtitle-collector/src/popup/Popup.tsx#L354)。
- 模型参数:抄 [subtitleFormat 横向抽屉 / `<Select>`](../../subtitle-collector/src/popup/Popup.tsx#L745) + [select.tsx](../../subtitle-collector/src/components/ui/select.tsx)。

### 4.4 消费
- background `loadPersistedState()` 读;offscreen 转写时读 model/device/language;content 决定是否触发自动提取(Phase 2)。

---

## 5. B站音轨提取(Phase 2)

**零新拦截技术**(已确认):音轨 URL 就在 inject.js 已拦的同一个 player API 响应里。

- inject.js(MAIN)读 `window.__playinfo__`(B站视频页 SSR 写入的 playurl 结果)的 `data.dash.audio[0].baseUrl` / `backupUrl`。**关键修正:dash 不在 `/x/player/wbi/v2`(那只是字幕/元信息端点,响应无 `video_info`/`dash`),而在 playurl 响应,SSR 写进 `__playinfo__`**(播放器自己也用它)。inject `document_start` 注入,轮询 `__playinfo__`(SSR 写入时机不定),取到后 `postMessage("AUDIO_TRACKS", ...)` 给 content.js。
- 抓 m4s 二进制:复用 [background.js:382 `FETCH_SUBTITLE`](../../subtitle-collector/background.js#L382) 免 CORS 直 fetch 范式,改 `FETCH_AUDIO` 返回 arraybuffer(`fetch(url, {headers:{Referer:'https://www.bilibili.com/'}})`)。
- **付费/充电视频加密墙兜底**:类比 AI 字幕 `%00` 加密([bili-fetch.js:61](../../subtitle-collector/bili-fetch.js#L61)),可能要复用"点播放器按钮让播放器内部解码"手法([content.js:139 triggerAiSubtitle](../../subtitle-collector/content.js#L139))——Phase 2 遇到再定。

---

## 6. 字幕产物

- **SRT**:复用 [subtitle-collector/subtitleFormat.mjs:81 subtitleToSRT](../../subtitle-collector/subtitleFormat.mjs#L81) + [formatSrtTime L34](../../subtitle-collector/subtitleFormat.mjs#L34)。
- **字段映射适配器**:B站字幕 cue `{from,to,content}` ↔ Whisper segment `{start,end,text}`([core Segment](../../../../../voicetxt/packages/core/src/types.ts#L32))。写 `srt-adapter.mjs` 做 `{start,end,text} → {from,to,content}` 再喂 subtitleToSRT,或直接写 Whisper→SRT(更省)。
- 其他格式:core 已导出 `toPlainText/toSRT/toVTT/toJSON/toKaraoke`([voicetxt formats](../../../../../voicetxt/packages/core/src/formats/index.ts)),可直接用。
- **导出**:popup 下载 .srt / 复制文本。
- **可选回灌 server**:Phase 后,走现有 ingest 通道(标记 `origin:'asr'`, `asr_engine:'whisper'`)。

---

## 7. 分阶段切片 + 风险登记

### Phase 0 —— 先证伪最大风险(当前)
**范围**:扩展骨架 + popup 选 beer.mp3 → background → offscreen 跑 core(tiny/wasm)→ 出纯文本。

**验证(任一卡住都要解决)**:
| # | 风险点 | 验证方式 |
|---|---|---|
| R1 | core dist 能否被 vite/crxjs 正确打包/import | `vite build` 通过 + dist 里 offscreen chunk 含 core |
| R2 | transformers.js + onnxruntime wasm 在 MV3 offscreen 能加载 | offscreen 里 `pipeline()` 不抛 CSP/wasm 错 |
| R3 | offscreen 能跑 `AudioContext.decodeAudioData` + `OfflineAudioContext`(core decodeAudio 依赖) | beer.mp3 能解码到 Float32Array |
| R4 | 模型能从 HF CDN 下载并缓存 IndexedDB | `downloadModel('tiny')` 完成,二次秒回 cached |
| R5 | createEngine + transcribe 出结果 | beer.mp3 转出可读文本 |
| R6 | offscreen↔background↔popup 消息链路通 | popup 收到结果文本 |

### Phase 1 —— 开关 + 模型参数
四段链路落齐,UI 能存能读能生效。

### Phase 2 —— B站音轨提取
inject 取 audio baseUrl + background 免 CORS fetch m4s → arraybuffer → offscreen 转写。

### Phase 3 —— SRT 产物
SRT 格式化 + 下载/复制;可选回灌 server。

### transformers 资产策略(Phase 0 已验证)
- **ort wasm/mjs 本地化(必须)**:MV3 CSP 硬禁远程脚本,transformers 默认从 jsdelivr CDN 动态 import `ort-wasm-*.mjs` 被拒(`no available backend found`)。解法:[copy-ort.mjs](./scripts/copy-ort.mjs) 把 `ort-wasm-simd-threaded.jsep.{mjs,wasm}` 拷到 `public/ort/` → vite 输出 `dist/ort/`;offscreen 设 `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')` + `numThreads=1`(规避扩展页缺 cross-origin isolation → SharedArrayBuffer 不可用)。
- **模型**:走 HF CDN(core `env.allowLocalModels=false`),host_permissions 已加 HF CDN。✅ 验证 tiny 下载缓存成功。
- **CSP**:`extension_pages` 加 `wasm-unsafe-eval`(ort wasm 需要)。✅
- **音频传输(关键坑)**:popup→SW→offscreen 用 **base64 data URL**(`FileReader.readAsDataURL`),**非 ArrayBuffer**——`chrome.runtime.sendMessage` 跨 SW/offscreen 传 ArrayBuffer 会损坏致 `decodeAudioData` 失败(`Unable to decode audio data`)。

---

## 8. 验收清单 + 测试轮次记录

> 约定(对齐全局/项目 CLAUDE.md):验收章节位置灵活,但每个 spec 必含测试轮次记录表。

### 8.1 功能验收清单
| ID | 项 | Phase | 覆盖测试 |
|---|---|---|---|
| A1 | 扩展能加载、popup 能开 | 0 | verify-extractor.mjs 冒烟 |
| A2 | popup 选 beer.mp3 → 出转写文本 | 0 | verify-extractor.mjs 端到端 |
| A3 | 开关关闭时不触发提取 | 1 | extract-mode.test.mjs |
| A4 | 模型参数能持久化、能生效 | 1 | whisper-config.test.mjs |
| A5 | B站视频页能提取音轨并转写 | 2 | verify-extractor.mjs(bili mock) |
| A6 | 能导出 SRT 文件 | 3 | srt-adapter.test.mjs |

### 8.2 测试轮次记录
| 轮次 | 日期 | 范围 | 结果 | 备注 |
|---|---|---|---|---|
| T1 | 2026-07-16 | Phase 0 端到端(beer.mp3 → 文本) | ✅ 通过 | R1-R6 全打穿。两个关键修复:① ort wasm 本地化(copy-ort.mjs,MV3 CSP 拒 CDN)② 音频改 base64 data URL 传输(ArrayBuffer 跨 messaging 损坏致 decode 失败)。tiny+zh 出中文"我要一平平的"(质量待 base 档提升) |
| T2 | 2026-07-16 | Phase 1 配置链路 + base 质量 | ✅ 通过 | 配置四段链路生效(SET_WHISPER_CONFIG→bg→offscreen 用 base,见"下载模型 base");base+zh 出"我要一瓶啤酒"(准确,vs tiny"我要一平平的")。两个修复:① verify click 用 data-testid(Radix Switch 渲染成 button 误占首位,`click('button')` 点成开关)② offscreen PROGRESS 节流 150ms(core onProgress 每 timestep 触发,实测 9s 涌 1944+ 条致消息洪泛) |
| T3 | 2026-07-16 | Phase 3 SRT/VTT 导出 | ✅ 通过 | core toSRT/toVTT 纯函数复用(offscreen RESULT 一次性格式化,无需适配器);popup 格式 Select(SRT/VTT/TXT)+ 下载(Blob)+ 复制。tiny 实测出 `1\n00:00:00,000 --> 00:00:04,000\n我要一平平的`。verify 断言 SRT 含 `-->` 时间戳 |
| T4 | 2026-07-16 | Phase 2 B站音轨提取 + m4s decode | ✅ 通过 | inject 读 `window.__playinfo__`(playurl SSR,dash.audio[0].baseUrl);bg 免 CORS fetch m4s+Referer→base64 dataUrl→offscreen。**两个关键点**:① dash 来源是 `__playinfo__` 不是 player/wbi/v2(它无 dash,首版实测 code=0 但 hasVideoInfo=false)② **m4s(fMP4)能被 decodeAudioData 解码**(最大风险消除)。verify-phase2 BV1ufKM64Ew3 端到端:base+zh 识别出中文。412 风控不影响主链路 |

---

## 9. 关键文件清单(对齐 subtitle-collector 约定)

```
apps/subtitle-extractor/
├─ manifest.json              # MV3,+offscreen permission, +HF CDN host_perm, +CSP wasm-unsafe-eval
├─ vite.config.ts             # vite+crxjs+react,dev 端口钉死(≠5173/5174),strictPort
├─ tsconfig.json              # 抄 subtitle-collector
├─ package.json               # @bilibili-ext/subtitle-extractor, file: 引 core, +transformers
├─ background.js              # SW:offscreen 生命周期 + 消息转发 + loadPersistedState
├─ content.js                 # (Phase 2) ISOLATED,收 inject postMessage
├─ inject.js                  # (Phase 2) MAIN,拦 player API 取 audio baseUrl
├─ extract-mode.mjs           # (Phase 1) 开关纯逻辑
├─ whisper-config.mjs         # (Phase 1) 模型参数纯逻辑
├─ srt-adapter.mjs            # (Phase 3) Whisper result → SRT
├─ offscreen.html             # offscreen document 宿主
├─ offscreen.js               # import core:downloadModel→decode→createEngine→transcribe
├─ scripts/generate-icons.mjs # 抄 subtitle-collector
├─ icons/                     # icon.svg → PNG
├─ src/popup/                 # React popup(main.tsx/Popup.tsx/hooks.ts)
├─ src/components/ui/         # shadcn(switch/select/...)
└─ test/*.test.mjs            # node --test 纯函数
```

dev 端口候选:**5175**(5173=collector-web,5174=subtitle-collector 已占),`strictPort:true`([vite.config.ts:15-20 注释](../../subtitle-collector/vite.config.ts#L15) 解释了 crxjs 烧死端口的坑)。
