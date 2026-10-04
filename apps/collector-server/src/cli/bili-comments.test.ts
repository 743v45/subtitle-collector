// bili-comments.ts 纯函数测试:评论响应解析族(§2.3 字段映射/置顶/游标推进/形态判定/replyDiag)。
// 夹具蓝本:2026-10-03 真实抓包(/tmp/bili-comment-probe 的 main-sort2.json / rr-p1.json /
// main-pn2.json),布尔与数值混形(invisible=false、up_action.like=false)是实测形态。
// wbi/main 游标形态按 2026-10-04 spike 实录(PLAN 附录 A)构造:next_offset 是不透明 base64
// protobuf 串(镜像文档的 {type:3,Data:{cursor}} JSON 形态已作废),原文透传当黑盒 token;
// {"offset":...} 包裹由编排层负责(A.3 裁定①),不在本层。
//
// 测试轮次记录表(对齐全局规则):
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | parseReplyRow×4 + parseIpLocation×1 + parseTop×1 + parseMain×3 + 形态判定×1 + nextMainPageArgs×1 + parseFloorPage×1 + replyDiag×1 | 通过 | 2026-10-04 C3;本地 node --test + tsc --noEmit;游标夹具随 spike 附录 A 实测形态校准 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReplyRow, parseIpLocation, parseTop, parseMain, parseFloorPage,
  nextMainPageArgs, isEmptyShell, isCommentsDisabled, hasRiskVoucher, replyDiag,
  type MainParseResult,
} from './bili-comments.js';

// 真实根评论条目最小化(main-sort2.json 首条;保留布尔混形与大小 ID)
function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rpid: 315856480705, rpid_str: '315856480705',
    root: 0, root_str: '0', parent: 0, parent_str: '0', dialog: 0, dialog_str: '0',
    mid: 3546726185044476, mid_str: '3546726185044476',
    like: 585, rcount: 5, count: 5, ctime: 1791002056, state: 0, invisible: false,
    folder: { has_folded: false, is_folded: false, rule: '' },
    up_action: { like: false, reply: false },
    reply_control: { max_line: 6, time_desc: '9小时前发布' },
    member: { mid: '3546726185044476', uname: '芙芙小包被', level_info: { current_level: 6 } },
    content: { message: '难道就因为他杀过人…[生气][生气]', emote: { '[生气]': {} } },
    ...over,
  };
}

const UPPER_MID = 3493260618106936; // data.upper.mid 实测为 number 且无 *_str 形态(spike 附录 A.2)
const NEXT_OFFSET_P1 = 'CAESEDE4MzQwMzQzNDI2NjY3NTIaADIDCI4I'; // spike 实测 mode=2 首页 next_offset(不透明 protobuf 串)
const NEXT_OFFSET_P2 = 'CAQSEDE4MzQwMzQzNDI2NjY3NTIaADIDCJAE'; // 模拟下一页(形态同实测:base64 串)

