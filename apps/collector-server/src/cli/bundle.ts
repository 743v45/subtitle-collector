// export bundle 原料包：ANALYZE.md 模板 + 字幕行格式化 + buildBundle 组装。
// 设计：[export bundle 设计文档](../../../docs/superpowers/specs/2026-08-19-export-bundle-design.md)。
// 措辞：字幕（subtitle），非弹幕。分析在 Claude Code 会话完成，本模块只产原料。

import { extractBody } from './subtitleFormat.js';

// ── 时间格式化 ──

/** 秒 → `分:秒`（<1h，两位补零）或 `时:分:秒`。负值归零，四舍五入。 */
export function secsToClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── 字幕正文行格式 ──

/**
 * 字幕 payload → `[分:秒] 字幕内容` 行格式（bundle 正文专用）。
 * 与 convertSubtitle 'txt'（纯文本无时间戳）不同：行首轻量时间戳供分析产物引用出处。
 * payload 结构不符时抛错（extractBody），调用方 catch 后记 manifest errors[]。
 */
export function stampedTxt(payload: unknown): string {
  const lines = extractBody(payload)
    .map((item) => ({ at: secsToClock(item.from), text: item.content.trim() }))
    .filter((l) => l.text.length > 0)
    .map((l) => `[${l.at}] ${l.text}`);
  return `${lines.join('\n')}\n`;
}

// ── ANALYZE.md 模板（随每个 bundle 生成；产物规范单一来源，勿在他处复制）──

export const ANALYZE_MD = `# 分析指引（bundle 自述）

本目录是**分析原料包**：\`manifest.json\`（视频清单与导出条件）+ \`videos/*.txt\`（每视频字幕正文，行格式 \`[分:秒] 字幕\`）。

**分析产物写回本目录**（与原料同级）。按用途选模板，产物文件名固定：

| 用途 | 产物文件 |
|---|---|
| 某话题多 UP 观点聚合 | \`观点汇总.md\` |
| 面试题整理 | \`面试题库.md\` |
| 单 UP 理念提炼 | \`理念整理.md\` |

**硬性要求**：
1. 每条观点/题目/金句必须附出处：\`> 来源: <视频标题> [分:秒]\`，时间戳取自 \`videos/<BV号>.txt\` 行首，可回溯。
2. \`manifest.json\` 中 \`subtitle: null\` 的视频无正文（采集盲区），在「覆盖盲区」如实列出，勿假装看过。
3. 结论只用原料支持的说法，区分「视频里明说」与「分析者推断」。

---

## 模板一：观点汇总.md（多 UP 同话题）

\`\`\`markdown
# <主题> 观点汇总

> 原料：N 个视频 / M 位 UP（见 manifest.json）；生成：<日期>

## 共识（多方一致）
- <观点>
  > 来源: 视频A [12:34]、视频B [03:21]

## 分歧（说法相左）
### <议题>
- 立场甲：<观点>
  > 来源: 视频A [12:34]
- 立场乙：<观点>
  > 来源: 视频C [45:06]

## 值得追的线索
- <待验证 / 延伸阅读>

## 覆盖盲区
- <subtitle:null 视频 / 主题未覆盖的流派>
\`\`\`

## 模板二：面试题库.md（面试内容整理）

\`\`\`markdown
# <主题> 面试题库

> 原料：N 个视频；生成：<日期>

## <子主题>
### Q1. <题目>
- **考点**：
- **参考答案**（从字幕提炼）：
  > 来源: 视频A [12:34]
- **常见追问**：
\`\`\`

## 模板三：理念整理.md（单 UP 系列）

\`\`\`markdown
# <UP 主名> 理念整理

> 原料：N 个视频（<最早发布> ~ <最晚发布>）；生成：<日期>

## 核心理念（一句话）

## 方法论 / 原则
- <原则>
  > 来源: 视频A [12:34]

## 理念演变（按发布时间）

## 金句
- 「<原话>」
  > 来源: 视频B [05:00]
\`\`\`
`;
