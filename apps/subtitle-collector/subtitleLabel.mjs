// apps/subtitle-collector/subtitleLabel.mjs
// 字幕轨道标签纯函数（不依赖 chrome.* / React / npm，便于 node:test）。
// 抽自 Popup.tsx SubtitleCopySection 的 label / AI 识别逻辑，供 UI 与回归测试共用。
//
// 背景（BUG-2）：B 站 AI 字幕走 aisubtitle.hdslb.com，subtitle_url 含 "aisubtitle"。
// 早期 UI 把 AI 字幕的语言名直接替换成 "AI"，导致同一视频的中/英/日 AI 字幕
// 在 popup 里全显示成 "AI"，语言无法区分。此处修正：语言名始终取 lan_doc/lan，
// AI 标记由调用方用 isAiSubtitle 判定后作 badge 叠加，不再霸占语言位。

/**
 * 是否为 B 站 AI 字幕轨（按 subtitle_url 特征识别最稳）。
 * @param {{ subtitle_url?: string } | null | undefined} sub
 * @returns {boolean}
 */
export function isAiSubtitle(sub) {
  return typeof sub?.subtitle_url === 'string' && sub.subtitle_url.includes('aisubtitle');
}

/**
 * 字幕轨道的语言标签：lan_doc 优先，回退 lan，再回退 '未知'。
 * 不因 AI 字幕而抹平为 'AI' —— AI 标记由调用方用 isAiSubtitle 叠加 badge。
 * @param {{ lan?: string, lan_doc?: string } | null | undefined} sub
 * @returns {string}
 */
export function subtitleTrackLabel(sub) {
  return sub?.lan_doc ?? sub?.lan ?? '未知';
}
