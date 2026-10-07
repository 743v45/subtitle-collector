// danmaku 命令组（collect / verify,2026-10-07 弹幕采集解冻,规格唯一来源 docs/plans/danmaku/PLAN.md §4.2/§4.6）。
// 分工：collect = 宿主直连 B 站采（seg.so 二进制 protobuf,cookie 可选 D9）,写库只走 server HTTP（D4）;
// verify = 纯本地 --db 只读（DB-only,openDbOrEmit 的 --server 忽略警告适用）。
// 编排在 danmaku-collect.ts（runCollect）,判定纯函数在 danmaku-run.ts,I/O 适配在 danmaku-net.ts。
// 与 comments 的差异:cookie 可选（匿名实测可用,PLAN D9）;verify 走 db/danmaku-verify.ts 本地口径。
// 回执格式走全局 --format（json/ndjson/csv/table,默认 json）——PLAN §4.2 的局部 --format(默认 table)
// 与全局 --format 同名,commander 实测子命令局部值被全局同名选项吞掉（2026-10-07,见 cli 复现）,
// 故对齐 comments 先例不设局部项。
import { Command } from 'commander';
import { emitResult, emitError, logInfo } from '../output.js';
import { getCliContext } from '../context.js';
import { openDbOrEmit } from '../db.js';
import { getVideo } from '../../db/queries.js';
import { verifyDanmaku } from '../../db/danmaku-verify.js';
import { ServerClient, ServerResponseError, ServerUnreachableError } from '../http.js';
import { handleHttpError } from './collect.js';
import { DanmakuError, parseCollectOpts, type DanmakuDeps } from './danmaku-run.js';
import { loadCookieFileOptional } from './danmaku-net.js';
import { runCollect } from './danmaku-collect.js';

/** 错误退出口（对齐 comments.collectErrorExit 口径）：ARGS/aid_mismatch→2,video_not_found→5,
 * 通路层错误交 handleHttpError,其余→RUNTIME 1。 */
function collectErrorExit(e: unknown): never {
  const errCode = e instanceof DanmakuError ? e.code : (e as { code?: string }).code;
  if (errCode === 'ARGS' || errCode === 'aid_mismatch') {
    emitError((e as Error).message, 'ARGS', { collect_code: errCode });
  }
  if (errCode === 'video_not_found') {
    emitError((e as Error).message, 'NOT_FOUND', { collect_code: errCode });
  }
  if (e instanceof ServerUnreachableError || e instanceof ServerResponseError) handleHttpError(e);
  const msg = e instanceof Error ? e.message : String(e);
  emitError(msg, 'RUNTIME');
}

// ── collect 子命令 ──

function buildCollectSub(): Command {
  const c = new Command('collect')
    .description('采集 B 站视频弹幕(seg.so 分段,幂等入库;cookie 可选)')
    .option('--bvid <bv>', 'B 站 BV 号(与 --aid 至少给一个;同给则交叉校验)')
    .option('--aid <n>', 'B 站 av 号(与 --bvid 至少给一个)')
    .option('--page <all|n>', '多 P 选择:all=全串行 / n=只采第 n 个分 P', 'all')
    .option('--max-segments <n>', '单 P 段数上限(0=不限,按时长 ceil(duration/360))', '0')
    .option('--max-requests <n>', '单轮 B 站请求预算(用尽 → partial request_budget)', '300')
    .option('--segment-interval-ms <n>', '段间隔基数 ms(±30% 抖动)', '1000')
    .option('--batch-size <n>', 'ingest 批大小', '2000')
    .option('--dry-run', '只拉取解析不入库(回执 store 段为 would_requests/would_rows)', false)
    .option('--cookie-file <path>', 'cookie 文件(可选;缺省 $COLLECTOR_BILI_COOKIE_FILE;都没有则匿名跑)')
    .action(async (opts: {
      bvid?: string; aid?: string; page?: string; maxSegments?: string; maxRequests?: string;
      segmentIntervalMs?: string; batchSize?: string; dryRun?: boolean; cookieFile?: string;
    }) => {
      const ctx = getCliContext();
      try {
        const parsed = parseCollectOpts(opts);
        // cookie 可选装配（§4.2 D9）：--cookie-file 优先,缺省 env;都缺省 → 匿名(null)。
        // 文件 I/O 放全部纯参数校验之后（对齐 comments 先例:非整数先报,别让 cookie 报错抢先）
        const { cookie, from } = loadCookieFileOptional(parsed.cookieFile);
        logInfo(cookie == null ? '[danmaku] 未配置 cookie → 匿名采集(D9 实测可用)' : `[danmaku] cookie 来源: ${from}`);
        const deps: DanmakuDeps = {
          client: new ServerClient(ctx.serverUrl, ctx.token),
          cookie,
          cookieFrom: from,
          biliApi: process.env.COLLECTOR_BILI_API || undefined,
          log: logInfo,
        };
        const receipt = await runCollect(deps, parsed);
        emitResult(receipt, ctx.format);
      } catch (e) {
        collectErrorExit(e);
      }
    });
  return c;
}

// ── verify 子命令（DB-only 本地只读）──

function buildVerifySub(): Command {
  const v = new Command('verify')
    .description('校验统计本地库中某视频的弹幕(R1-R5:完整性/时间轴/mode/weight/ctime;纯 --db 只读)')
    .option('--bvid <bv>', '目标视频 BV 号(必填)')
    .action((opts: { bvid?: string }) => {
      const ctx = getCliContext();
      if (!opts.bvid) emitError('需要 --bvid <BV号>', 'ARGS');
      const db = openDbOrEmit(ctx.dbPath);
      const detail = getVideo(db, 'bilibili', opts.bvid);
      if (!detail) emitError(`video not found: bilibili/${opts.bvid}`, 'NOT_FOUND');
      const videoId = detail.video.id as number;
      const result = verifyDanmaku(db, videoId);
      emitResult({ ok: true, bvid: opts.bvid, ...result }, ctx.format);
    });
  return v;
}

/** danmaku 命令组入口（main.ts 注册）。 */
export function buildDanmakuCommand(): Command {
  const d = new Command('danmaku');
  d.description('B 站弹幕:collect 采集(seg.so 分段+server 写库,cookie 可选) / verify 本地校验统计');
  d.addCommand(buildCollectSub());
  d.addCommand(buildVerifySub());
  return d;
}
