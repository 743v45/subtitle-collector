// format.mjs —— WS 回执/列表展示共用的轻量格式化纯函数（2026-08-29 S8 从 background.js 抽出，
// 台账性重构；无 chrome.* 依赖）。三平台（B 站/YouTube/抖音）UP 列表与命令回执共用同一口径。

// duration 秒 → "M:SS" / "H:MM:SS"（与 B 站 arc/search 的 length 字段同构）。
// 抖音侧入参是 duration_ms/1000（dy-navigate douyinUpperReceipt），口径在调用方换算。
export function fmtLength(sec) {
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// 命令回执 error 文案归一：Error → message；非 Error 抛出值（字符串等）原样字符串化。
// background ws.onmessage 各 action 分支的 catch 与 dy-navigate handleCommand 共用同一口径。
export function cmdError(err) {
  return String(err.message || err);
}
