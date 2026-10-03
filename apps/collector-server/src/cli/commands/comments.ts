// comments 命令组（C4 collect / C5 tree·verify，2026-10 评论采集解冻，规格唯一来源
// docs/plans/comments/PLAN.md §4.2/§5.2/§5.3/§6.3）。
// 分工：collect = 宿主直连 B 站采（wbi 签名 + cookie），写库只走 server HTTP（D4「CLI 永不写库」）；
// tree/verify = 纯本地 --db 只读（DB-only 组，openDbOrEmit 的 --server 忽略警告适用）。
// 编排在 comments-collect.ts（runCollect），判定纯函数在 comments-run.ts，I/O 适配在 comments-net.ts。
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { ServerClient, ServerResponseError, ServerUnreachableError } from '../http.js';
import { emitResult, emitError, logInfo } from '../output.js';
import { getCliContext } from '../context.js';
import { openDbOrEmit } from '../db.js';
import { treeByVideo, type CommentRecord, type CommentTree } from '../../db/comments.js';
import { verifyTree } from '../../db/comments-verify.js';
import { getVideo } from '../../db/queries.js';
import { handleHttpError } from './collect.js';
import { CollectError, type CollectDeps, type CollectOpts } from './comments-run.js';
import { runCollect } from './comments-collect.js';

export const COOKIE_GUIDANCE = 'node scripts/bili-cookie-from-chrome.mjs --refresh（或指定 --cookie-file / $COLLECTOR_BILI_COOKIE_FILE）';

/** cookie 装配（collect 必配，§4.2）：--cookie-file 优先，缺省 env；不可读/空 → ARGS 退 2 带指引。 */
export function loadCookieFile(explicit: string | undefined): { cookie: string; from: string } {
  const path = explicit ?? process.env.COLLECTOR_BILI_COOKIE_FILE;
  if (!path) {
    emitError(
      `cookie 必配:--cookie-file <path> 或 $COLLECTOR_BILI_COOKIE_FILE(评论采集必须登录态:nav 取 wbi keys 匿名恒 -101)。取 cookie: ${COOKIE_GUIDANCE}`,
      'ARGS',
    );
  }
  // 读文件放在 try 外（读失败与空内容是两条不同错误路径，2026-10-04 修正：
  // 空判定原在 try 内，emitError 的 exit 哨兵会被自身 catch 吞掉造成二次报错）
  let cookie = '';
  try {
    cookie = readFileSync(path as string, 'utf-8').trim();
  } catch {
    emitError(`cookie 文件不可读: ${path}。重取: ${COOKIE_GUIDANCE}`, 'ARGS');
  }
  if (!cookie) emitError(`cookie 文件为空: ${path}。重取: ${COOKIE_GUIDANCE}`, 'ARGS');
  return { cookie, from: path as string };
}

/** 非负整数选项解析（§4.2 数值参数；非法 → ARGS 退 2）。 */
export function intOpt(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) emitError(`--${name} 需非负整数,收到: ${v}`, 'ARGS');
  return n;
}

// ── collect 子命令 ──

/** collect 纯参数校验 + CollectOpts 装配（§4.2:互斥/枚举/数值,全部 ARGS 退 2）。
 * --bvid+--aid 同给合法(交叉校验),不做进一步校验,由编排层 resolveVideo 比对 extra.aid/view。
 * 2026-10-04 质量门重构:自 action 箭头函数拆出压平圈复杂度,校验顺序与报错文案逐字不变。 */
export function parseCollectOpts(opts: {
  bvid?: string; aid?: string; bvidFile?: string; mode?: string; sort?: string;
  maxPages?: string; maxFloorPages?: string; refreshRoots?: string; maxRequests?: string;
  pageIntervalMs?: string; batchSize?: string; dryRun?: boolean; cookieFile?: string;
}): CollectOpts {
  if (opts.bvidFile && (opts.bvid || opts.aid)) {
    emitError('--bvid-file 与 --bvid/--aid 互斥(批量模式下逐行取 BV)', 'ARGS');
  }
  if (!opts.bvidFile && !opts.bvid && !opts.aid) {
    emitError('需要 --bvid 或 --aid(批量用 --bvid-file,每行一个 BV)', 'ARGS');
  }
  const mode = opts.mode ?? 'auto';
  if (!(['auto', 'full', 'incremental'] as string[]).includes(mode)) {
    emitError(`--mode 必须是 auto|full|incremental: ${mode}`, 'ARGS');
  }
  const sort = opts.sort ?? 'time';
  if (!(['hot', 'time'] as string[]).includes(sort)) {
    emitError(`--sort 必须是 hot|time: ${sort}`, 'ARGS');
  }
  return {
    bvid: opts.bvid,
    aid: opts.aid,
    mode: mode as CollectOpts['mode'],
    sort: sort as CollectOpts['sort'],
    maxPages: intOpt(opts.maxPages, 'max-pages', 0),
    maxFloorPages: intOpt(opts.maxFloorPages, 'max-floor-pages', 0),
    refreshRoots: intOpt(opts.refreshRoots, 'refresh-roots', 0),
    maxRequests: intOpt(opts.maxRequests, 'max-requests', 600),
    pageIntervalMs: intOpt(opts.pageIntervalMs, 'page-interval-ms', 2000),
    batchSize: intOpt(opts.batchSize, 'batch-size', 200),
    dryRun: !!opts.dryRun,
    bvidFile: opts.bvidFile,
  };
}