test('parseReplyRow:五 ID 取 *_str,缺失兜底 String(数值);布尔形态归一 0/1;根行 is_root 派生', () => {
  const row = parseReplyRow(rawRow());
  assert.equal(row.rpid_str, '315856480705');
  assert.equal(row.root_rpid, '0');
  assert.equal(row.parent_rpid, '0');
  assert.equal(row.dialog_rpid, '0');
  assert.equal(row.mid_str, '3546726185044476');
  assert.equal(row.is_root, 1, 'root_rpid=0 → 根行');
  assert.equal(row.invisible, 0, '实测 invisible=false 是 boolean → 0');
  assert.equal(row.up_like, 0);
  assert.equal(row.up_reply, 0);
  assert.equal(row.like_count, 585);
  assert.equal(row.reply_total, 5, 'count 字段 → reply_total(历史楼中楼总数)');
  assert.equal(row.rcount, 5);
  assert.equal(row.ctime_s, 1791002056, 'B 站原值 unix 秒');
  assert.equal(row.state, 0);
  assert.equal(row.source, 'main');
  // *_str 缺失 → String(数值) 兜底(rpid 3.2e11/mid 3.5e15 防御,§2.3)
  const fallback = parseReplyRow(rawRow({
    rpid_str: undefined, root: 315853861041, root_str: undefined,
    parent: 315853861041, parent_str: undefined, dialog: 315854390241, dialog_str: undefined,
  }));
  assert.equal(fallback.rpid_str, '315856480705');
  assert.equal(fallback.root_rpid, '315853861041');
  assert.equal(fallback.parent_rpid, '315853861041');
  assert.equal(fallback.dialog_rpid, '315854390241');
  assert.equal(fallback.is_root, 0, '楼中楼行 → 非根');
  // 数值形态兜底也认 *_str 为字符串数值的情况(root_str 传数值字符串)
  assert.equal(parseReplyRow(rawRow({ root_str: '315853861041', root: undefined })).root_rpid, '315853861041');
  // 全缺 → null(rpid_str 唯一键,由 ingest 侧校验拦截)
  const empty = parseReplyRow(rawRow({ rpid: undefined, rpid_str: undefined, mid: undefined, mid_str: undefined }));
  assert.equal(empty.rpid_str, null);
  assert.equal(empty.mid_str, null);
});

test('parseReplyRow:folded 只认 folder.is_folded,has_folded(有折叠子回复)不并入(§2.3 防误标)', () => {
  assert.equal(parseReplyRow(rawRow({ folder: { has_folded: true, is_folded: false, rule: '' } })).folded, 0,
    'has_folded=1 而 is_folded=0:该评论自身正常,不得误标 folded=1(否则导出大面积误标[已折叠])');
  assert.equal(parseReplyRow(rawRow({ folder: { has_folded: false, is_folded: true, rule: '' } })).folded, 1);
  assert.equal(parseReplyRow(rawRow({ folder: undefined })).folded, 0, 'folder 缺失 → 0');
});

test('parseReplyRow:member 整体 JSON 快照 + uname 提级;content.message 主列 + content 整体 JSON', () => {
  const row = parseReplyRow(rawRow());
  assert.equal(row.uname, '芙芙小包被', 'uname 提级供列表/正文渲染免拆包');
  const member = JSON.parse(row.member!) as { level_info: { current_level: number } };
  assert.equal(member.level_info.current_level, 6, 'member 快照可还原等级画像');
  assert.equal(row.message, '难道就因为他杀过人…[生气][生气]', '正文原文含表情码');
  const content = JSON.parse(row.content!) as { emote: Record<string, unknown> };
  assert.deepEqual(Object.keys(content.emote), ['[生气]'], 'content 整体存(emote/jump_url/pictures/@)');
  const bare = parseReplyRow(rawRow({ member: undefined, content: undefined }));
  assert.equal(bare.member, null);
  assert.equal(bare.uname, null);
  assert.equal(bare.message, null);
  assert.equal(bare.content, null);
});

test('parseIpLocation:「IP属地:河北」取末段;半/全角冒号皆认;缺失/剥完为空 → null', () => {
  assert.equal(parseIpLocation('IP属地:河北'), '河北');
  assert.equal(parseIpLocation('IP属地：上海'), '上海', '全角冒号(B 站实际渲染形态)');
  assert.equal(parseIpLocation('河北'), '河北', '无前缀裸属地照取');
  assert.equal(parseIpLocation('IP属地:'), null, '剥完为空 → null');
  assert.equal(parseIpLocation(''), null);
  assert.equal(parseIpLocation(undefined), null, '匿名采集常态:location 缺失 → null');
});

