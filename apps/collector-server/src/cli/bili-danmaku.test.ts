// bili-danmaku.ts 纯函数测试:seg.so protobuf 解析族(wire-format 遍历/字段白名单映射/精度回归/段数计算/segDiag)。
// 夹具蓝本:docs/plans/danmaku/PLAN.md 附录 A spike 实录(BV1GJ411x7h7 163KB/1408 条与长视频
// 2100 条全样本零失败;field1 int64 精度漂移实测 37828425933127683→…80)。
// 测试专用 protobuf 编码器 encodeDanmakuElem/encodeSeg 只在本文件构造夹具,不进生产代码。
//
// 测试轮次记录表(对齐全局规则):
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | readVarint×1 + parseProtoFields×1 + parseSeg×7 + segmentsForDuration×1 + segDiag×1 | 通过 | 2026-10-07 C2;本地 node --test --import tsx + tsc --noEmit;夹具按 PLAN §2.3 字段字典与附录 A 实测形态构造 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readVarint, parseProtoFields, parseSeg, segmentsForDuration, segDiag,
} from './bili-danmaku.js';

// ---- 测试夹具:最小 protobuf 编码器(测试专用,生产解析方向相反) ----

/** varint 编码:负数按 int64 二补码转无符号 64 位(protobuf 标准,-1 → 10 字节 0xFF…01)。 */
function encVarint(n: number | bigint): Uint8Array {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return new Uint8Array(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function tag(fieldNo: number, wireType: number): Uint8Array {
  return encVarint((fieldNo << 3) | wireType);
}

function fVarint(fieldNo: number, n: number | bigint): Uint8Array {
  return concat(tag(fieldNo, 0), encVarint(n));
}

function fBytes(fieldNo: number, payload: Uint8Array): Uint8Array {
  return concat(tag(fieldNo, 2), encVarint(payload.length), payload);
}

function fStr(fieldNo: number, s: string): Uint8Array {
  return fBytes(fieldNo, new TextEncoder().encode(s));
}

/** 夹具值类型:number/bigint → varint 字段;string → utf8 length-delimited;Uint8Array → 原样字节。 */
type ElemValue = number | bigint | string | Uint8Array;

function encFields(fields: Array<[number, ElemValue]>): Uint8Array {
  return concat(...fields.map(([no, v]) =>
    typeof v === 'number' || typeof v === 'bigint' ? fVarint(no, v)
    : typeof v === 'string' ? fStr(no, v)
    : fBytes(no, v)));
}

/** 单条 DanmakuElem 编码(字段号任意序/可重复,重现 B 站实测形态)。 */
function encodeDanmakuElem(fields: Array<[number, ElemValue]>): Uint8Array {
  return encFields(fields);
}

/** seg.so 顶层编码:每个 elem 包为顶层 field1(length-delimited);topExtra 追加顶层其他字段(如 field4/5)。 */
function encodeSeg(elems: Uint8Array[], topExtra: Array<[number, ElemValue]> = []): Uint8Array {
  return concat(...elems.map((e) => fBytes(1, e)), encFields(topExtra));
}

// ---- readVarint ----

test('readVarint:单字节直读;多字节(300)按 7 位组拼接;最大 10 字节 2^64-1 边界;返回新位置', () => {
  assert.deepEqual(readVarint(new Uint8Array([0x05]), 0), [5n, 1], '单字节:最高位 0 即止');
  assert.deepEqual(readVarint(new Uint8Array([0xac, 0x02]), 0), [300n, 2], '300 = 0x2c | (2<<7)');
  assert.deepEqual(readVarint(new Uint8Array([0xff, 0xac, 0x02]), 1), [300n, 3], '从非 0 偏移读');
  const max = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
  assert.deepEqual(readVarint(max, 0), [18446744073709551615n, 10], '2^64-1 恰好 10 字节(int64 二补码 -1 形态)');
});

test('readVarint:截断(续位后耗尽)抛错;超 10 字节上限抛错(均带位置)', () => {
  assert.throws(() => readVarint(new Uint8Array([0x80]), 0), /截断/, '续位置 1 但缓冲区耗尽');
  assert.throws(() => readVarint(new Uint8Array([0x80, 0x80, 0x80]), 0), /截断/);
  assert.throws(() => readVarint(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0),
    /10 字节上限/, '10 字节全续位 = 第 10 字节仍要求继续 → 协议异常');
});

// ---- parseProtoFields:四种 wireType + group 抛错 + 截断带位置 ----

test('parseProtoFields:wireType 0/1/2/5 四种形态解析正确,字段顺序保持', () => {
  const buf = concat(
    fVarint(3, 300), // wireType 0
    concat(tag(7, 1), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), // wireType 1 fixed64
    fStr(2, 'abc'), // wireType 2
    concat(tag(9, 5), new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])), // wireType 5 fixed32
  );
  const fields = parseProtoFields(buf);
  assert.deepEqual(fields.map((f) => [f.fieldNo, f.wireType]), [[3, 0], [7, 1], [2, 2], [9, 5]]);
  assert.equal(fields[0].varint, 300n);
  assert.deepEqual([...fields[1].bytes!], [1, 2, 3, 4, 5, 6, 7, 8], 'fixed64 原样 8 字节');
  assert.equal(new TextDecoder().decode(fields[2].bytes!), 'abc');
  assert.equal(fields[2].bytes!.length, 3);
  assert.deepEqual([...fields[3].bytes!], [0xaa, 0xbb, 0xcc, 0xdd], 'fixed32 原样 4 字节');
  assert.equal('varint' in fields[1], false, 'fixed 字段无 varint 值');
  assert.deepEqual(parseProtoFields(new Uint8Array(0)), [], '空缓冲区 = 空消息,合法');
});

