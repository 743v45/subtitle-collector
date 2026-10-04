// B 站评论响应解析纯函数层(无 IO——网络复用 asr-net.ts,签名在 wbi.ts,编排在 commands/comments.ts)。
// 规格唯一来源:docs/plans/comments/PLAN.md
//   §2.3 字段映射表(六 ID 取 *_str / member+content 快照 / folded 只认 is_folded / is_up String 直读)
//   §2.4 root/parent/dialog 链语义(本层只透传三元组,还原在消费端)
//   §2.5 置顶建模(top 三类 → pins,pin_kind 由 ingest 打值)
//   §4.5 楼中楼(page.count 实时分母透传)/ §4.7 replyDiag 页面特征
// 分层:宿主 CLI 直连 B 站只在评论采集链路(server 不直连平台的分工不变,asr-bili.ts:5 同款定性)。
/** 行来源标记:main=主列表行 / preview=内嵌预览 / floor=楼中楼专翻 / floor-root=楼中楼响应内嵌根 /
 * pin:* =置顶条目本体(诊断用;ingest 组批时剥除,不入库列)。 */
export type RowSource = 'main' | 'preview' | 'floor' | 'floor-root' | `pin:${PinKind}`;

/** §2.3 ID 归一:一律 *_str 优先,缺失时 String(数值) 兜底(rpid 已 3.2e11、mid 已 3.5e15,
 * 逼近 2^53,防御未来越线)。两者皆缺 → null(由 ingest 侧校验拦截)。 */
function idStr(strVal: unknown, numVal: unknown): string | null {
  if (typeof strVal === 'string' && strVal !== '') return strVal;
  if (typeof numVal === 'number' && Number.isFinite(numVal)) return String(numVal);
  if (typeof numVal === 'string' && numVal !== '') return numVal;
  return null;
}

