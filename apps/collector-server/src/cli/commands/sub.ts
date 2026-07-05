// collector-cli 字幕内容检索命令组：sub search。
// 设计参考 [字幕正文检索设计文档](docs/superpowers/specs/2026-07-05-subtitle-search-design.md)。
//
// 架构（对齐 collect.ts find 区段）：commander 薄包装 + 纯/可注入函数。
// - matchBody / extractSnippets / payloadBody：纯函数，无 IO，直接单测。
// - searchSubtitles：编排纯函数，注入 db + PayloadSource（生产 makeDbPayloadSource，测试 mock）。
// 措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';

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
