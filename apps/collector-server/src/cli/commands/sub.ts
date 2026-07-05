// collector-cli 字幕内容检索命令组：sub search。
// 设计参考 [字幕正文检索设计文档](docs/superpowers/specs/2026-07-05-subtitle-search-design.md)。
//
// 架构（对齐 collect.ts find 区段）：commander 薄包装 + 纯/可注入函数。
// - matchBody / extractSnippets / payloadBody：纯函数，无 IO，直接单测。
// - searchSubtitles：编排纯函数，注入 db + PayloadSource（生产 makeDbPayloadSource，测试 mock）。
// 措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';
import { listVideosFiltered, getVideoByDbId, type VideoFilter, type ListFilter, type VideoListItemAdvanced } from '../../db/advanced.js';
import { getVersionPayload } from '../../db/queries.js';
import { convertSubtitle, type SubtitleFormat } from '../subtitleFormat.js';

// ── payload body 结构（对齐 subtitleFormat.ts BodyItem）──
export interface BodyItem {
  from: number;
  to: number;
  content: string;
}

// ── matchBody 选项 ──
export interface MatchOpts {
  regex?: boolean;
  caseSensitive?: boolean;
}

/**
 * 在字幕 body[].content 上做匹配，返回命中段索引数组（按原顺序）。
 * - 默认：大小写不敏感子串匹配（String.includes，对齐 SQL LIKE 语义）。
 * - regex=true：把 keyword 当 JavaScript 正则源串，加 'i' flag（除非 caseSensitive）。
 * - 非法正则抛 Error（含「非法正则」前缀，供 action 层转 ARGS 退码）。
 */
export function matchBody(body: BodyItem[], keyword: string, opts: MatchOpts = {}): number[] {
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(keyword, opts.caseSensitive ? '' : 'i');
    } catch (err) {
      throw new Error(`非法正则: ${keyword} — ${(err as Error).message}`);
    }
    const hits: number[] = [];
    body.forEach((item, i) => {
      if (re.test(item.content)) hits.push(i);
    });
    return hits;
  }
  const needle = opts.caseSensitive ? keyword : keyword.toLowerCase();
  const hits: number[] = [];
  body.forEach((item, i) => {
    const hay = opts.caseSensitive ? item.content : item.content.toLowerCase();
    if (hay.includes(needle)) hits.push(i);
  });
  return hits;
}

// ── 片段（命中点 + 上下文）──
export interface Snippet {
  from: number;       // 命中段起始秒
  to: number;         // 命中段结束秒
  content: string;    // 命中段原文
  context: string;    // ±ctxSec 邻段拼接；默认 "[from-to] content" 空格连接，plain=true 去前缀
}

export interface ExtractOpts {
  plain?: boolean;
  maxPerVideo?: number;
}

/**
 * 对每个命中索引产出片段：从命中段向前后贪心吞并「时间差 <= ctxSec」的邻段，
 * 拼成 context。时间差定义：向前 = center.from - body[lo-1].to；向后 = body[hi+1].from - center.to。
 * - plain=true：context 只留纯文本（邻段 content 直接拼接）。
 * - maxPerVideo：按命中顺序取前 N（默认不限）。
 */
export function extractSnippets(
  body: BodyItem[],
  hitIndices: number[],
  ctxSec: number,
  opts: ExtractOpts = {},
): Snippet[] {
  const max = opts.maxPerVideo ?? Number.MAX_SAFE_INTEGER;
  return hitIndices.slice(0, max).map((idx) => {
    const center = body[idx];
    let lo = idx;
    while (lo > 0 && center.from - body[lo - 1].to <= ctxSec) lo--;
    let hi = idx;
    while (hi < body.length - 1 && body[hi + 1].from - center.to <= ctxSec) hi++;
    const segs = body.slice(lo, hi + 1);
    const context = opts.plain
      ? segs.map((s) => s.content).join('')
      : segs.map((s) => `[${s.from}-${s.to}] ${s.content}`).join(' ');
    return { from: center.from, to: center.to, content: center.content, context };
  });
}

/**
 * 从 payload（B 站字幕 JSON 对象）校验并提取 body 数组。
 * 结构不符（非对象/缺 body/body 非数组/条目缺字段）→ 返回 null（调用方跳过该视频，不崩）。
 * 校验逻辑镜像 subtitleFormat.ts 的 extractBody，但返回 null 而非抛错（检索场景容错优先）。
 */
export function payloadBody(payload: unknown): BodyItem[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = (payload as { body?: unknown }).body;
  if (!Array.isArray(body)) return null;
  const items: BodyItem[] = [];
  for (const raw of body) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { from, to, content } = raw as Record<string, unknown>;
    if (typeof from !== 'number' || typeof to !== 'number' || typeof content !== 'string') return null;
    items.push({ from, to, content });
  }
  return items;
}

// ── PayloadSource：默认轨/版本 payload 来源抽象（生产 makeDbPayloadSource，测试 mock）──
export interface TrackInfo { id: number; lan: string | null; track_type: number | null; }
export interface VersionInfo { id: number; origin: string; }
export interface PayloadEntry { track: TrackInfo; version: VersionInfo; payload: unknown; }

export interface PayloadSource {
  /** 给定视频 id，返回其默认轨（allTracks=true 时全部轨）各自默认版本的 payload 列表，按轨优先级排序。 */
  getPayloads(videoId: number, allTracks: boolean): PayloadEntry[];
}

/**
 * 生产实现：复用 getVideoByDbId（已按 trackPriority/versionPriority 排序、标 is_default）+
 * getVersionPayload 取 payload。getVideoByDbId 不返回 payload，故再按 version id 单取。
 */