/** 0/1 归一:B 站响应布尔与数值混形(invisible=false、up_action.like=false 实测为 boolean)。 */
function bit(v: unknown): 0 | 1 {
  return v === true || v === 1 ? 1 : 0;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 非空字符串直读(否则 null)。 */
function strOf(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 对象整体 JSON 快照(member/content;缺失或非对象 → null)。 */
function jsonSnapshot(v: unknown): string | null {
  return v != null && typeof v === 'object' ? JSON.stringify(v) : null;
}

/** ctime → ctime_s:B 站原值 unix 秒;非有限数 → null。 */
function ctimeOf(raw: Record<string, unknown>): number | null {
  return typeof raw.ctime === 'number' && Number.isFinite(raw.ctime) ? raw.ctime : null;
}

/** §2.3 folded:只认 folder.is_folded;has_folded(「有折叠子回复」)不并入,防导出误标。 */
function foldedOf(raw: Record<string, unknown>): 0 | 1 {
  return bit((raw.folder as { is_folded?: unknown } | undefined)?.is_folded);
}

/** §2.3 is_up:String 直读比较防 2^53 边界(upper.mid 实测 number 且无 *_str 形态);
 * upperMid 缺省/0(匿名)与 mid 缺失都自然落 0。 */
function isUpOf(midStr: string | null, upperMid: string | number | undefined): 0 | 1 {
  return upperMid && midStr === String(upperMid) ? 1 : 0;
}

/** §2.3 reply_control.location 解析:「IP属地:河北」→ 河北。按半/全角冒号切分取末段
 * (剥「IP属地」前缀段);无 location(匿名采集常态)或剥完为空 → null。 */
export function parseIpLocation(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const seg = raw
    .split(/[:：]/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== 'IP属地')
    .pop();
  return seg ?? null;
}

/** §2.3 归一后的入库行(parse 产物;video_id/first_* /batch_id/pin_kind 等列由 ingest/db 层补)。 */
export interface ParsedCommentRow {
  rpid_str: string | null;
  root_rpid: string;
  parent_rpid: string;
  dialog_rpid: string;
  is_root: 0 | 1; // 冗余派生列:root_rpid==='0'(DDL 同款语义)
  mid_str: string | null;
  uname: string | null; // member.uname 提级(列表/正文渲染免拆包)
  member: string | null; // member 对象整体 JSON 快照(重采整体替换)
  message: string | null; // content.message 原文(检索列)
  content: string | null; // content 对象整体 JSON(emote/jump_url/pictures/@)
  like_count: number; // like(列名避 SQL 关键字 LIKE)
  rcount: number; // 当前可见楼中楼数(对账分母 fallback;实时分母=page.count §4.5)
  reply_total: number; // count 字段:历史楼中楼总数(含已删,实测可 > rcount)
  ctime_s: number | null; // B 站原值 unix 秒(列名 _s 后缀防与毫秒 *_at 混算)
  ip_location: string | null;
  state: number; // 0 正常 / 17 阿瓦隆隐藏;非零皆异常
  invisible: 0 | 1;
  folded: 0 | 1; // §2.3:只认 folder.is_folded;has_folded(「有折叠子回复」)不并入,防误标
  up_like: 0 | 1; // up_action.like(UP 觉得很赞,权威字段)
  up_reply: 0 | 1; // up_action.reply(UP 已回复)
  is_up: 0 | 1; // 评论者==UP 主:String(upperMid)===mid_str 直读防御(§2.3)
  source: RowSource; // 来源标记(诊断用;入库行不含此列,ingest 侧剥除)
}

/** §2.5 置顶三类(admin/upper/vote)。 */
export type PinKind = 'admin' | 'upper' | 'vote';

export interface PinEntry {
  kind: PinKind;
  row: ParsedCommentRow;
}

/** 单条评论归一(§2.3 表逐行对应)。upperMid 为主接口 data.upper.mid(实测 number 且无 *_str
 * 形态);缺省/0 → is_up 恒 0。source 由调用方标注(main/preview/floor/pin:*)。 */
export function parseReplyRow(
  raw: Record<string, unknown>,
  upperMid?: string | number,
  source: RowSource = 'main',
): ParsedCommentRow {
  const rootRpid = idStr(raw.root_str, raw.root) ?? '0';
  const midStr = idStr(raw.mid_str, raw.mid);
  const member = raw.member as Record<string, unknown> | undefined;
  const content = raw.content as Record<string, unknown> | undefined;
  const control = raw.reply_control as { location?: unknown } | undefined;
  const upAction = raw.up_action as { like?: unknown; reply?: unknown } | undefined;
  return {
    rpid_str: idStr(raw.rpid_str, raw.rpid),
    root_rpid: rootRpid,
    parent_rpid: idStr(raw.parent_str, raw.parent) ?? '0',
    dialog_rpid: idStr(raw.dialog_str, raw.dialog) ?? '0',
    is_root: rootRpid === '0' ? 1 : 0,
    mid_str: midStr,
    uname: strOf(member?.uname), // member.uname 提级供列表/正文渲染免拆包
    member: jsonSnapshot(member),
    message: strOf(content?.message), // content.message 原文(检索列)
    content: jsonSnapshot(content),
    like_count: numOr(raw.like, 0),
    rcount: numOr(raw.rcount, 0),
    reply_total: numOr(raw.count, 0),
    ctime_s: ctimeOf(raw),
    ip_location: parseIpLocation(control?.location),
    state: numOr(raw.state, 0),
    invisible: bit(raw.invisible),
    folded: foldedOf(raw),
    up_like: bit(upAction?.like), // up_action.like(UP 觉得很赞,权威字段)
    up_reply: bit(upAction?.reply), // up_action.reply(UP 已回复)
    is_up: isUpOf(midStr, upperMid),
    source,
  };
}

/** §2.5 data.top.{admin,upper,vote} 三类置顶解析;null/缺失/非对象条目跳过。
 * pin 条目本体照常 parseReplyRow(source=pin:<kind>),与普通行同构 upsert。 */
export function parseTop(top: unknown): PinEntry[] {
  const t = (top ?? {}) as Record<string, unknown>;
  const pins: PinEntry[] = [];
  for (const kind of ['admin', 'upper', 'vote'] as const) {
    const entry = t[kind];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      pins.push({ kind, row: parseReplyRow(entry as Record<string, unknown>, undefined, `pin:${kind}`) });
    }
  }
  return pins;
}

/** wbi/main 游标(§2.2):next_offset 原文透传(消费后即弃,不自行构造)。 */
export interface MainCursor {
  is_end: boolean;
  all_count: number | null; // 规模哨兵(与 view stat.reply 对账,§2.2)
  // spike 实测(附录 A.2):不透明 base64 protobuf 串(镜像文档 {type:3,Data:{cursor}} JSON 形态作废),
  // 黑盒 token——不解码不重组;后续请求由编排层包 {"offset": 原文} 作 pagination_str(A.3 裁定①)
  next_offset: string | null;
}

export interface MainParseResult {
  roots: ParsedCommentRow[]; // 主列表 rows + 置顶条目本体(尾部追加,§2.5 兜底)
  previews: ParsedCommentRow[]; // rows[].replies 内嵌预览(source=preview;完整性由楼中楼专翻兜底)
  pins: PinEntry[]; // 置顶三类(去重不在本层做:与 rows 重复时保留列表形态,幂等 upsert 吸收,
  //                  pin_kind 由 ingest 从 pins 打值,§2.5)
  cursor: MainCursor | null; // 透传原文;无 cursor 键(旧接口形态)→ null
}

function upperMidOf(upper: unknown): string | undefined {
  const mid = (upper as { mid?: unknown } | undefined)?.mid;
  if (mid === undefined || mid === null || mid === 0 || mid === '0' || mid === '') return undefined;
  return String(mid);
}

function parseCursor(c: unknown): MainCursor | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const cur = c as Record<string, unknown>;
  const pr = cur.pagination_reply as { next_offset?: unknown } | undefined;
  return {
    is_end: cur.is_end === true,
    all_count: typeof cur.all_count === 'number' ? cur.all_count : null,
    next_offset: typeof pr?.next_offset === 'string' ? pr.next_offset : null,
  };
}