/** collect 错误 → 退出码映射（2026-10-04 质量门重构:自 action catch 拆出,映射顺序与文案不变）。
 * 带语义 code 的错误统一按 code 映射（comments-net.ts 以 Object.assign 挂
 * aid_mismatch/video_not_found/need_login 于普通 Error——CollectError 实例之外也要吃到映射）。 */
export function collectErrorExit(err: unknown): never {
  const errCode = err instanceof CollectError ? err.code : (err as { code?: string }).code;
  if (errCode === 'ARGS' || errCode === 'aid_mismatch') {
    emitError((err as Error).message, 'ARGS', { collect_code: errCode });
  }
  if (errCode === 'video_not_found') {
    emitError((err as Error).message, 'NOT_FOUND', { collect_code: errCode });
  }
  if (err instanceof ServerUnreachableError || err instanceof ServerResponseError) handleHttpError(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (errCode === 'need_login' || /need_login/.test(msg)) {
    emitError(`${msg}。重取 cookie: ${COOKIE_GUIDANCE}`, 'RUNTIME', { reason: 'need_login' });
  }
  emitError(msg, 'RUNTIME');
}

export function buildCollectSub(): Command {
  const collect = new Command('collect');
  collect.description('直连 B 站采集评论区并入库（经 server HTTP 写库;模式判定/游标遍历/楼中楼翻全/完整轮对账,PLAN §4.3）')
    .option('--bvid <bvid>', '目标视频 BV 号（与 --aid 二选一或同给做交叉校验；与 --bvid-file 互斥）')
    .option('--aid <aid>', '目标视频 av 号（oid;单独给时经 view 接口回查 bvid）')
    .option('--bvid-file <path>', '批量模式:文件每行一个 BV(# 注释),串行+5s 间隔,失败不阻断（与 --bvid/--aid 互斥）')
    .option('--mode <mode>', 'auto(默认,库内 rows==0→full / >0→incremental)|full(全量)|incremental(水位追新)', 'auto')
    .option('--sort <sort>', 'hot(仅 full 首页 mode=3 快照)|time(默认,纯时间序)', 'time')
    .option('--max-pages <n>', '主列表页数上限(0=不限;触顶→partial max_pages_cap)', '0')
    .option('--max-floor-pages <n>', '单根楼中楼页数上限(0=不限;触顶→partial floor_pages_cap)', '0')
    .option('--refresh-roots <n>', '增量轮附带强制重翻点赞 top-N 根(本轮所见根域,0=关闭)', '0')
    .option('--max-requests <n>', '单视频 B 站请求预算(默认 600;用尽→partial request_budget)', '600')
    .option('--page-interval-ms <n>', '页间隔基数 ms(±30% 抖动,默认 2000)', '2000')
    .option('--batch-size <n>', 'ingest 批大小(默认 200)', '200')
    .option('--dry-run', '取数+解析+计数照常,不写库(回执 store 段为 would_requests/rows)', false)
    .option('--cookie-file <path>', 'B 站 Cookie 文件(文本原样作 Cookie 头;默认 $COLLECTOR_BILI_COOKIE_FILE;必配)')
    .action(async (opts: {
      bvid?: string; aid?: string; bvidFile?: string; mode?: string; sort?: string;
      maxPages?: string; maxFloorPages?: string; refreshRoots?: string; maxRequests?: string;
      pageIntervalMs?: string; batchSize?: string; dryRun?: boolean; cookieFile?: string;
    }) => {
      const ctx = getCliContext();
      const collectOpts = parseCollectOpts(opts);
      // cookie 是文件 I/O，放在全部纯参数校验之后（非整数先报，别让 cookie 报错抢先）
      const { cookie, from } = loadCookieFile(opts.cookieFile);
      const deps: CollectDeps = {
        client: new ServerClient(ctx.serverUrl, ctx.token),
        cookie,
        cookieFrom: from,
        biliApi: process.env.COLLECTOR_BILI_API || undefined,
        log: logInfo,
      };
      try {
        const receipt = await runCollect(deps, collectOpts);
        emitResult(receipt, ctx.format);
      } catch (err) {
        collectErrorExit(err);
      }
    });
  return collect;
}

// ── tree 子命令（§6.3 缩进文本渲染;纯本地 --db 只读）──

const fmtDate = (ctimeS: number | null): string => {
  if (!ctimeS || !Number.isFinite(ctimeS)) return '时间未知';
  const d = new Date(ctimeS * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 行尾状态标注(§6.3:state=17→[仅自己可见],folded→[已折叠],置顶/异常 state 明示)。 */
function statusTags(r: CommentRecord): string {
  const tags: string[] = [];
  if (r.pin_kind) tags.push(`[置顶:${r.pin_kind}]`);
  if (r.folded === 1) tags.push('[已折叠]');
  if (r.state === 17) tags.push('[仅自己可见]');
  else if (r.state !== 0) tags.push(`[state=${r.state}]`);
  return tags.length ? ` ${tags.join(' ')}` : '';
}

function rootHeader(r: CommentRecord): string {
  const seg = [`【赞 ${r.like_count}】@${r.uname ?? '(未知用户)'}${r.is_up === 1 ? '(UP主)' : ''}`];
  if (r.ip_location) seg.push(`IP属地:${r.ip_location}`);
  seg.push(fmtDate(r.ctime_s));
  if (r.up_reply === 1) seg.push('UP主已回复');
  return `## ${seg.join(' · ')}${statusTags(r)}`;
}

function floorLine(f: CommentRecord, depth: number, dialogAuthor: string | null): string {
  const indent = '  '.repeat(Math.max(0, Math.min(depth, 3) - 1));
  const seg = [`【赞 ${f.like_count}】@${f.uname ?? '(未知用户)'}${f.is_up === 1 ? '(UP主)' : ''}`];
  if (f.ip_location) seg.push(`IP属地:${f.ip_location}`);
  let line = `${indent}- ${seg.join(' · ')}`;
  // 「回复 @」对话指向(§2.4:直回根 dialog=自身 rpid 省略;悬空省略前缀——verify R3 软警告)
  if (f.dialog_rpid !== '0' && f.dialog_rpid !== f.rpid_str && dialogAuthor != null) {
    line += ` 回复 @${dialogAuthor}`;
  }
  if (f.parent_rpid !== '0' && f.parent_rpid !== f.dialog_rpid) line += '(回复对象已删除)';
  line += `:${f.message ?? '(无正文)'}${statusTags(f)}`;
  return line;
}

/** 楼层深度(parent 链,≤3 层,更深拍平保留「回复 @」前缀,§6.3)。 */
function floorDepth(f: CommentRecord, byRpid: Map<string, CommentRecord>): number {
  let depth = 1;
  let cur: CommentRecord | undefined = f;
  const guard = new Set<string>();
  while (cur && cur.parent_rpid !== '0' && !guard.has(cur.parent_rpid)) {
    guard.add(cur.parent_rpid);
    const p = byRpid.get(cur.parent_rpid);
    if (!p || p.is_root === 1) break;
    depth++;
    cur = p;
  }
  return Math.min(depth, 3);
}

/** rpid → 记录索引（根+全部楼中楼;floorDepth/dialogAuthorOf 查询用）。 */
function indexByRpid(tree: CommentTree): Map<string, CommentRecord> {
  const byRpid = new Map<string, CommentRecord>();
  for (const r of tree.roots) byRpid.set(r.rpid_str, r);
  for (const list of tree.floorsByRoot.values()) for (const f of list) byRpid.set(f.rpid_str, f);
  return byRpid;
}

/** 「回复 @」对话指向作者名(§2.4:直回根 dialog=自身 rpid 由 floorLine 省略;悬空 → null)。 */
function dialogAuthorOf(f: CommentRecord, byRpid: Map<string, CommentRecord>): string | null {
  if (f.dialog_rpid === '0' || f.dialog_rpid === f.rpid_str) return null;
  return byRpid.get(f.dialog_rpid)?.uname ?? null;
}

/** 单根段渲染（根头 + 正文 + 楼中楼组）。 */
function renderRootGroup(
  lines: string[], tree: CommentTree, byRpid: Map<string, CommentRecord>, r: CommentRecord,
): void {
  lines.push('');
  lines.push(rootHeader(r));
  if (r.message) lines.push(r.message);
  const group = tree.floorsByRoot.get(r.rpid_str) ?? [];
  for (const f of group) {
    lines.push(floorLine(f, floorDepth(f, byRpid), dialogAuthorOf(f, byRpid)));
  }
}

/** 孤儿楼层组（根已删,§3.4 不丢弃;§6.3「根已删除的楼层」）。 */
function appendOrphanFloors(
  lines: string[], tree: CommentTree, byRpid: Map<string, CommentRecord>, shownRootIds: Set<string>,
): void {
  const orphanGroups = [...tree.floorsByRoot.entries()].filter(([rid]) => !shownRootIds.has(rid) && !byRpid.has(rid));
  const orphanFloors = orphanGroups.flatMap(([, l]) => l);
  if (orphanFloors.length > 0) {
    lines.push('');
    lines.push(`## 根已删除的楼层(${orphanFloors.length} 条)`);
    for (const f of orphanFloors) lines.push(floorLine(f, 1, null));
  }
}

/** 评论树 → §6.3 式缩进文本(根 like 降序/组内 ctime 升序由 treeByVideo 保证;limit 只截根数)。 */
export function renderTree(tree: CommentTree, opts: { limit?: number } = {}): string {
  const lines: string[] = [];
  const floors = [...tree.floorsByRoot.values()].reduce((a, l) => a + l.length, 0);
  lines.push(`评论区树:共 ${tree.roots.length + floors} 条(根 ${tree.roots.length} / 楼中楼 ${floors})`);
  if (tree.roots.length === 0 && floors === 0) {
    lines.push('(该视频暂无评论)');
    return lines.join('\n');
  }
  const byRpid = indexByRpid(tree);
  const roots = opts.limit ? tree.roots.slice(0, opts.limit) : tree.roots;
  const shownRootIds = new Set(roots.map((r) => r.rpid_str));
  for (const r of roots) renderRootGroup(lines, tree, byRpid, r);
  appendOrphanFloors(lines, tree, byRpid, shownRootIds);
  if (opts.limit && tree.roots.length > opts.limit) {
    lines.push('');
    lines.push(`(仅显示点赞前 ${opts.limit} 根,共 ${tree.roots.length} 根;--limit 调整)`);
  }
  return lines.join('\n');
}

export function buildTreeSub(): Command {
  const tree = new Command('tree');
  tree.description('按树形缩进打印库内评论(§6.3 格式:根 like 降序+楼中楼按根分组;纯本地 --db 只读)')
    .option('--bvid <bvid>', '目标视频 BV 号(必填)')
    .option('--limit <n>', '只显示点赞前 N 根(0=不限)', '0')
    .action((opts: { bvid?: string; limit?: string }) => {
      const ctx = getCliContext();
      if (!opts.bvid) emitError('需要 --bvid <BV号>', 'ARGS');
      const db = openDbOrEmit(ctx.dbPath);
      const detail = getVideo(db, 'bilibili', opts.bvid as string);
      if (!detail) emitError(`video not found: bilibili/${opts.bvid}`, 'NOT_FOUND');
      const videoId = detail.video.id as number;
      const t = treeByVideo(db, videoId);
      process.stdout.write(renderTree(t, { limit: intOpt(opts.limit, 'limit', 0) || undefined }) + '\n');
    });
  return tree;
}

// ── verify 子命令（§5.2 入口 2:纯库内校验;--stat-reply 外部哨兵可选启 R9）──

export function buildVerifySub(): Command {
  const verify = new Command('verify');
  verify.description('库内评论树完整性校验(R0-R9;纯本地 --db 只读;--stat-reply 启用 R9 规模对账)')
    .option('--bvid <bvid>', '目标视频 BV 号(必填)')
    .option('--stat-reply <n>', '外部哨兵:B 站 view stat.reply 总量(启用 R9 根数缺口对账;缺省跳过)')
    .action((opts: { bvid?: string; statReply?: string }) => {
      const ctx = getCliContext();
      if (!opts.bvid) emitError('需要 --bvid <BV号>', 'ARGS');
      let externalTotal: number | null = null;
      if (opts.statReply !== undefined) {
        const n = Number(opts.statReply);
        if (!Number.isInteger(n) || n < 0) emitError(`--stat-reply 需非负整数,收到: ${opts.statReply}`, 'ARGS');
        externalTotal = n;
      }
      const db = openDbOrEmit(ctx.dbPath);
      const detail = getVideo(db, 'bilibili', opts.bvid as string);
      if (!detail) emitError(`video not found: bilibili/${opts.bvid}`, 'NOT_FOUND');
      const videoId = detail.video.id as number;
      const result = verifyTree(db, videoId, { externalTotal });
      emitResult({ ok: true, bvid: opts.bvid, ...result }, ctx.format);
    });
  return verify;
}

export function buildCommentsCommand(): Command {
  const comments = new Command('comments');
  comments.description('B 站评论区:collect 采集(直连 B 站+server 写库)/ tree·verify 本地只读查看校验');
  comments.addCommand(buildCollectSub());
  comments.addCommand(buildTreeSub());
  comments.addCommand(buildVerifySub());
  return comments;
}