export function makeDbPayloadSource(db: Database.Database): PayloadSource {
  return {
    getPayloads(videoId: number, allTracks: boolean): PayloadEntry[] {
      const detail = getVideoByDbId(db, videoId);
      if (!detail) return [];
      const targetTracks = allTracks
        ? detail.tracks
        : detail.tracks.filter((t) => (t as { is_default?: boolean }).is_default);
      const out: PayloadEntry[] = [];
      for (const t of targetTracks) {
        const defaultVer = t.versions.find((v) => (v as { is_default?: boolean }).is_default) ?? t.versions[0];
        if (!defaultVer) continue;
        const pv = getVersionPayload(db, defaultVer.id);
        if (!pv) continue;
        out.push({
          track: { id: t.id, lan: t.lan, track_type: t.track_type },
          version: { id: pv.id, origin: pv.origin },
          payload: pv.payload,
        });
      }
      return out;
    },
  };
}

// ── searchSubtitles 结果形状 ──
export interface SubtitleSnippet extends Snippet {}

export interface SubtitleSearchItem {
  // video 元信息：刻意不含 pic / 封面 / 视频链接等媒体字段（AI 看不了且占 token —— 用户明确要求剔除）
  video: { id: number; source: string; source_vid: string; title: string;
           creator_name: string | null; duration: number | null; published_at: number | null };
  track: TrackInfo;
  version: VersionInfo;
  snippets: SubtitleSnippet[];
  full?: string;
}

export interface SubtitleSearchResult {
  keyword: string;
  regex: boolean;
  matched_videos: number;
  total_snippets: number;
  truncated: boolean;
  items: SubtitleSearchItem[];
}

export interface SearchSubtitlesOpts {
  keyword: string;
  regex?: boolean;
  caseSensitive?: boolean;
  ctxSec?: number;                 // 默认 10
  maxSnippetsPerVideo?: number;    // 默认 3
  maxSnippets?: number;            // 默认 30
  maxVideos?: number;              // 默认 100
  allTracks?: boolean;
  plain?: boolean;
  full?: boolean;
  fullFormat?: SubtitleFormat;     // 默认 'txt'
  videoFilter?: VideoFilter;
}

/**
 * 字幕正文检索编排：
 * ① 候选池 = listVideosFiltered(videoFilter + size=maxVideos)；子串模式额外带 subtitle_q=keyword 做 LIKE 预筛加速；
 *    正则模式**禁用** subtitle_q 预筛（元字符破坏 LIKE 召回）。
 * ② 每候选 source.getPayloads → payloadBody 校验 → matchBody 精确匹配（消 LIKE 噪声）；
 *    取第一个有命中的 payload 作为该视频代表（默认轨优先），产出片段。
 * ③ 跨视频累计 maxSnippets 截断，标记 truncated。
 */
export function searchSubtitles(
  db: Database.Database,
  source: PayloadSource,
  opts: SearchSubtitlesOpts,
): SubtitleSearchResult {
  const keyword = opts.keyword;
  const regex = !!opts.regex;
  const ctxSec = opts.ctxSec ?? 10;
  const maxPerVideo = opts.maxSnippetsPerVideo ?? 3;
  const maxSnippets = opts.maxSnippets ?? 30;
  const maxVideos = opts.maxVideos ?? 100;

  // ① 候选池
  const filter: ListFilter = { ...(opts.videoFilter ?? {}), size: maxVideos };
  if (!regex && keyword) {
    filter.subtitle_q = keyword;  // 子串模式 LIKE 预筛（⊇ JS 精确，不漏召回）
  }
  const candidates: VideoListItemAdvanced[] = listVideosFiltered(db, filter).items;

  // ②③ 逐候选匹配 + 累计截断
  const items: SubtitleSearchItem[] = [];
  let totalSnippets = 0;
  let truncated = false;

  for (const v of candidates) {
    if (totalSnippets >= maxSnippets) { truncated = true; break; }
    const payloads = source.getPayloads(v.id, !!opts.allTracks);
    let chosen: { track: TrackInfo; version: VersionInfo; snippets: SubtitleSnippet[]; payload: unknown } | null = null;
    for (const pe of payloads) {
      const body = payloadBody(pe.payload);
      if (!body) continue;  // 结构异常跳过
      const hits = matchBody(body, keyword, { regex, caseSensitive: opts.caseSensitive });
      if (hits.length === 0) continue;  // LIKE 噪声在此被 JS 滤掉
      const snippets = extractSnippets(body, hits, ctxSec, { plain: opts.plain, maxPerVideo });
      if (snippets.length === 0) continue;
      chosen = { track: pe.track, version: pe.version, snippets, payload: pe.payload };
      break;  // 取第一个命中 payload（默认轨优先）
    }
    if (!chosen) continue;

    // 全局配额截断
    const remaining = maxSnippets - totalSnippets;
    if (chosen.snippets.length > remaining) {
      chosen.snippets = chosen.snippets.slice(0, remaining);
      truncated = true;
    }
    totalSnippets += chosen.snippets.length;

    const item: SubtitleSearchItem = {
      video: {
        id: v.id, source: v.source, source_vid: v.source_vid, title: v.title,
        creator_name: v.creator_name,
        duration: v.duration, published_at: v.published_at,
      },
      track: chosen.track,
      version: chosen.version,
      snippets: chosen.snippets,
    };
    if (opts.full) {
      try {
        item.full = convertSubtitle(chosen.payload, opts.fullFormat ?? 'txt');
      } catch {
        // payload 结构异常（理论上 payloadBody 已挡，兜底）：full 省略
      }
    }
    items.push(item);
  }

  return {
    keyword,
    regex,
    matched_videos: items.length,
    total_snippets: totalSnippets,
    truncated,
    items,
  };
}
