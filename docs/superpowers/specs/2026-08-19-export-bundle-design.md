# export bundle 原料包导出（批量提取分析 · 消费端第一块）设计

> 日期：2026-08-19
> 状态：已确认（对话内设计已获用户批准）
> 关联：[README「目标与功能」](../../../README.md) §批量提取分析、[CLAUDE.md §6](../../../CLAUDE.md) Feature 列表纪律
> 定位：**消费端链路第一块**——「批量采集 → **批量提取分析** → 产物」中缺失的中段。

---

## 1. 概述

新增 CLI 命令 `export bundle`：按任意过滤条件（UP 主 / 搜索主题 / 标签 / 付费 / 时间…）从库里选出一批视频，把每个视频的**元信息 + 默认轨字幕正文**打包成一个自包含的分析原料目录：

```
<out>/
├── manifest.json      # 导出条件 + 视频清单（含无字幕标记）
├── videos/
│   └── BV1xxx.txt     # 头部元信息 + 字幕正文
└── ANALYZE.md         # 三类分析产物模板 + 产物落点约定
```

分析本身在 Claude Code 会话中完成（系统不集成 AI），产物写回 bundle 同目录——bundle 是原料+产物的自包含单元。

## 2. 背景

采集端三入口已全通（3400 视频 / 6118 轨），但消费端为 0：唯一一次端到端产出（`info/summary.md`）是手工逐条导出的。分析一个主题需要几十个视频的字幕，现状只能逐视频 `export subtitle`（几十次调用）或 web 页逐个复制，不可用。`export bundle` 把「一批视频 → 一包原料」变成一条命令。

## 3. 需求（已确认）

| 项 | 决定 |
|---|---|
| 入口 | 单命令 `export bundle` + 全量过滤器复用（不为 UP 主/搜索做专门子命令） |
| 过滤器 | 同 `videos list` 全套（q/creator/tag/paid/subtitle-q/lang/since/until/view/duration/sort…），**不含 page/size**（bundle 语义=全量打包） |
| 视频集规模 | `--limit <n>` 截断保护，默认 500 |
| 无字幕视频 | 不导出正文，manifest 记 `"subtitle": null`（诚实暴露采集盲区） |
| 轨选择 | 默认轨优先级（CC中文 > AI中文 > en > 其他；version origin external > manual > asr）；`--track <lan>` 统一覆盖 |
| 字幕格式 | txt（分析原料，纯文本最优；不做格式参数，YAGNI） |
| 分析执行方 | Claude Code 会话，系统零 AI 集成 |
| 产物落点 | 写回 bundle 同目录（`观点汇总.md` / `面试题库.md` / `理念整理.md`） |
| 数据源边界 | 视频/字幕内容，**不含评论区**（远期另议） |

## 4. 设计

### 4.1 命令形态

```bash
pnpm --filter @bilibili-ext/collector-server cli export bundle \
  --creator "某UP" --out analysis/某UP-20260819/

pnpm --filter @bilibili-ext/collector-server cli export bundle \
  --q "rust 面试" --limit 100 --out analysis/rust面试-20260819/
```

### 4.2 manifest.json schema

```jsonc
{
  "generated_at": 1724059200000,          // 毫秒
  "filters": { /* 原始过滤条件，camelCase 原样回显 */ },
  "total_matched": 3400,                  // 过滤命中总数
  "exported": 320,                        // 实际导出（limit 截断后）
  "limit": 500,
  "videos": [
    {
      "id": 123, "source": "bilibili", "source_vid": "BV1xxx",
      "title": "…", "creator_name": "…", "creator_source_uid": "…",
      "duration": 1234,                    // 秒
      "published_at": 1724000000000,       // 毫秒 | null
      "first_seen_at": 1724050000000,
      "track_count": 2,
      "subtitle": {                        // 无字幕/轨缺失时为 null
        "file": "videos/BV1xxx.txt",
        "lan": "zh-Hans", "track_type": 1, // 1=AI 2=CC
        "version_id": 456, "origin": "asr"
      }
    }
  ]
}
```

