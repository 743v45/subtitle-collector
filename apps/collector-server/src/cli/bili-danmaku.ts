// B 站弹幕 seg.so protobuf 解析纯函数层(无 IO——网络复用 asr-net.ts,编排在 commands/danmaku.ts,写库走 server ingest)。
// 规格唯一来源:docs/plans/danmaku/PLAN.md
//   §2.3 字段字典(field→列白名单;field1 int64 严禁转 Number——JS 精度漂移实测
//         37828425933127683→…80,唯一键一律 field12 id_str,D3)
//   §2.2 分段机制(360s/段,N=ceil(duration/360);HTTP 304=越界正常终态,非错误)
//   附录 A spike 实录(匿名可用/304 哨兵/163KB 1408 条与 2100 条全样本零解析失败)
//   §4.7 segDiag 诊断串(对位 replyDiag/pageDiag;任何非 200/304 失败必带)
// 解码策略:手写 wire-format 最小解析器(varint + length-delimited + fixed32/64,零新增依赖,D2);
// 白名单外字段号按 wire-type 正确跳过并累计 unknownFieldCounts(协议演化可观察,§2.3)。
// 分层:宿主 CLI 直连 B 站只在弹幕采集链路(server 不直连平台的分工不变,同 bili-comments.ts)。

/** TextDecoder 实例复用(无状态可共享;fatal 默认 false,坏字节替换 U+FFFD 不抛)。 */
const utf8Decoder = new TextDecoder('utf-8');

function utf8Of(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/** §2.3 归一后的入库条目(parse 产物;video_id/cid/page/first_* /batch_id 等列由 ingest/db 层补)。
 * 白名单内字段缺失 → null(B 站正常响应只保证 id_str 必在,其余均可缺省)。 */
export interface DanmakuItem {
  id_str: string; // field12 字符串唯一键(UNIQUE,幂等 upsert 键)
  progress_ms: number | null; // field2 显示时间毫秒;-1=高级弹幕无时间点(原值保留不钳,§2.3)
  mode: number | null; // field3:1-3 滚动 4 底部 5 顶部 6 逆向 7 高级 8 代码 9 BAS
  fontsize: number | null; // field4(常见 25)
  color: number | null; // field5 十进制 RGB(16777215=白色)
  mid_hash: string | null; // field6 发送者 CRC32 hex(B 站侧匿名化,无 mid 明文)
  content: string | null; // field7 弹幕正文(检索主列)
  ctime_s: number | null; // field8 发送时间,B 站原值 unix 秒(_s 后缀防与毫秒混算)
  weight: number | null; // field9 智能屏蔽权重 0-10(低权重被云屏蔽)
  pool: number | null; // field11:0 普通 1 字幕 2 特殊
  action: string | null; // field10 UP 醒目等动作标记(实测样本未见,缺省 null)
}

/** varint 读取:返回 [值(BigInt 防大整型精度丢失), 新位置]。截断/超 10 字节上限抛错(带位置)。 */
export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos + i >= buf.length) {
      throw new Error(`varint 截断: pos=${pos} 偏移 ${i} 越界(缓冲区长度 ${buf.length})`);
    }
    const b = buf[pos + i];
    value |= BigInt(b & 0x7f) << BigInt(7 * i);
    if ((b & 0x80) === 0) return [value, pos + i + 1];
  }
  throw new Error(`varint 超过 10 字节上限: pos=${pos}(协议形态异常)`);
}

/** 通用 wire-format 字段(遍历产物;bytes 为原缓冲区切片,只读)。 */
export interface ProtoField {
  fieldNo: number;
  wireType: number;
  varint?: bigint; // wireType=0 时的值
  bytes?: Uint8Array; // wireType=1(fixed64)/2(length-delimited)/5(fixed32)的原始字节
}

/** protobuf wire-format 通用遍历:wireType 0(varint)/1(64-bit)/2(length-delimited)/5(32-bit)
 * 支持;wireType 3/4(deprecated group)抛错(样本未见,触发即协议变化,§2.3);截断抛错(带位置)。 */
