// 调度器 inFlight 状态：client_id → 执行中 task_id（同 client 同时只跑 1 任务，防风控串行）。
// 独立模块（不 import ws/tasks）：tasks.ts（读写）与 ws/server.ts（连接 close 时释放）共同依赖，
// 放 tasks.ts 内会造成与 ws/server 的循环 import。
export const inFlight = new Map<string, number>();

// WS 连接 close → 释放该 client 的 inFlight 占位。否则断线扩展的占位要等命令超时
// （最长 180s）才消失，重连的同 client 在此期间空转不接新任务。
export function releaseClient(clientId: string): void {
  inFlight.delete(clientId);
}