test('parseReplyRow:is_up 用 String 直读比较(upper.mid 数值形态防御);upperMid 缺省恒 0', () => {
  const upRow = rawRow({ mid: UPPER_MID, mid_str: String(UPPER_MID), uname: 'UP主本人' });
  assert.equal(parseReplyRow(upRow, UPPER_MID).is_up, 1, 'number upperMid vs string mid_str:String 后比较');
  assert.equal(parseReplyRow(upRow, String(UPPER_MID)).is_up, 1, 'string upperMid 同判(upper.mid 无 *_str 形态,两种皆防)');
  assert.equal(parseReplyRow(rawRow(), UPPER_MID).is_up, 0, '非 UP 主评论者 → 0');
  assert.equal(parseReplyRow(rawRow()).is_up, 0, 'upperMid 缺省 → 0(§2.3)');
  const noMid = rawRow({ mid: undefined, mid_str: undefined });
  assert.equal(parseReplyRow(noMid, UPPER_MID).is_up, 0, 'mid 缺失不误判 is_up');
  // invisible/up_action 的数值 1 形态(防御响应形态漂移)
  assert.equal(parseReplyRow(rawRow({ invisible: 1 })).invisible, 1);
  const upActed = parseReplyRow(rawRow({ up_action: { like: true, reply: true } }));
  assert.equal(upActed.up_like, 1);
  assert.equal(upActed.up_reply, 1);
  assert.equal(parseReplyRow(rawRow({ like: NaN })).like_count, 0, 'NaN like → 0(非有限数兜底)');
  assert.equal(parseReplyRow(rawRow({ state: 17 })).state, 17, '阿瓦隆隐藏原值保留(§2.4 照常入库)');
});

test('parseTop:admin/upper/vote 三类解析,source 标 pin:<kind>;null/非对象条目跳过', () => {
  const adminRow = rawRow({ rpid_str: '111', rpid: 111 });
  const upperRow = rawRow({ rpid_str: '222', rpid: 222 });
  const voteRow = rawRow({ rpid_str: '333', rpid: 333 });
  const pins = parseTop({ admin: adminRow, upper: upperRow, vote: voteRow });
  assert.deepEqual(pins.map((p) => p.kind), ['admin', 'upper', 'vote']);
  assert.equal(pins[0].row.source, 'pin:admin');
  assert.equal(pins[1].row.rpid_str, '222');
  // 实测形态:未出现的置顶类为 null;异常形态(数组/字符串)也跳过
  const partial = parseTop({ admin: null, upper: upperRow, vote: [] });
  assert.deepEqual(partial.map((p) => p.kind), ['upper'], 'null/数组条目跳过');
  assert.deepEqual(parseTop(undefined), [], 'top 缺失 → 空数组');
  assert.deepEqual(parseTop({ admin: 'garbage' }), [], '字符串条目跳过');
});

function mainData(over: Record<string, unknown> = {}): Record<string, unknown> {
  const floorSub1 = rawRow({
    rpid: 315854390241, rpid_str: '315854390241', root: 315853861041, root_str: '315853861041',
    parent: 315853861041, parent_str: '315853861041', dialog: 315854390241, dialog_str: '315854390241',
    like: 19,
  });
  return {
    replies: [
      rawRow({ replies: [floorSub1, rawRow({ rpid_str: '999', rpid: 999, like: 1 })] }),
      rawRow({ rpid_str: '777', rpid: 777 }),
    ],
    top: { admin: null, upper: null, vote: null },
    upper: { mid: UPPER_MID, top: null, vote: null },
    cursor: { is_end: false, all_count: 1893, pagination_reply: { next_offset: NEXT_OFFSET_P1 } },
    ...over,
  };
}

test('parseMain:正常形态——roots/previews 分列、预览标 source=preview、upper.mid 数值驱动 is_up、cursor 透传', () => {
  const r = parseMain(mainData());
  assert.equal(r.roots.length, 2, '主列表 2 根行');
  assert.equal(r.previews.length, 2, 'rows[].replies 内嵌预览一并 parse(§2.3)');
  assert.equal(r.roots[0].source, 'main');
  assert.equal(r.previews[0].source, 'preview');
  assert.equal(r.previews[0].rpid_str, '315854390241');
  assert.equal(r.previews[0].is_up, 0, '楼中楼作者非 UP 主');
  assert.equal(r.cursor!.is_end, false);
  assert.equal(r.cursor!.all_count, 1893);
  assert.equal(r.cursor!.next_offset, NEXT_OFFSET_P1, 'next_offset 原文透传(黑盒 token,不解码不重组;包裹由编排层负责,A.3 裁定①)');
});