字段来源：清单字段 = `VideoListItemAdvanced`（[advanced.ts:40](../../advanced.ts#L40)），轨信息 = 字幕解析结果。

### 4.3 videos/<bvid>.txt 结构

```
# <标题>
UP: <creator_name>  时长: <mm:ss>  发布: <YYYY-MM-DD>  BV: <source_vid>
轨: <lan_doc>(<lan>, AI|CC)  来源: <origin>

<字幕正文（默认轨 txt）>
```

### 4.4 ANALYZE.md 模板（随 bundle 生成）

自述文件：说明目录构成、产物落点约定（写回本目录），含三类产物模板骨架：

- **观点汇总.md**：共识（多来源引用）→ 分歧（观点对垒）→ 值得追的线索 → 覆盖盲区（对照 manifest 中 `subtitle:null`）
- **面试题库.md**：题目（按主题分组）→ 考点 → 参考答案（从字幕提炼）→ 来源 `[时间戳]`
- **理念整理.md**：核心理念一句话 → 方法论/原则清单 → 按发布时间的演变 → 金句（附出处）

每条观点/答案必须附出处（视频标题 + `[mm:ss]` 时间戳），可回溯到 `videos/<bvid>.txt`。

### 4.5 实现架构（复用为主）

| 部件 | 复用 | 新增 |
|---|---|---|
| 视频集选取 | `videosList(db, opts)`（[videos.ts:68](../../cli/commands/videos.ts#L68)），size=limit 一次取全 | 过滤器装配（同 export videos 模式，去 page/size） |
| 字幕解析 | `resolveSubtitle(db, opts)`（[export.ts:51](../../cli/commands/export.ts#L51)） | **返回值扩展**：ok 分支加 `trackLan` / `trackType` / `versionOrigin`（向后兼容，现有调用方不受影响） |
| bundle 组装 | — | 纯函数 `buildBundle(db, opts): BundleResult`（manifest 对象 + `files: Array<{path, content}>`，不落盘，便于单测） |
| 落盘 | — | action 内 `mkdirSync(recursive)` + 逐文件写入；`--out` 目录已存在且非空 → 覆盖前需 `--force`（防误写） |
| ANALYZE.md | — | 模板字符串常量（单一来源，勿在多处复制） |

装配位置：`buildExportCommand()`（[export.ts:175](../../cli/commands/export.ts#L175)）内新增子命令，与 subtitle / videos 并列。

### 4.6 错误处理

| 情形 | 行为 | 退出码类别 |
|---|---|---|
| `--out` 缺失 | ARGS 错误（必填） | ARGS |
| `--out` 已存在且非空且无 `--force` | 拒绝，提示 `--force` | ARGS |
| 单视频字幕转换抛错（payload 损坏） | 该视频记 `subtitle: null` + manifest `errors[]` 备注，**不中断整包** | — |
| 过滤命中 0 个视频 | 正常产出（空 manifest + ANALYZE.md），回执 exported=0 | — |
| db 不可读 | DB_UNREADABLE（同现有命令） | DB_UNREADABLE |

### 4.7 回执（stdout，emitResult）

```jsonc
{ "ok": true, "path": "<out>", "videos_total": 3400, "exported": 320,
  "with_subtitle": 310, "without_subtitle": 10, "files": 322 }
```

## 5. 测试

方式对齐项目测试政策（CLAUDE.md §3）：`node --test --import tsx` 纯函数单测 + 真库冒烟。

- **单测**（`export bundle` 纯函数，内存 sqlite fixture，参考 [advanced.test.ts](../../db/advanced.test.ts) 建库模式）：
  - buildBundle：多视频含字幕 → manifest 完整 / 文件内容含头部元信息；无字幕视频 → `subtitle:null` 不出文件；`--track` 覆盖默认轨；limit 截断（total_matched > exported）；空命中；payload 损坏 → errors[] 不中断
  - resolveSubtitle 扩展返回值：默认轨带 lan/track_type/origin
  - ANALYZE.md 常量：包含三类模板锚点字符串
- **真库冒烟**（本地验收，不进 CI）：对 `~/Code/yawyd/subtitle-collector/data/bilibili-collector.db` 只读跑一次真实导出（小 limit），检查目录结构 + 抽查 1 个 txt 头部。
- **回归**：现有 `export subtitle` / `export videos` 测试全绿（resolveSubtitle 返回值扩展的向后兼容）。

### 测试轮次记录表

| 轮次 | 日期 | 范围 | 结果 | 备注 |
|---|---|---|---|---|
| 1 | 2026-08-19 | 单测（stampedTxt/ANALYZE/buildBundle 9 用例 + 装配端到端 2 用例，全套 243 绿）+ 真库冒烟（yawyd 库：3136 命中 → limit 5，with_subtitle=5） | 通过 | 抽查 txt 头部元信息、`[分:秒]` 行格式、manifest 条目均符合设计 |

## 6. 不做（YAGNI）

- 评论采集（数据源边界，远期）
- 字幕格式参数（txt 固定；要 srt/vtt 用 `export subtitle`）
- 播放量/标签进 manifest（分析原料非必需；需要时从详情接口补）
- 内置 AI 分析 pipeline（远期，见 README 📋 项）
- bundle 增量更新 / 断点续传（首批真实使用反馈前不做）