test('parseProtoFields:group(wireType 3/4)抛错;长度/定宽截断抛错且带位置', () => {
  assert.throws(() => parseProtoFields(tag(5, 3)), /group/, 'wireType 3(deprecated group)样本未见,触发即协议变化');
  assert.throws(() => parseProtoFields(tag(5, 4)), /group/, 'wireType 4(group 结束)同抛');
  // length-delimited 声明 10 字节但只剩 2
  const truncated = concat(tag(2, 2), encVarint(10), new Uint8Array([0x01, 0x02]));
  assert.throws(() => parseProtoFields(truncated), /length-delimited 截断.*pos=2/, '错误消息带位置');
  // fixed64 只剩 3 字节
  assert.throws(() => parseProtoFields(concat(tag(4, 1), new Uint8Array([1, 2, 3]))), /fixed64 截断/);
  // fixed32 只剩 2 字节
  assert.throws(() => parseProtoFields(concat(tag(4, 5), new Uint8Array([1, 2]))), /fixed32 截断/);
});

// ---- parseSeg:字段映射 ----

/** 全字段 elem 夹具(对齐 PLAN §2.3 白名单;数值取附录 A 实测形态)。 */
function fullElem(id: string): Uint8Array {
  return encodeDanmakuElem([
    [1, 17037828267n], // field1 int64 id:严禁入库(只验证不进结果)
    [2, 837], [3, 1], [4, 25], [5, 16777215],
    [6, 'd2b24dbe'], [7, '前排'], [8, 1593092327], [9, 9], [11, 0], [12, id],
  ]);
}

test('parseSeg:多 elem 全字段映射正确;id_str 取 field12 字符串;field1 不进结果', () => {
  const r = parseSeg(encodeSeg([fullElem('17037828267'), fullElem('17037829001')]));
  assert.equal(r.elems.length, 2);
  assert.deepEqual(r.topFieldCounts, { 1: 2 }, '顶层只有 field1(每 elem 一次)');
  const a = r.elems[0];
  assert.equal(a.id_str, '17037828267', '唯一键 = field12 字符串');
  assert.equal(a.progress_ms, 837);
  assert.equal(a.mode, 1);
  assert.equal(a.fontsize, 25);
  assert.equal(a.color, 16777215, '十进制 RGB 白色');
  assert.equal(a.mid_hash, 'd2b24dbe', 'CRC32 hex 匿名哈希');
  assert.equal(a.content, '前排');
  assert.equal(a.ctime_s, 1593092327, 'B 站原值 unix 秒');
  assert.equal(a.weight, 9);
  assert.equal(a.pool, 0);
  assert.equal(a.action, null, '实测样本无 field10,缺省 null');
  assert.equal('id' in a, false, 'field1 不得产生任何入库形态(接口无 id 列)');
  assert.deepEqual(r.unknownFieldCounts, {}, '全白名单夹具无未知字段');
});