test('parseMain:置顶本体并入 roots 尾部且 pins 独立保留;若重复出现于 rows 幂等交 upsert(A.3 裁定③)', () => {
  const dupPin = rawRow({ rpid_str: '777', rpid: 777, like: 999 }); // 与主列表第 2 行同 rpid(防御形态)
  const r = parseMain(mainData({ top: { admin: null, upper: dupPin, vote: null } }));
  assert.equal(r.pins.length, 1);
  assert.equal(r.pins[0].kind, 'upper');
  assert.equal(r.roots.length, 3, '2 根行 + 置顶本体并入——实测置顶不在 mode=2 首页 rows 中,本体并入是置顶入库唯一路径(A.3③)');
  assert.equal(r.roots[2].source, 'pin:upper');
  assert.equal(r.roots.filter((x) => x.rpid_str === '777').length, 2, '若个别视频置顶重复出现于 rows:保留列表形态,UNIQUE(rpid_str) 幂等 upsert 吸收');
});

test('parseMain:归零空壳(page 全 0 + replies null,实测旧接口 pn≥2 形态)→ 全空结果、cursor null', () => {
  const shell = {
    page: { num: 0, size: 0, count: 0, acount: 0 },
    replies: null,
    top: { admin: null, upper: null, vote: null },
    upper: { mid: 0, top: null, vote: null },
  };
  const r = parseMain(shell);
  assert.deepEqual(r, { roots: [], previews: [], pins: [], cursor: null });
  assert.equal(isEmptyShell(shell), true, '归零空壳判定命中');
  // 防御形态:rows 里混入非对象条目不炸
  const noisy = parseMain({ replies: [null, 42, ['x'], rawRow()] });
  assert.equal(noisy.roots.length, 1, '非对象条目剔除');
});

test('isEmptyShell/isCommentsDisabled/hasRiskVoucher:三类形态判定(空壳/关评 12002/风控凭证)', () => {
  assert.equal(isEmptyShell({ page: { num: 1, size: 20, count: 1893, acount: 1893 }, replies: [] }), false,
    '健康页 rows 空不误判空壳(空页判停是编排层职责)');
  assert.equal(isEmptyShell({ replies: null }), false, '无 page 键不判空壳(wbi/main 游标形态退化走 rows 空判停)');
  assert.equal(isEmptyShell(null), false);
  assert.equal(isEmptyShell({ page: ['x'], replies: null }), false, 'page 非对象不判空壳');
  assert.equal(isEmptyShell({ page: { count: 0 }, replies: null }), false, 'page 键残缺(非全 0)不判空壳');
  assert.equal(isCommentsDisabled(12002), true, 'code 12002 → 评论区关闭,正常终态(§2.4)');
  assert.equal(isCommentsDisabled('12002'), true);
  assert.equal(isCommentsDisabled(0), false);
  assert.equal(isCommentsDisabled(-101), false);
  assert.equal(isCommentsDisabled(12001), false);
  assert.equal(hasRiskVoucher({ v_voucher: { token: 'x' } }), true, 'v_voucher present = 触发验证,只如实失败不自动化(§8.5)');
  assert.equal(hasRiskVoucher({}), false);
  assert.equal(hasRiskVoucher(null), false);
});

