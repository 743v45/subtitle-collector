// export bundle 原料包：ANALYZE.md 模板 + 字幕行格式化 + buildBundle 组装。
// 设计：[export bundle 设计文档](../../../docs/superpowers/specs/2026-08-19-export-bundle-design.md)。
// 措辞：字幕（subtitle），非弹幕。分析在 Claude Code 会话完成，本模块只产原料。

import { extractBody } from './subtitleFormat.js';
import type Database from 'better-sqlite3';
import { videosList, type VideosListOpts } from './commands/videos.js';
import { resolveSubtitle } from './commands/export.js';

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

// ── buildBundle 类型 ──

export interface BundleSubtitleMeta {
  file: string;                 // 相对 bundle 根
  lan: string | null;
  lan_doc: string | null;
  track_type: number | null;    // 1=AI 2=CC
  version_id: number;
  origin: string;               // external | manual | asr
}

export interface BundleVideoEntry {
  id: number; source: string; source_vid: string;
  title: string; creator_name: string | null; creator_source_uid: string | null;
  duration: number | null; published_at: number | null; first_seen_at: number;
  track_count: number;
  subtitle: BundleSubtitleMeta | null;  // null = 无字幕/轨缺失/payload 损坏
}

export interface BundleManifest {
  generated_at: number;
  filters: VideosListOpts;      // camelCase 原样回显（since/until 为毫秒数）
  total_matched: number;
  exported: number;
  limit: number;
  videos: BundleVideoEntry[];
  errors?: Array<{ source_vid: string; message: string }>;
}

export interface BundleFile { path: string; content: string; }  // path 相对 bundle 根
export interface BundleResult { manifest: BundleManifest; files: BundleFile[]; }

export interface BuildBundleOpts {
  filters: VideosListOpts;  // 不含 page/size（buildBundle 内部固定 page=1, size=limit）
  track?: string;           // 统一覆盖默认轨
  limit: number;            // >0
  now: number;              // generated_at（毫秒，注入保持纯函数）
}

// ── 视频正文头部（标题 + 元信息一行 + 轨一行 + 空行 + 正文）──

function videoHeader(v: BundleVideoEntry, sub: BundleSubtitleMeta): string {
  const dur = v.duration != null ? secsToClock(v.duration) : '未知';
  const pub = v.published_at != null ? new Date(v.published_at).toISOString().slice(0, 10) : '未知';
  const trackTypeLabel = sub.track_type === 2 ? 'CC' : sub.track_type === 1 ? 'AI' : '?';
  const trackLabel = sub.lan_doc && sub.lan ? `${sub.lan_doc}(${sub.lan}, ${trackTypeLabel})` : `${sub.lan ?? '(无lan)'}`;
  return [
    `# ${v.title}`,
    `UP: ${v.creator_name ?? '未知UP'}  时长: ${dur}  发布: ${pub}  BV: ${v.source_vid}`,
    `轨: ${trackLabel}  版本来源: ${sub.origin}`,
    '',
  ].join('\n');
}

// ── 组装（纯函数：只读 db，不落盘；时间由 opts.now 注入）──

export function buildBundle(db: Database.Database, opts: BuildBundleOpts): BundleResult {
  const page = videosList(db, { ...opts.filters, page: 1, size: opts.limit });
  const videos: BundleVideoEntry[] = [];
  const files: BundleFile[] = [{ path: 'ANALYZE.md', content: ANALYZE_MD }];
  const errors: Array<{ source_vid: string; message: string }> = [];

  for (const v of page.items) {
    const entry: BundleVideoEntry = {
      id: v.id, source: v.source, source_vid: v.source_vid,
      title: v.title, creator_name: v.creator_name, creator_source_uid: v.creator_source_uid,
      duration: v.duration, published_at: v.published_at, first_seen_at: v.first_seen_at,
      track_count: v.track_count, subtitle: null,
    };
    const r = resolveSubtitle(db, { source: v.source, sourceVid: v.source_vid, track: opts.track, format: 'json' });
    if (r.kind === 'ok') {
      try {
        const body = stampedTxt(r.payload);
        const sub: BundleSubtitleMeta = {
          file: `videos/${v.source_vid}.txt`,
          lan: r.trackLan ?? null, lan_doc: r.trackLanDoc ?? null,
          track_type: r.trackType ?? null, version_id: r.versionId, origin: r.versionOrigin ?? '?',
        };
        entry.subtitle = sub;
        files.push({ path: sub.file, content: `${videoHeader(entry, sub)}${body}` });
      } catch (err) {
        // payload 损坏：记 errors、subtitle 保持 null，不中断整包
        errors.push({ source_vid: v.source_vid, message: (err as Error).message });
      }
    }
    videos.push(entry);
  }

  const manifest: BundleManifest = {
    generated_at: opts.now, filters: opts.filters,
    total_matched: page.total, exported: page.items.length, limit: opts.limit,
    videos, ...(errors.length > 0 ? { errors } : {}),
  };
  files.unshift({ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  return { manifest, files };
}
