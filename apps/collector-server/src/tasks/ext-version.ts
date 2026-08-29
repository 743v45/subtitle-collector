// 扩展版本感知共享层（2026-08-30 多机版本参差事故抽出，沿 wsBridge / inflight「独立模块承载
// 双方共同依赖」先例）：tasks.ts（任务派发侧）与 upper-expand.ts（UP 展开侧）都要用「扩展版本
// 过旧」回执分类与版本比较，任何一侧 import 另一侧都会成环（tasks.ts 已 re-export upper-expand），
// 故独立成模块——本文件不 import tasks/ws 任何一侧。
//
// 事故背景：0.1.26 新机与 0.1.18 旧机同时在线，douyin 博主展开派发无版本感知选到旧机 → 回执
// 「unknown action: expand-douyin-upper」原样透出 503。版本门槛（upper-expand.ts 按此比较函数
// 过滤派发目标）是事前止血，extNeedsUpdate 是门槛漏网（hello 谎报版本等）时的错误分类兜底。

/** 「扩展版本过旧」统一文案：指向更新扩展而非重试（区别于 need_login 等可重试失败）。 */
export const EXT_NEEDS_UPDATE_ERROR = '扩展版本过旧，请更新扩展后重试';

// 「扩展版本过旧」分类（2026-08-21 首建于 tasks.ts 派发侧，2026-08-30 抽出共享）：server 升级
// 新增 action 后，旧扩展不认识 → 回执失败。判据按回执内容（两种形态）：旧扩展回
// "unknown action: <action>" 字符串；新扩展对未知 action 显式带 needs_update:true（回执顶层或
// data 内）。不做 hello 能力协商表——单一错误路径不值得引入版本协商状态；错误内容分类 + 版本
// 门槛已足够定位。
export function extNeedsUpdate(result: { ok?: unknown; error?: unknown; data?: unknown; needs_update?: unknown } | undefined): boolean {
  if (result?.needs_update === true) return true;
  if (typeof result?.error === 'string' && result.error.includes('unknown action')) return true;
  const data = result?.data;
  return typeof data === 'object' && data !== null && (data as { needs_update?: unknown }).needs_update === true;
}

// 版本比较（2026-08-30 版本门槛用）：'0.1.9' < '0.1.10'（数字段比较，非字典序——字典序会判
// '9' > '10' 错放旧版本过关）。仅认 x.y.z 点分形态，各段按数值解析（非数字/缺失段 → 0）；
// null/undefined 视为 0.0.0（旧扩展 hello 不带 ext_version 按最旧处理，门槛必拦）。
// 返回 -1 / 0 / 1。
export function compareExtVersion(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 {
  const sa = String(a ?? '').split('.');
  const sb = String(b ?? '').split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const d = (Number(sa[i]) || 0) - (Number(sb[i]) || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