test('nextMainPageArgs:next_offset 透传原文;is_end/缺失/空串判停;同游标打转判停(§4.4 护栏,只对 mode=2 链)', () => {
  const mk = (cursor: MainParseResult['cursor']): { cursor: MainParseResult['cursor'] } => ({ cursor });
  assert.equal(nextMainPageArgs(NEXT_OFFSET_P1, mk({ is_end: false, all_count: 2101, next_offset: NEXT_OFFSET_P2 })),
    NEXT_OFFSET_P2, '原文透传,不自行构造(包裹 {"offset":...} 是编排层职责,A.3 裁定①)');
  assert.equal(nextMainPageArgs(null, mk({ is_end: true, all_count: 2101, next_offset: NEXT_OFFSET_P2 })), null, 'is_end → 判停');
  assert.equal(nextMainPageArgs(null, mk({ is_end: false, all_count: 1, next_offset: null })), null, 'next_offset 缺失 → 判停');
  assert.equal(nextMainPageArgs(null, mk({ is_end: false, all_count: 1, next_offset: '' })), null, '空串视同缺失');
  assert.equal(nextMainPageArgs(null, mk(null)), null, 'cursor 缺失(旧接口形态)→ 判停');
  assert.equal(nextMainPageArgs(NEXT_OFFSET_P2, mk({ is_end: false, all_count: 1, next_offset: NEXT_OFFSET_P2 })),
    null, '与上页游标相同 → 打转护栏判停(mode=2 游标实测逐页变化,恒同=服务端异常;mode=3 token 恒定是设计使然,护栏只挂 mode=2 遍历,A.2)');
});

test('parseFloorPage:rows 含 data.root 头部(source=floor-root)+ 楼内条目(source=floor);pageCount 透传', () => {
  const rootRow = rawRow({ rpid: 315853861041, rpid_str: '315853861041', rcount: 7, count: 8 });
  const sub1 = rawRow({
    rpid: 315854390241, rpid_str: '315854390241', root: 315853861041, root_str: '315853861041',
    parent: 315853861041, parent_str: '315853861041', dialog: 315854390241, dialog_str: '315854390241',
  });
  const r = parseFloorPage({
    root: rootRow,
    replies: [sub1, rawRow({ rpid_str: '555', rpid: 555, parent_str: '315854390241', parent: 315854390241, dialog_str: '315854390241', dialog: 315854390241 })],
    page: { num: 1, size: 10, count: 7 },
    upper: { mid: UPPER_MID },
  });
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].source, 'floor-root', '内嵌根评论置头(刷新根行 like/rcount 用,§4.5)');
  assert.equal(r.rows[0].rpid_str, '315853861041');
  assert.equal(r.rows[1].source, 'floor');
  assert.equal(r.rows[1].dialog_rpid, '315854390241', '直回根条目 dialog=自身 rpid(§2.4 实测)');
  assert.equal(r.pageCount, 7, 'page.count 实时分母透传');
  assert.equal(parseFloorPage({ replies: [] }).pageCount, null, 'page 缺失 → null(判停走空页护栏)');
  assert.equal(parseFloorPage({ replies: [], page: { num: 1, size: 20, count: 0 } }).pageCount, 0, 'count=0 原样透传(判停分叉点在编排层)');
  const noRoot = parseFloorPage({ replies: [sub1], root: ['bad'], page: { count: 2 } });
  assert.equal(noRoot.rows.length, 1, 'root 异常形态跳过,楼内条目照常解析');
});

test('replyDiag:输出含排序键集/page 形态/replies 计数/cursor 摘要/voucher 标记(§4.7 对位 pageDiag)', () => {
  const healthy = replyDiag(mainData());
  assert.match(healthy, /^diag keys=\[/, '键集排序在前');
  assert.match(healthy, /keys=\[cursor,replies,top,upper\]/, '健康页键集(排序后)');
  assert.match(healthy, /replies=2/);
  assert.match(healthy, /cursor=is_end=false,all_count=1893/);
  assert.match(healthy, /voucher=-$/, '无凭证 → -');
  const shell = replyDiag({ page: { num: 0, size: 0, count: 0, acount: 0 }, replies: null });
  assert.match(shell, /page={"num":0,"size":0,"count":0,"acount":0}/, '归零空壳 page 形态可见');
  assert.match(shell, /replies=null/);
  assert.match(shell, /cursor=null/);
  const risk = replyDiag({ v_voucher: { token: 'x' } });
  assert.match(risk, /voucher=present\(风控凭证!\)/, '风控凭证显式命名(先修日志再猜原因,CLAUDE.md §9)');
  assert.match(replyDiag(null), /keys=\[\]/, 'null data 不炸,给空键集');
  assert.match(replyDiag({ cursor: ['bad'], replies: 'x' }), /cursor=null/, 'cursor 异常形态 → null');
});
