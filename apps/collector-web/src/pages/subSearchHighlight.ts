// 字幕检索纯函数：命中高亮分段（SubSearchPage 结果渲染用）。
// 输出分段数组而非 HTML 字符串——页面侧禁 dangerouslySetInnerHTML（样式政策）。
export interface HighlightSeg { text: string; hit: boolean; }

// 命中高亮分段：子串模式对齐 server 大小写折叠语义（includes → indexOf 循环）；
// 正则模式用同源 flags（g/gi），非法正则回落不分段（server 已 400，防御渲染层）；零宽匹配跳过防空高亮段。
export function buildSegments(text: string, kw: string, opts: { regex: boolean; caseSensitive: boolean }): HighlightSeg[] {
  if (!kw) return [{ text, hit: false }];
  const out: HighlightSeg[] = [];
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(kw, opts.caseSensitive ? 'g' : 'gi');
    } catch {
      return [{ text, hit: false }];
    }
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
      out.push({ text: m[0], hit: true });
      last = m.index + m[0].length;
    }
    out.push({ text: text.slice(last), hit: false });
    return out;
  }
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? kw : kw.toLowerCase();
  let last = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    if (i > last) out.push({ text: text.slice(last, i), hit: false });
    out.push({ text: text.slice(i, i + needle.length), hit: true });
    last = i + needle.length;
    i = hay.indexOf(needle, last);
  }
  out.push({ text: text.slice(last), hit: false });
  return out;
}
