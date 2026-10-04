// CLI 未知选项守卫（2026-10-05 P1-10 选项命名统一配套）：commander 对未注册选项默认退 1
//（error: unknown option '...' 只写 stderr、无结构化错误体、不列合法键），与本项目
//「参数错误 = ARGS 退 2 + stdout JSON 错误体」契约不一致；旧选项名 breaking 改名后
//（tags list 原 topN 拼写、translate pending 原 asc 旗标），报错必须列全合法键才好排查。
// 用法：在叶子子命令上装一次（unknownOption 在叶子命令上抛出，组根装了不生效——
// _exitCallback 不随 subcommand 后续注册继承）：
//   installUnknownOptionGuard(list); // list.action(...) 之前
// 拦 commander.unknownOption → emitError('ARGS')：退出码 2、stdout {ok:false,error,code}、
// 错误文案列全该命令长选项（对齐全端点排序先例「非法 --sort: x（可选: a|b|c）」形态，
// 键清单取 commander 自描述单一事实源 = .option 注册处）。其余用法错误（缺参/缺值/help）
// 维持 commander 默认：按 err.exitCode 退场（error() 已先写 stderr / help 正文已写 stdout）。
import type { Command } from 'commander';
import { emitError } from '../output.js';

/** 装未知选项守卫（P1-10）：unknownOption → ARGS 退 2 且列全合法键。 */
export function installUnknownOptionGuard(leaf: Command): void {
  leaf.exitOverride((err) => {
    if (err.code === 'commander.unknownOption') {
      // message 形如 "error: unknown option '<旧旗标>'\n(Did you mean --<近似名>?)"；选项名从单引号内提取
      const flag = /'([^']+)'/.exec(err.message)?.[1] ?? err.message;
      const keys = leaf.options.map((o) => o.long).filter((k): k is string => typeof k === 'string');
      const hint = keys.length > 0 ? `（可选: ${keys.join('|')}）` : '';
      emitError(`未知选项: ${flag}${hint}`, 'ARGS');
    }
    process.exit(err.exitCode);
  });
}
