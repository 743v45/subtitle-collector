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