test('parseSeg:精度回归(PLAN §7.3/D3)——field1=37828425933127683 大整型不入库,入库键等于 field12 字符串', () => {
  // 真实 B 站样本形态:field1 varint 与 field12 字符串同为 37828425933127683(>2^53)
  const elem = encodeDanmakuElem([[1, 37828425933127683n], [2, 1200], [12, '37828425933127683']]);
  const r = parseSeg(encodeSeg([elem]));
  assert.ok(Number.isSafeInteger(Number.MAX_SAFE_INTEGER) && 37828425933127683 > Number.MAX_SAFE_INTEGER,
    '前提:该值超出 JS 安全整型范围');
  assert.notEqual(BigInt(Number(37828425933127683n)), 37828425933127683n,
    'Number 往返漂移实证(真值 …83 → double …80,字面量本身亦被舍入)——这正是严禁 field1 转 Number 的原因');
  assert.equal(r.elems[0].id_str, '37828425933127683', '入库键必须逐字节等于 field12 字符串');
  assert.equal(r.elems[0].progress_ms, 1200, '同 elem 其他字段不受影响');
  assert.equal(r.missingIdCount, 0);
});

test('parseSeg:progress_ms=-1(高级弹幕,10 字节二补码形态)原值保留;缺 progress 的 elem → null', () => {
  const r = parseSeg(encodeSeg([
    encodeDanmakuElem([[12, 'a1'], [2, -1], [3, 7]]), // mode 7 = 高级弹幕
    encodeDanmakuElem([[12, 'a2']]), // 只带 id_str:其余全缺省
  ]));
  assert.equal(r.elems[0].progress_ms, -1, '-1 原值保留不钳(§2.3,verify 统计负责)');
  assert.equal(r.elems[0].mode, 7);
  const bare = r.elems[1];
  assert.equal(bare.progress_ms, null);
  assert.equal(bare.mode, null);
  assert.equal(bare.color, null);
  assert.equal(bare.content, null, '白名单内字段缺失一律 null');
  assert.equal(bare.id_str, 'a2');
});

test('parseSeg:白名单外字段(13/15/26)按 wireType 正确跳过不报错,unknownFieldCounts 计数正确', () => {
  const elem = encodeDanmakuElem([
    [12, 'k1'], [13, 7], [13, 8], // 13 号两次(实测出现,语义未解明)
    [15, 'sixteen?'], // 15 号字符串形态(实测混合)
    [26, 42504555111n], // 26 号疑似回显 cid
  ]);
  const r = parseSeg(encodeSeg([elem]));
  assert.equal(r.elems.length, 1);
  assert.equal(r.elems[0].id_str, 'k1');
  assert.deepEqual(r.unknownFieldCounts, { 13: 2, 15: 1, 26: 1 }, '按字段号累计出现次数(§4.7 未识别分布)');
  assert.deepEqual(r.topFieldCounts, { 1: 1 }, '未知字段不计顶层(计数发生在 elem 层)');
});

test('parseSeg:缺 field12 的 elem 丢弃且 missingIdCount 计数;elems+missing 与 topFieldCounts[1] 对账', () => {
  const r = parseSeg(encodeSeg([
    fullElem('ok1'),
    encodeDanmakuElem([[2, 500], [7, '没有 id 的孤儿']]), // 缺 field12 → 丢弃
  ]));
  assert.equal(r.elems.length, 1, '缺唯一键的条目直接丢弃');
  assert.equal(r.elems[0].id_str, 'ok1');
  assert.equal(r.missingIdCount, 1);
  assert.equal(r.topFieldCounts[1], 2, '顶层 field1 计 elem 原始数(含被丢弃的)');
  assert.equal(r.elems.length + r.missingIdCount, r.topFieldCounts[1], 'parseSeg 不变量(编排层日志对账用)');
});

