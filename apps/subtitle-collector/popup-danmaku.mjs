// popup-danmaku.mjs —— popup 弹幕查看/一键复制纯逻辑（2026-10-07 用户现场指令：popup 同步支持复制）。
// 消费端点：collector-server GET /api/danmaku/list?bvid=<BV>（Bearer 鉴权）——fetch 在
// src/popup/hooks-danmaku.ts（useDanmaku），展示与复制在 src/popup/DanmakuCard.tsx。
// 本模块无 chrome.* 依赖，node:test 直测（test/popup-danmaku.test.mjs）；c8 口径内
// （--include '*.mjs'），锁定线 99/99/98/99 全仓最严，分支务必测满。
// 措辞红线：弹幕=时间轴弹幕（本模块），字幕=语音转写（subtitleFormat.mjs），两者不混用。

// 毫秒 → 弹幕时间戳。≥3600000ms 进位小时 "H:MM:SS"（小时不补零），否则 "MM:SS"（分/秒两位补零）。
// 秒取 floor（progress_ms 59900 → 59s → "00:59"）。
// null / undefined / 非有限数 / 负值 → "--:--"（未定位占位：B 站历史弹幕 progress 可能缺失为 null）。
/**
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--:--';
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

// 弹幕数组 → 复制文本：每条一行 "[MM:SS] 内容"，行间 \n、无尾随换行。
// content null / undefined / 空串跳过（不产空行）；progress_ms null/负值行时间戳为 [--:--]
//（归一在 formatClock 内）。入参非数组（null/undefined）→ 空串。
/**
 * @param {Array<{ progress_ms?: number | null, content?: string | null } | null | undefined>} [danmakus]
 * @returns {string}
 */
export function formatDanmakuCopy(danmakus) {
  const lines = [];
  if (Array.isArray(danmakus)) {
    for (const d of danmakus) {
      const content = d?.content;
      if (typeof content !== 'string' || content.length === 0) continue;
      lines.push(`[${formatClock(d?.progress_ms)}] ${content}`);
    }
  }
  return lines.join('\n');
}

// 复制成功反馈条数（按行数算：formatDanmakuCopy 一条弹幕一行）。非字符串/空串 → 0。
/**
 * @param {string | null | undefined} text
 * @returns {number}
 */
export function danmakuCopyStats(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text.split('\n').length;
}