function parseRowsOf(list: unknown, upperMid: string | undefined, source: RowSource): ParsedCommentRow[] {
  if (!Array.isArray(list)) return [];
  const rows: ParsedCommentRow[] = [];
  for (const raw of list) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      rows.push(parseReplyRow(raw as Record<string, unknown>, upperMid, source));
    }
  }
  return rows;
}

/** wbi/main data → { roots, previews, pins, cursor }(§2.2/§2.5/§4.3 parseMain 步)。
 * 置顶条目本体并入 roots 尾部:spike 实测置顶不在 mode=2 首页 rows 中(附录 A.3 裁定③),
 * 本体并入是置顶入库唯一路径;若个别视频重复出现于 rows,同 rpid_str 幂等 upsert 吸收,
 * 不在此层去重(保留列表形态)。 */
export function parseMain(data: Record<string, unknown>): MainParseResult {
  const upperMid = upperMidOf(data.upper);
  const roots = parseRowsOf(data.replies, upperMid, 'main');
  const previews: ParsedCommentRow[] = [];
  const rawRows = Array.isArray(data.replies) ? data.replies : [];
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    previews.push(...parseRowsOf((raw as { replies?: unknown }).replies, upperMid, 'preview'));
  }
  const pins = parseTop(data.top);
  for (const p of pins) roots.push(p.row);
  return { roots, previews, pins, cursor: parseCursor(data.cursor) };
}

export interface FloorParseResult {
  rows: ParsedCommentRow[]; // data.root(内嵌根评论,刷新根行用)置头 + 楼内条目
  pageCount: number | null; // §4.5:data.page.count 实时分母透传(缺失 → null,判停走空页护栏)
}

/** reply/reply data → { rows, pageCount }(§4.5):count>0 时已取条数>=count 判停;
 * null/0 时改「当页 rows 空 + 连续 2 空页」判停(编排层职责,本层只透传)。 */
export function parseFloorPage(data: Record<string, unknown>): FloorParseResult {
  const upperMid = upperMidOf(data.upper);
  const rows: ParsedCommentRow[] = [];
  const root = data.root;
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    rows.push(parseReplyRow(root as Record<string, unknown>, upperMid, 'floor-root'));
  }
  rows.push(...parseRowsOf(data.replies, upperMid, 'floor'));
  const page = data.page as { count?: unknown } | undefined;
  return { rows, pageCount: typeof page?.count === 'number' ? page.count : null };
}

/** 主列表游标推进(§2.2/§4.4):is_end 或 next_offset 缺失/空 → null(判停);
 * next_offset 与上页相同 → null(防打转护栏:服务端游标异常,[fetch] 日志由编排层报;
 * 只对 mode=2 链挂——mode=3 同 token 恒定是设计使然,附录 A.2;包裹 {"offset":...} 是编排层职责)。 */
export function nextMainPageArgs(
  prevCursor: string | null,
  resp: { cursor: MainCursor | null },
): string | null {
  const c = resp.cursor;
  if (!c || c.is_end) return null;
  const next = c.next_offset;
  if (next === null || next === '') return null;
  if (prevCursor !== null && next === prevCursor) return null;
  return next;
}

/** 归零空壳判定(§4.7:特征=page 全 0 + replies null;实测旧接口 pn≥2 形态)。 */
export function isEmptyShell(data: Record<string, unknown> | null | undefined): boolean {
  const page = data?.page as { num?: unknown; size?: unknown; count?: unknown; acount?: unknown } | undefined;
  if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
  const allZero = numOr(page.num, -1) === 0 && numOr(page.size, -1) === 0 && numOr(page.count, -1) === 0 && numOr(page.acount, -1) === 0;
  return allZero && data!.replies == null;
}

/** 评论区关闭(§2.4):wbi/main code 12002 → 正常终态(归一 comments_disabled,不报错不重试)。 */
export function isCommentsDisabled(code: number | string | null | undefined): boolean {
  return String(code) === '12002';
}

/** 风控凭证判定(§4.7/§8.5):响应体带 v_voucher = 触发验证——采集侧只如实失败报告,不走自动化。 */
export function hasRiskVoucher(data: Record<string, unknown> | null | undefined): boolean {
  return data?.v_voucher != null;
}

/** §4.7 replyDiag 页面特征串(对位 youtube-collect-videos.mjs 的 pageDiag):
 * 键集排序 + page 形态 + replies 计数 + cursor 摘要 + voucher 标记;任何「内容不符预期」失败必带。 */
export function replyDiag(data: Record<string, unknown> | null | undefined): string {
  const d = data ?? {};
  const cur = d.cursor as { is_end?: unknown; all_count?: unknown } | undefined;
  const cursor =
    cur && typeof cur === 'object' && !Array.isArray(cur)
      ? `is_end=${String(cur.is_end)},all_count=${String(cur.all_count)}`
      : 'null';
  const replies = Array.isArray(d.replies) ? d.replies.length : String(d.replies);
  const voucher = d.v_voucher ? 'present(风控凭证!)' : '-';
  return (
    `diag keys=[${Object.keys(d).sort().join(',')}]`
    + ` page=${JSON.stringify(d.page ?? null)}`
    + ` replies=${replies}`
    + ` cursor=${cursor}`
    + ` voucher=${voucher}`
  );
}
