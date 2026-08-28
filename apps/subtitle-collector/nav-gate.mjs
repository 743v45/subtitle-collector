// nav-gate.mjs —— navigate 采集共享门闸：互斥锁 + tab 关闭间隔节流（防风控）。
// 2026-08-29 S8 从 background.js 抽出（台账性重构）：B 站 / YouTube / 抖音三个 navigate 采集器
// 共用同一把锁（同时只 1 个 navigate，防风控叠加）；间隔配置 chrome.storage.local 可覆盖
//（nav_gap_base_ms / nav_gap_random_ms，默认 1s + 随机 0-2s），background 启动时调 loadConfig 读入。
export const navGate = {
  busy: false,       // 互斥锁（true = 有 navigate 采集进行中）
  gapBaseMs: 1000,   // 关闭间隔基数
  gapRandomMs: 2000, // 关闭间隔随机量（0 ~ gapRandomMs）

  // 等锁并占用（同时只 1 个 navigate；500ms 轮询等待）
  async acquire() {
    while (this.busy) await new Promise((r) => setTimeout(r, 500));
    this.busy = true;
  },

  release() { this.busy = false; },

  // 关闭间隔（base+随机，防风控）；tab 关闭后调用
  async gap() {
    await new Promise((r) => setTimeout(r, this.gapBaseMs + Math.random() * this.gapRandomMs));
  },

  // 从 storage 读间隔配置（background 启动/配置变更时调用；非法值忽略保默认）
  async loadConfig(storage) {
    const cfg = await storage.local.get(['nav_gap_base_ms', 'nav_gap_random_ms']);
    if (typeof cfg.nav_gap_base_ms === 'number' && cfg.nav_gap_base_ms >= 0) this.gapBaseMs = cfg.nav_gap_base_ms;
    if (typeof cfg.nav_gap_random_ms === 'number' && cfg.nav_gap_random_ms >= 0) this.gapRandomMs = cfg.nav_gap_random_ms;
  },
};