test('parseSeg:空段(空 elems)零计数;顶层 field4/5(分段配置类)只进 topFieldCounts 不产条目', () => {
  const empty = parseSeg(new Uint8Array(0));
  assert.deepEqual(empty, { elems: [], topFieldCounts: {}, unknownFieldCounts: {}, missingIdCount: 0 },
    '空响应体 = 空段(该段无弹幕),正常终态');
  const r = parseSeg(encodeSeg([fullElem('ok1')], [[4, 1], [5, 2]]));
  assert.deepEqual(r.topFieldCounts, { 1: 1, 4: 1, 5: 1 }, 'field4/5 各一,仅计数(§2.3 不入库)');
  assert.equal(r.elems.length, 1);
});

test('parseSeg:content 中文 utf8 多字节正确解码;长字符串(>127 字节)varint 长度多字节', () => {
  const content = '经典🔥永远的神!!!( Angels ← emoji 四字节)';
  const long = 'a'.repeat(200) + '弹'.repeat(50); // 250 ASCII + 150 = 400 字节 → 长度 varint 2 字节
  const r = parseSeg(encodeSeg([
    encodeDanmakuElem([[12, 'c1'], [7, content]]),
    encodeDanmakuElem([[12, 'c2'], [7, long]]),
    encodeDanmakuElem([[12, 'c3'], [6, '前'.repeat(40)]]), // 120 字节 mid_hash 形态防御(实测 8 位,漂移不炸)
  ]));
  assert.equal(r.elems[0].content, content, '多字节 utf8 逐字节还原');
  assert.equal(r.elems[1].content, long, '400 字节体:长度字段跨入 varint 多字节区');
  assert.equal(r.elems[2].mid_hash, '前'.repeat(40));
  assert.equal(r.elems[1].content.length, 250);
});

test('parseSeg:白名单内字段 wireType 漂移(field3 变字符串)静默跳过保持 null;elem 内 group 形态抛错上传', () => {
  const drifted = parseSeg(encodeSeg([encodeDanmakuElem([[12, 'k'], [3, 'drifted-into-string']])]));
  assert.equal(drifted.elems[0].mode, null, '形态漂移不炸解析,由 [parse] 命中计数暴露');
  assert.equal(drifted.unknownFieldCounts[3], undefined, '漂移字段仍是白名单号,不混入未知计数');
  const grouped = encodeSeg([concat(encodeDanmakuElem([[12, 'k']]), tag(9, 3))]); // elem 内混入 group 起始
  assert.throws(() => parseSeg(grouped), /group/, '体形态破损直接抛错 → 编排层终止 partial(§4.5)');
});

// ---- segmentsForDuration / segDiag ----

test('segmentsForDuration:213→1、360→1、361→2、6656→19、0→1(防御)', () => {
  assert.equal(segmentsForDuration(213), 1, '附录 A:BV1GJ411x7h7 单段');
  assert.equal(segmentsForDuration(360), 1, '整除边界:360s 恰一段');
  assert.equal(segmentsForDuration(361), 2, '超出 1 秒即进下一段');
  assert.equal(segmentsForDuration(6656), 19, '附录 A:长视频实测 19 段(seg20 恒 304)');
  assert.equal(segmentsForDuration(0), 1, 'duration<=0 防御按单段(不产生 0/负段数)');
  assert.equal(segmentsForDuration(-5), 1);
  assert.equal(segmentsForDuration(Number.NaN), 1, '非有限数同防');
});

test('segDiag:输出形态对位 replyDiag(status/bytes/bili_status/body);缺省占位 - 与 <空>', () => {
  assert.equal(segDiag({ status: 304, bytes: 0, biliStatusCode: '-304' }),
    'diag status=304 bytes=0 bili_status=-304 body=<空>', '越界哨兵形态(附录 A r2)');
  assert.equal(segDiag({ status: 412, bytes: 123, biliStatusCode: '-412', bodyHeadHex: '1a2b3c' }),
    'diag status=412 bytes=123 bili_status=-412 body=1a2b3c', '风控形态:非 200/304 失败必带');
  assert.equal(segDiag({ status: 500, bytes: 0 }),
    'diag status=500 bytes=0 bili_status=- body=<空>', 'bili-status-code 头缺失 → -');
  assert.equal(segDiag({ status: 503, bytes: 45, biliStatusCode: null, bodyHeadHex: '' }),
    'diag status=503 bytes=45 bili_status=- body=<空>', '空串体样本同 <空>');
});