export function parseProtoFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    pos = afterKey;
    const fieldNo = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (fieldNo <= 0) throw new Error(`非法 fieldNo=${fieldNo}(key=${key})pos=${pos - 1}`);
    if (wireType === 0) {
      const [v, after] = readVarint(buf, pos);
      fields.push({ fieldNo, wireType, varint: v });
      pos = after;
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) {
        throw new Error(`fixed64 截断: field=${fieldNo} pos=${pos} 需 8 字节 剩 ${buf.length - pos}`);
      }
      fields.push({ fieldNo, wireType, bytes: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wireType === 2) {
      const [lenV, afterLen] = readVarint(buf, pos);
      pos = afterLen;
      const len = Number(lenV);
      if (pos + len > buf.length) {
        throw new Error(`length-delimited 截断: field=${fieldNo} pos=${pos} 需 ${len} 字节 剩 ${buf.length - pos}`);
      }
      fields.push({ fieldNo, wireType, bytes: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) {
        throw new Error(`fixed32 截断: field=${fieldNo} pos=${pos} 需 4 字节 剩 ${buf.length - pos}`);
      }
      fields.push({ fieldNo, wireType, bytes: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else if (wireType === 3 || wireType === 4) {
      throw new Error(`deprecated group wire-type=${wireType} field=${fieldNo} pos=${pos}(样本未见,触发即协议变化)`);
    } else {
      throw new Error(`未知 wire-type=${wireType} field=${fieldNo} pos=${pos}`);
    }
  }
  return fields;
}

/** int64 二补码还原为 Number(protobuf 负 int64 编码为 10 字节无符号形态,如 -1=0xFFFF…)。
 * 仅用于白名单内小值域字段(progress/mode 等);field1 严禁走此函数入库(D3)。 */
function int64ToNumber(v: bigint): number {
  const signed = v >= 1n << 63n ? v - (1n << 64n) : v;
  return Number(signed);
}

/** §2.3 elem 字段白名单:fieldNo → { 入库键, wire 形态 }。field1(id int64)显式不在表内——
 * 解析时只跳过不转 Number(JS 精度丢失实测 PLAN D3),不进 unknownFieldCounts(非未知字段)。 */
const ELEM_FIELD_MAP: Record<number, { key: keyof DanmakuItem; kind: 'varint' | 'string' }> = {
  2: { key: 'progress_ms', kind: 'varint' },
  3: { key: 'mode', kind: 'varint' },
  4: { key: 'fontsize', kind: 'varint' },
  5: { key: 'color', kind: 'varint' },
  6: { key: 'mid_hash', kind: 'string' },
  7: { key: 'content', kind: 'string' },
  8: { key: 'ctime_s', kind: 'varint' },
  9: { key: 'weight', kind: 'varint' },
  10: { key: 'action', kind: 'string' },
  11: { key: 'pool', kind: 'varint' },
  12: { key: 'id_str', kind: 'string' },
};

/** 白名单值取用:null 兜底(类型收窄辅助,Map 中转值形态为 string | number)。 */
function numOrNull(v: string | number | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

function strOrNull(v: string | number | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

/** 单条 DanmakuElem 解析(白名单映射,last-wins 同 protobuf 标量语义)。
 * 缺 field12(id_str 唯一键)→ null 由调用方丢弃计数(missingIdCount;B 站正常响应不该缺)。
 * 白名单外字段号:parseProtoFields 已按 wireType 正确消费,此处累计 unknownFieldCounts。
 * 白名单内但 wireType 不符(协议形态漂移):静默跳过保持 null,由编排层 [parse] 命中计数暴露。 */
function parseElem(buf: Uint8Array, unknownFieldCounts: Record<number, number>): DanmakuItem | null {
  const out = new Map<keyof DanmakuItem, string | number>();
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNo === 1) continue; // int64 id:严禁转 Number 入库(PLAN D3/附录 A 精度实测)
    const spec = ELEM_FIELD_MAP[f.fieldNo];
    if (!spec) {
      unknownFieldCounts[f.fieldNo] = (unknownFieldCounts[f.fieldNo] ?? 0) + 1;
      continue;
    }
    if (spec.kind === 'varint' && f.varint !== undefined) {
      out.set(spec.key, int64ToNumber(f.varint));
    } else if (spec.kind === 'string' && f.bytes !== undefined) {
      out.set(spec.key, utf8Of(f.bytes));
    }
  }
  const idStr = out.get('id_str');
  if (typeof idStr !== 'string') return null; // 缺唯一键:丢弃(missingIdCount 诊断)
  return {
    id_str: idStr,
    progress_ms: numOrNull(out.get('progress_ms')),
    mode: numOrNull(out.get('mode')),
    fontsize: numOrNull(out.get('fontsize')),
    color: numOrNull(out.get('color')),
    mid_hash: strOrNull(out.get('mid_hash')),
    content: strOrNull(out.get('content')),
    ctime_s: numOrNull(out.get('ctime_s')),
    weight: numOrNull(out.get('weight')),
    pool: numOrNull(out.get('pool')),
    action: strOrNull(out.get('action')),
  };
}

/** parseSeg 产物:elems 入库条目;两个计数 map 供编排层 [parse] 日志(§4.7 命中计数 + 未识别分布)。 */
export interface ParseSegResult {
  elems: DanmakuItem[];
  /** 顶层各字段号出现次数(field1 计 elem 原始数,含缺 id 被丢弃的;field4/5 分段配置类各一) */
  topFieldCounts: Record<number, number>;
  /** 白名单外字段号 → 出现次数(协议演化可观察,§2.3) */
  unknownFieldCounts: Record<number, number>;
  /** 缺 field12 被丢弃的 elem 数(B 站正常响应不该缺,非 0 即告警信号) */
  missingIdCount: number;
}

/** seg.so 响应体解析:顶层 field1 = repeated DanmakuElem(§2.3);field4/5 分段配置类只计数不入库。
 * 空 elems 正常(空段);不变量:elems.length + missingIdCount = topFieldCounts[1](全是 wireType 2 时)。
 * 响应体形态破损(group/截断)直接抛错——编排层捕获后终止 partial + body hex 头日志(§4.5)。 */
export function parseSeg(buf: Uint8Array): ParseSegResult {
  const topFieldCounts: Record<number, number> = {};
  const unknownFieldCounts: Record<number, number> = {};
  const elems: DanmakuItem[] = [];
  let missingIdCount = 0;
  for (const f of parseProtoFields(buf)) {
    topFieldCounts[f.fieldNo] = (topFieldCounts[f.fieldNo] ?? 0) + 1;
    if (f.fieldNo === 1 && f.wireType === 2 && f.bytes !== undefined) {
      const item = parseElem(f.bytes, unknownFieldCounts);
      if (item === null) missingIdCount++;
      else elems.push(item);
    }
  }
  return { elems, topFieldCounts, unknownFieldCounts, missingIdCount };
}

/** 段数计算(§2.2):N = ceil(duration/360);duration <= 0 或非有限数返回 1(防御,按单段跑)。 */
export function segmentsForDuration(durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return 1;
  return Math.ceil(durationS / 360);
}

/** §4.7 segDiag 诊断串(对位 replyDiag/pageDiag):任何非 200/304 失败必带。
 * 形如 `diag status=304 bytes=0 bili_status=-304 body=<空>`;bili-status-code 头缺失 → '-',
 * 体样本缺失/空 → '<空>'。bodyHeadHex 由调用方取响应体前 32 字节 hex。 */
export function segDiag(info: {
  status: number;
  bytes: number;
  biliStatusCode?: string | null;
  bodyHeadHex?: string;
}): string {
  const body = info.bodyHeadHex !== undefined && info.bodyHeadHex !== '' ? info.bodyHeadHex : '<空>';
  return `diag status=${info.status} bytes=${info.bytes} bili_status=${info.biliStatusCode ?? '-'} body=${body}`;
}
