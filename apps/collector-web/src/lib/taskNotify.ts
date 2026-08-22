// ── 任务完成系统通知（2026-08-22）──
// 轮询页（采集页/历史页）在每次拉取后对前后两次任务列表做 diff：本次有「进行中→终态」
// 转移、且拉回的列表已无进行中任务时，发一条浏览器系统通知（汇总计数）。提交批量/重试后
// 切去别的标签页，跑完即被提醒，无需盯页。
// 降级：Notification 不可用（非安全上下文 http）或授权被拒 → 静默跳过（页面状态本就随轮询刷）。
// 边界：Chrome 后台标签 >5min 后 timer 节流至 1 次/分钟，通知最多延迟约 1 分钟；
// SPA 内离开采集页/历史页后轮询即停，不提醒；长尾批次等最后一个任务到终态才弹（避免中途刷屏）。
import type { CollectTask, CollectTaskStatus } from '../types';

export function isActiveStatus(s: CollectTaskStatus): boolean {
  return s === 'pending' || s === 'dispatched';
}

// 前后两次轮询间的终态转移：同 id 在 prev 为进行中、next 为终态 → 计入（取 next 的终态行）。
// 被删除的任务（id 在 next 消失）不算完成；next 新出现即为终态的也不计（首见无转移）。
export function terminalTransitions(prev: CollectTask[], next: CollectTask[]): CollectTask[] {
  const prevActive = new Map(prev.filter((t) => isActiveStatus(t.status)).map((t) => [t.id, t]));
  const out: CollectTask[] = [];
  for (const t of next) {
    if (prevActive.has(t.id) && !isActiveStatus(t.status)) out.push(t);
  }
  return out;
}

// 终态汇总文案：「成功 X · 受限 Y · 失败 Z」，零档省略（成功恒在，全失败时显式 成功 0）。
export function notifyText(finished: CollectTask[]): string {
  const ok = finished.filter((t) => t.status === 'succeeded').length;
  const limited = finished.filter((t) => t.status === 'limited').length;
  const fail = finished.filter((t) => t.status === 'failed').length;
  let s = `成功 ${ok}`;
  if (limited > 0) s += ` · 受限 ${limited}`;
  if (fail > 0) s += ` · 失败 ${fail}`;
  return s;
}

// 发一条完成通知；tag 固定——连续多轮各弹一条时后者替换前者，不堆叠。
export function sendTaskDoneNotification(finished: CollectTask[]): void {
  if (finished.length === 0) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification('采集任务已全部完成', { body: notifyText(finished), tag: 'collect-done' });
  } catch { /* 构造失败（策略/极老环境）静默，页面轮询本就同步状态 */ }
}

// 请求通知授权：只在用户手势内调用（提交/重试点击处）。granted/denied 后不再问；
// 非 default 状态或 API 不可用时是 no-op，不阻塞调用方。
export function requestTaskNotifyPermission(): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  try {
    void Notification.requestPermission()?.catch(() => { /* 拒绝即降级静默 */ });
  } catch { /* 老式回调形态异常静默 */ }
}
