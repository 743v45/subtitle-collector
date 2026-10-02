// export bundle 原料包：ANALYZE.md 模板 + 字幕行格式化 + buildBundle 组装。
// 设计：[export bundle 设计文档](../../../docs/superpowers/specs/2026-08-19-export-bundle-design.md)。
// 措辞：字幕（subtitle），非弹幕。分析在 Claude Code 会话完成，本模块只产原料。

import { extractBody, resolveSubtitle } from './subtitleFormat.js';
import type Database from 'better-sqlite3';
import { videosList, type VideosListOpts } from './commands/videos.js';
import { latestTaskStatusByVideoIds } from '../db/advanced.js';
import { getVideoTagsByVideoIds } from '../db/tags.js';
import { getTagPriority, type TagPrioritySource } from '../db/settings.js';

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
 * payload → 非空字幕行数组：line = `[分:秒] 字幕内容`（bundle 正文专用行格式），from = 末行时间戳所需的原始秒。
 * 与 convertSubtitle 'txt'（纯文本无时间戳）不同：行首轻量时间戳供分析产物引用出处。
 * stampedTxt（正文拼装）与 buildBundle（subtitle.lines/last_ts 元数据）共用，保证行口径单一。
 * payload 结构不符时抛错（extractBody），调用方 catch 后记 manifest errors[]。
 */
export interface StampedLine { from: number; line: string; }

export function stampedLines(payload: unknown): StampedLine[] {
  return extractBody(payload)
    .map((item) => ({ from: item.from, at: secsToClock(item.from), text: item.content.trim() }))
    .filter((l) => l.text.length > 0)
    .map((l) => ({ from: l.from, line: `[${l.at}] ${l.text}` }));
}

/** 行数组 → 正文文本（每行一条、末尾换行；stampedTxt 与 buildBundle 共用的唯一拼装处）。 */
function linesToTxt(lines: StampedLine[]): string {
  return `${lines.map((l) => l.line).join('\n')}\n`;
}

export function stampedTxt(payload: unknown): string {
  return linesToTxt(stampedLines(payload));
}

// ── ANALYZE.md 模板 ──
// 模板本体在 ./analyze-template.ts（模块 ≤400 行上限拆分，2026-10-02）；import 供本文件组包用，re-export 维持既有导入路径。
import { ANALYZE_MD } from './analyze-template.js';
export { ANALYZE_MD };

// ── buildBundle 类型 ──

export interface BundleTag { name: string; scope: string; }

export interface BundleSubtitleMeta {
  file: string;                 // 相对 bundle 根
  lan: string | null;
  lan_doc: string | null;
  track_type: number | null;    // 1=AI 2=CC 3=翻译轨
  version_id: number;
  origin: string;               // external | manual | asr
  lines: number;                // 该轨非空行数（原始量；覆盖残缺判定留给分析会话，不算比例不设阈值）
  last_ts?: number;             // 末行起始时间戳（秒）；末行时间解析失败时省略字段
}

export interface BundleVideoEntry {
  id: number; source: string; source_vid: string;
  title: string; creator_name: string | null; creator_source_uid: string | null;
  duration: number | null; published_at: number | null; first_seen_at: number;
  track_count: number;
  // 全部标签 [{name, scope}]（六档：manual/batch/ai/system 关系表 + bili/season extra 实时读，
  // 同名按 tag_priority 去重保优先档，对齐 http/queries.ts enrichItems 口径；无标签为空数组）
  tags: BundleTag[];
  // 播放量（extra.stat.view）；extra 缺 stat.view 时省略字段
  view?: number;
  subtitle: BundleSubtitleMeta | null;  // null = 无字幕/轨缺失/payload 损坏
  // 受限标记：该视频最近一次 collect_tasks 任务 status='limited'（半入库：元信息在、0 轨，
  // 如 YouTube pot 门槛）。与「真无字幕」的区分字段——重采成功后最新任务不再是 limited，
  // 标记自然消失（从任务表派生而非 videos 加列，免去回清维护，见 latestTaskStatusByVideoIds）。
  pot_limited: boolean;
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
  nameOrder?: FilenamePart[];  // videos/ 文件名组件与顺序（默认 ['id','name']，即 <id>-<name>）
}

