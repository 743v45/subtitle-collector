// ws 桥接层：tasks 调 ws 能力的接口 + 模块态注册表（2026-08-23 断开 tasks → ws 上跳依赖）。
// 分层规则 server-tasks-no-upward：tasks 不得 import ws/。此前 tasks.ts 直接 import ws/server
// 的三函数，与 ws/server → tasks（pushTask/notifyClientOnline）构成循环。拆法沿 inflight.ts 先例
// （独立模块承载双方共同依赖）：本模块只定义接口与注册表，不 import tasks/ws 任何一侧——
// ws/server.ts 模块加载时 registerWsBridge(自身三函数)（ws → tasks 方向合法），
// tasks.ts 经 getWsBridge() 间接调用。测试不经 ws/server 时（如 tasks.test.ts）注册 fake bridge。

/** tasks 层需要的 ws/server 能力（三函数签名与 ws/server.ts 保持一致）。 */
export interface WsBridge {
  listClients(): Array<{ client_id: string; ext_version: string | null; reporting_enabled: boolean; connected: true }>;
  requestCommand(
    clientId: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: true; result: any } | { ok: false; code: 'offline' | 'timeout' }>;
  broadcastEvent(msg: Record<string, unknown>): void;
}

// 模块态注册表（单 server 进程单 ws 实现；后注册覆盖先注册，测试可重复注册自己的 fake）
let bridge: WsBridge | null = null;

/** ws/server.ts（或测试）注册实现。 */
export function registerWsBridge(b: WsBridge): void {
  bridge = b;
}

/** 取已注册的桥；未注册时抛清晰错误（正常流程 import 链必经 ws/server.ts，测试需先注册 fake）。 */
export function getWsBridge(): WsBridge {
  if (!bridge) {
    throw new Error('WsBridge 未注册：生产代码须先加载 ws/server.ts（main.ts 已引入）；测试须在文件头 registerWsBridge(fake)');
  }
  return bridge;
}
