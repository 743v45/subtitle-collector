// CLI 全局上下文（模块态）：从 main.ts 下沉至此，断开 commands → main 的反向依赖环
// （main 组合根 import commands 注册，commands 又要回来拿 context —— 上下文独立成叶子模块后双向只剩单向）。
import { emitError, type Format } from './output.js';

export interface CliContext {
  format: Format;
  dbPath: string;
  serverUrl: string;
  token: string;
  quiet: boolean;
}

let currentContext: CliContext | null = null;

// 在 commander preAction 钩子里设置；命令 action 内调用。
// 设计取舍：用模块态而非参数注入，因为 commander 的 .action(callback) 签名不便多传 context，
// 而各命令 buildXxxCommand() 在模块加载时构造、context 在 parse 后才确定——只能延迟到 action 取。
export function getCliContext(): CliContext {
  if (!currentContext) {
    emitError('CLI context not initialized (preAction hook did not run)', 'RUNTIME');
  }
  return currentContext!;
}

export function setCliContext(ctx: CliContext): void {
  currentContext = ctx;
}

// 纯查询（未初始化返回 null，不报错）——供 main() 的 catch 分支读 quiet 用（parse 早期失败时 context 尚未构造）。
export function peekCliContext(): CliContext | null {
  return currentContext;
}