// ── 视频文件名（videos/<部件>.txt；--name-order 定组件与顺序，默认 id,name）──

export const FILENAME_PARTS = ['id', 'name', 'time', 'author'] as const;
export type FilenamePart = (typeof FILENAME_PARTS)[number];

/** 文件名部件清洗：非法字符（路径分隔/控制符/Win 保留）→ `_`，连续空白压单空格。 */
function sanitizeNamePart(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** name/author 字符数上限（中文一字 3 字节，防 255 字节文件名上限的组件级截断）。 */
const PART_CHAR_MAX = { name: 60, author: 30 } as const;

/** 按 code point 截到 ≤maxBytes UTF-8 字节（组件级截断后的整体兜底，防极端叠加超长）。 */
function truncateUtf8(s: string, maxBytes: number): string {
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * 视频条目 → videos/ 下文件名（不含 .txt）：按 order 依次取组件 `-` 连接。
 * - id=平台视频ID（BV号/YT ID）；name=标题；time=发布日期 YYYY-MM-DD（缺 published_at 用
 *   first_seen_at 兜底）；author=UP 名。name/author 清洗+截断，缺值则整段连同分隔符跳过。
 * - 全部组件为空时兜底 source_vid（保证文件名非空且按视频唯一）。
 */
export function videoFileName(
  v: Pick<BundleVideoEntry, 'source_vid' | 'title' | 'creator_name' | 'published_at' | 'first_seen_at'>,
  order: readonly FilenamePart[],
): string {
  const parts: string[] = [];
  for (const part of order) {
    if (part === 'id') parts.push(v.source_vid);
    else if (part === 'name') parts.push(sanitizeNamePart(v.title).slice(0, PART_CHAR_MAX.name));
    else if (part === 'time') {
      const ts = v.published_at ?? v.first_seen_at;
      if (ts != null) parts.push(new Date(ts).toISOString().slice(0, 10));
    } else {
      const a = v.creator_name ? sanitizeNamePart(v.creator_name).slice(0, PART_CHAR_MAX.author) : '';
      if (a) parts.push(a);
    }
  }
  return truncateUtf8(parts.filter(Boolean).join('-'), 240) || v.source_vid;
}

// ── 视频正文头部（标题 + 元信息一行 + 轨一行 + 轨覆盖 + 空行 + 正文）──

export function videoHeader(v: BundleVideoEntry, sub: BundleSubtitleMeta): string {
  const dur = v.duration != null ? secsToClock(v.duration) : '未知';
  const pub = v.published_at != null ? new Date(v.published_at).toISOString().slice(0, 10) : '未知';
  const trackTypeLabel = sub.track_type === 2 ? 'CC' : sub.track_type === 1 ? 'AI' : sub.track_type === 3 ? '翻译' : '?';
  const trackLabel = sub.lan_doc && sub.lan ? `${sub.lan_doc}(${sub.lan}, ${trackTypeLabel})` : `${sub.lan ?? '(无lan)'}`;
  // 轨覆盖：末行时间戳（原始信息直出，不加可疑标记；last_ts 缺失不显示）
  const cover = sub.last_ts != null ? `  轨覆盖: 至 ${secsToClock(sub.last_ts)}` : '';
  // 平台 ID 前缀按 source 条件（B 站 BV 号 / YouTube 11 位 ID / 抖音 aweme_id），不再一律写死「BV:」
  const vidLabel = v.source === 'bilibili' ? 'BV' : v.source === 'youtube' ? 'YT' : v.source === 'douyin' ? 'DY' : v.source;
  return [
    `# ${v.title}`,
    `UP: ${v.creator_name ?? '未知UP'}  时长: ${dur}  发布: ${pub}  ${vidLabel}: ${v.source_vid}`,
    `轨: ${trackLabel}  版本来源: ${sub.origin}${cover}`,
    '',
  ].join('\n');
}

// ── buildBundle 组装辅助 ──

/**
 * 批量取 extra 派生量（view 播放量 + bili/season 标签），参照 http/queries.ts enrichItems 的富化方式：
 * 单条 IN 查询防 N+1（对齐 latestTaskStatusByVideoIds 先例）。extra 缺字段/坏 JSON → 对应量缺省。
 */
function videoExtrasByVideoIds(
  db: Database.Database,
  ids: number[],
): Map<number, { view: number | null; biliNames: string[]; seasonNames: string[] }> {
  const map = new Map<number, { view: number | null; biliNames: string[]; seasonNames: string[] }>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id,
            CAST(json_extract(extra, '$.stat.view') AS INTEGER) AS view,
            json_extract(extra, '$.tags') AS bili_tags,
            json_extract(extra, '$.ugc_season.title') AS season_title
       FROM videos WHERE id IN (${placeholders})`,
  ).all(...ids) as Array<{ id: number; view: number | null; bili_tags: string | null; season_title: string | null }>;
  for (const r of rows) {
    // bili 档：extra.tags 是 [{tag_name}] 数组的 JSON（坏 JSON/非数组 → 空档，对齐 enrichItems 容错）
    let biliNames: string[] = [];
    if (r.bili_tags) {
      try {
        const arr = JSON.parse(r.bili_tags) as unknown;
        if (Array.isArray(arr)) {
          biliNames = (arr as Array<{ tag_name?: unknown }>)
            .map((x) => (x && typeof x.tag_name === 'string' ? x.tag_name : null))
            .filter((t): t is string => t !== null);
        }
      } catch { biliNames = []; }
    }
    map.set(r.id, { view: r.view ?? null, biliNames, seasonNames: r.season_title ? [r.season_title] : [] });
  }
  return map;
}

/**
 * 视频全量标签（六档合并，对齐 http/queries.ts enrichItems 口径）：同名按 tag_priority 去重保优先档，
 * 档位序 + 名称序稳定排序。镜像实现说明：queries.ts 的 mergeTagDetails 是私有函数不导出，且 http→cli
 * 反向依赖会违反 depcruise 分层，故 CLI 侧复刻一份（latestTaskStatusByVideoIds 先例同款取舍）；两处需同步改。
 */
function mergeBundleTags(
  db: Database.Database,
  ids: number[],
  extras: Map<number, { biliNames: string[]; seasonNames: string[] }>,
): Map<number, BundleTag[]> {
  const priority = getTagPriority(db);
  const rank = new Map(priority.map((s, i) => [s, i]));
  const relTags = getVideoTagsByVideoIds(db, ids);
  const out = new Map<number, BundleTag[]>();
  for (const id of ids) {
    // videoExtrasByVideoIds 对本页每个 id 必有键（required=true 时必有值，同款断言风格）
    const ex = extras.get(id)!;
    // 关系档与 extra 无关，单独解析（无标签视频 map 缺键 → 空档）
    const rel = (relTags.get(id) ?? []).map((t) => ({ name: t.name, scope: t.source }));
    const all = [
      ...ex.biliNames.map((name) => ({ name, scope: 'bili' as const })),
      ...rel,
      ...ex.seasonNames.map((name) => ({ name, scope: 'season' as const })),
    ];
    const winner = new Map<string, { name: string; scope: TagPrioritySource }>();
    for (const t of all) {
      const cur = winner.get(t.name);
      // scope 恒为 TagPrioritySource 六档之一、rank 覆盖全档，取值必有（免 ?? 兜底分支）
      if (!cur || rank.get(t.scope)! < rank.get(cur.scope)!) winner.set(t.name, t);
    }
    out.set(id, [...winner.values()].sort((a, b) => {
      const pa = rank.get(a.scope)!; const pb = rank.get(b.scope)!;
      // 名称序用码点比较而非 localeCompare：后者跟随机器默认 locale（zh-CN collation 下 Latin 排在
      // 汉字之后），跨机器导出顺序不稳定，破坏「稳定排序」契约（2026-10-02 实测 zh-CN 机上确定性失败）。
      // 与 queries.ts 的 mergeTagDetails 镜像同步改（cmpCodepoint 同款实现）。
      return pa !== pb ? pa - pb : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }));
  }
  return out;
}

/**
 * 末行时间戳（秒）：取行数组最后一条的 from；无末行（行数组空，如正文全空白）时 undefined——manifest 省略该字段。
 * （payload 经 JSON.parse 还原，from 不可能出现非有限数，无需再防御。）
 */
function lastTsOf(lines: StampedLine[]): number | undefined {
  return lines.length > 0 ? lines[lines.length - 1].from : undefined;
}

// ── 组装（纯函数：只读 db，不落盘；时间由 opts.now 注入）──

export function buildBundle(db: Database.Database, opts: BuildBundleOpts): BundleResult {
  const nameOrder = opts.nameOrder ?? ['id', 'name'];
  const page = videosList(db, { ...opts.filters, page: 1, size: opts.limit });
  // 批量富化：本页一次取齐（IN 查询防 N+1，先例 latestTaskStatusByVideoIds / enrichItems）
  const ids = page.items.map((v) => v.id);
  const latestStatus = latestTaskStatusByVideoIds(db, ids);
  const extras = videoExtrasByVideoIds(db, ids);
  const tagsById = mergeBundleTags(db, ids, extras);
  const videos: BundleVideoEntry[] = [];
  const files: BundleFile[] = [{ path: 'ANALYZE.md', content: ANALYZE_MD }];
  const errors: Array<{ source_vid: string; message: string }> = [];

  for (const v of page.items) {
    const ex = extras.get(v.id)!;  // 本页每个 id 必有 extra 行（同 mergeBundleTags 断言）
    const entry: BundleVideoEntry = {
      id: v.id, source: v.source, source_vid: v.source_vid,
      title: v.title, creator_name: v.creator_name, creator_source_uid: v.creator_source_uid,
      duration: v.duration, published_at: v.published_at, first_seen_at: v.first_seen_at,
      track_count: v.track_count,
      // mergeBundleTags 对本页每个 id 必有键（required=true 时必有值，同款断言风格）
      tags: tagsById.get(v.id)!,
      // extra 缺 stat.view → 省略字段（manifest 消费方以 'view' in v 判别）
      ...(ex.view != null ? { view: ex.view } : {}),
      subtitle: null,
      pot_limited: latestStatus.get(v.id) === 'limited',
    };
    const r = resolveSubtitle(db, { source: v.source, sourceVid: v.source_vid, track: opts.track, format: 'json' });
    if (r.kind === 'ok') {
      try {
        // 行数组一次解析三用：正文拼装 + lines 计数 + last_ts 末行秒
        const lines = stampedLines(r.payload);
        const lastTs = lastTsOf(lines);
        const sub: BundleSubtitleMeta = {
          file: `videos/${videoFileName(v, nameOrder)}.txt`,
          lan: r.trackLan ?? null, lan_doc: r.trackLanDoc ?? null,
          track_type: r.trackType ?? null, version_id: r.versionId, origin: r.versionOrigin ?? '?',
          lines: lines.length,
          ...(lastTs !== undefined ? { last_ts: lastTs } : {}),
        };
        entry.subtitle = sub;
        files.push({ path: sub.file, content: `${videoHeader(entry, sub)}${linesToTxt(lines)}` });
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
