// bundle-danmaku.ts 单测（C6 弹幕导出，PLAN docs/plans/danmaku/PLAN.md §6）：
// danmakuMetaByVideoIds 批量统计（多视频混合不串扰 / 0 弹幕视频不入 Map / 多 P 峰值分钟不合并 /
// last_collected_at / 空入参）+ renderDanmakuMd 正文渲染（头部统计行 / 单 P 桶小节 / 多 P 分组与
// 桶前缀 / mode 标注 / MM:SS 格式 / 无时间点小节 / 空 P 不出小节）。
// 夹具：渲染测试用手工 DanmakuRecord[]（纯函数不触库）；db 测试用 :memory: + migrate + upsertDanmaku。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 批量统计/峰值口径/md 渲染全形态/buildBundle 集成/模板增补 | 待首次 pnpm qa | 2026-10-07 首写 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations } from '../db/migrate.js';
import type { DanmakuRecord, DanmakuUpsertRow } from '../db/danmaku.js';
import { upsertDanmaku } from '../db/danmaku.js';
import { danmakuMetaByVideoIds, renderDanmakuMd } from './bundle-danmaku.js';
import { buildBundle, ANALYZE_MD } from './bundle.js';

// ── db 夹具 ──

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  return db;
}

function seedVideo(db: Database.Database, sourceVid: string, title = '测试视频'): number {
  return Number(db.prepare(
    "INSERT INTO videos (source, source_vid, title, first_seen_at, updated_at) VALUES ('bilibili', ?, ?, 1, 1)",
  ).run(sourceVid, title).lastInsertRowid);
}

let seq = 0;
/** 构造归一化弹幕行：缺省为普通滚动弹幕形态（mode=1、单 P cid=100、非空观测列） */
function row(over: Partial<DanmakuUpsertRow> = {}): DanmakuUpsertRow {
  seq++;
  return {
    id_str: over.id_str ?? `d${seq}`,
    cid: 100,
    page: 1,
    progress_ms: 1000 * seq,
    mode: 1,
    fontsize: 25,
    color: 16777215,
    mid_hash: 'abc',
    content: `弹幕${seq}`,
    ctime_s: 1600000000 + seq,
    weight: 6,
    pool: 0,
    action: null,
    ...over,
  };
}

const AT = 1790985600000;  // 2026-10-03 00:00:00 UTC（毫秒），头部统计行采集日用

/** db 手插弹幕（走 upsertDanmaku 保真幂等语义），last_seen/batch 直接给值 */
function seedDanmaku(
  db: Database.Database, videoId: number, rows: DanmakuUpsertRow[], lastSeenAt = AT,
): void {
  upsertDanmaku(db, videoId, rows, { fetchedAt: lastSeenAt, batchId: 'b1' });
}

// ── 渲染夹具（手工 DanmakuRecord[]，纯函数不触库）──

let rid = 0;
/** 构造 DanmakuRecord（只填渲染消费的列，其余给合法缺省值；base+over 双 spread 规避 TS2783 显式双写） */
function rec(over: Partial<DanmakuRecord> & Pick<DanmakuRecord, 'cid' | 'progress_ms' | 'content'>): DanmakuRecord {
  rid++;
  const base: DanmakuRecord = {
    id: rid, id_str: `r${rid}`, video_id: 1,
    cid: over.cid, page: over.page ?? 1,
    progress_ms: over.progress_ms, mode: over.mode ?? 1,
    fontsize: 25, color: 16777215, mid_hash: 'abc',
    content: over.content, ctime_s: 1600000000, weight: 6, pool: 0, action: null,
    first_seen_at: AT, last_seen_at: AT, batch_id: null,
  };
  return { ...base, ...over };
}

const V = { title: '霸凌の意志', source_vid: 'BV1KmHb6JEFS' };
const META = { rows: 4, pages: 1, peak_minute_rows: 3, last_collected_at: AT };

// ── danmakuMetaByVideoIds：批量统计（§6.2，防 N+1）──

test('批量统计:多视频混合(有弹幕/无弹幕)只出有弹幕视频,rows/pages/last_collected_at 不串扰', () => {
  const db = freshDb();
  try {
    const v1 = seedVideo(db, 'BV1');
    seedVideo(db, 'BV2'); // 无弹幕视频：不得出现在返回 Map
    const v3 = seedVideo(db, 'BV3');
    // V1：2 个 P；last_collected_at 取各行 MAX(last_seen_at)（两批 fetchedAt 不同）
    // 峰值：P1 第 0 分钟 2 条（10s/20s），P2 第 0 分钟 1 条 → max=2
    seedDanmaku(db, v1, [
      row({ cid: 100, page: 1, progress_ms: 10_000 }),
      row({ cid: 100, page: 1, progress_ms: 20_000 }),
    ], 1000);
    seedDanmaku(db, v1, [row({ cid: 200, page: 2, progress_ms: 30_000 })], 1500);
    seedDanmaku(db, v3, [row({ cid: 300, page: 1, progress_ms: 5_000 })], 777);
    const meta = danmakuMetaByVideoIds(db, [v1, 99999, v3]); // 99999=不存在 id（无弹幕形态）
    assert.equal(meta.size, 2, '无弹幕的 BV2 不得入 Map（0 弹幕省略字段的前提）');
    assert.deepEqual(meta.get(v1), { rows: 3, pages: 2, peak_minute_rows: 2, last_collected_at: 1500 });
    assert.deepEqual(meta.get(v3), { rows: 1, pages: 1, peak_minute_rows: 1, last_collected_at: 777 });
  } finally { db.close(); }
});

test('批量统计:空 id 列表返回空 Map(IN 子句不组装)', () => {
  const db = freshDb();
  try {
    assert.equal(danmakuMetaByVideoIds(db, []).size, 0);
  } finally { db.close(); }
});

test('峰值分钟:多 P 同分钟桶不合并((video,cid,桶) 计数取 max),负值/NULL 不计,并列取先见桶', () => {
  const db = freshDb();
  try {
    const v = seedVideo(db, 'BVP');
    // P1 第 0 分钟 3 条；P2 第 0 分钟 2 条 → 峰值取 max(3,2)=3 而非合并后的 5（多 P 同分钟不合并）
    seedDanmaku(db, v, [
      row({ cid: 100, page: 1, progress_ms: 10_000 }),
      row({ cid: 100, page: 1, progress_ms: 20_000 }),
      row({ cid: 100, page: 1, progress_ms: 30_000 }),
    ]);
    seedDanmaku(db, v, [
      row({ cid: 200, page: 2, progress_ms: 15_000 }),
      row({ cid: 200, page: 2, progress_ms: 25_000 }),
    ]);
    // 第 2 分钟 1 条（跨桶不并入峰值）；-1（高级弹幕）与 NULL（无时间点）不计桶
    seedDanmaku(db, v, [
      row({ cid: 100, page: 1, progress_ms: 130_000 }),
      row({ cid: 100, page: 1, progress_ms: -1, mode: 7 }),
      row({ cid: 100, page: 1, progress_ms: null }),
    ]);
    const meta = danmakuMetaByVideoIds(db, [v]);
    assert.equal(meta.get(v)!.peak_minute_rows, 3, '多 P 同分钟桶各计各的，峰值=3 不是 5');
    assert.equal(meta.get(v)!.rows, 8, '总条数含负值/NULL 行（rows 全量口径）');
  } finally { db.close(); }
});

test('峰值分钟:全视频无正点行(全负值/NULL)时 peak_minute_rows 保持 0,行仍入 Map', () => {
  const db = freshDb();
  try {
    const v = seedVideo(db, 'BVN');
    seedDanmaku(db, v, [
      row({ cid: 100, page: 1, progress_ms: -1, mode: 7 }),
      row({ cid: 100, page: 1, progress_ms: null }),
    ]);
    const meta = danmakuMetaByVideoIds(db, [v]);
    assert.equal(meta.get(v)!.rows, 2, '有行 → 入 Map（入 Map 条件是 rows>0）');
    assert.equal(meta.get(v)!.peak_minute_rows, 0, '无正点行 → 峰值 0（渲染侧峰值段随之省略）');
  } finally { db.close(); }
});

// ── renderDanmakuMd：头部统计行（§6.1 样例逐字节对齐）──

test('md 头部:标题/引用统计行(采集日·总数·分 P 数·峰值分钟)/说明行,末尾换行', () => {
  const tl = [
    rec({ cid: 100, progress_ms: 1_000, content: '前排' }),
    rec({ cid: 100, progress_ms: 3_000, content: '经典' }),
    rec({ cid: 100, progress_ms: 61_000, content: '第二分钟' }),
  ];
  const md = renderDanmakuMd(V, { ...META, rows: 3, peak_minute_rows: 2 }, tl);
  const lines = md.split('\n');
  assert.equal(lines[0], '# 弹幕 · BV1KmHb6JEFS');
  assert.equal(lines[1], '> 采集 2026-10-03 · 共 3 条 · 1 个分 P · 峰值分钟 00:00-01:00(2 条)');
  assert.equal(lines[2], '> 按 progress 时间升序;`[M]`=mode(1 滚动 5 顶部 4 底部);时间轴为弹幕显示时间。');
  assert.equal(lines[3], '');
  assert.ok(md.endsWith('\n'), '文件以单个换行收尾');
});

test('md 头部:全视频无正点行时峰值段省略(统计行不带「峰值分钟」)', () => {
  const tl = [rec({ cid: 100, progress_ms: -1, mode: 7, content: '高级' })];
  const lines = renderDanmakuMd(V, { ...META, rows: 1, peak_minute_rows: 0 }, tl).split('\n');
  assert.equal(lines[1], '> 采集 2026-10-03 · 共 1 条 · 1 个分 P', '无正点行 → 峰值段整个省略');
});

// ── renderDanmakuMd：单 P 桶小节 / 时间格式 / mode 标注 ──

test('单 P:60s 桶分小节,桶内按 progress 升序,61s→01:01,mode 1 不加注', () => {
  const tl = [
    rec({ cid: 100, progress_ms: 61_000, content: '后插的' }),
    rec({ cid: 100, progress_ms: 1_000, content: '前排' }),
    rec({ cid: 100, progress_ms: 3_000, content: '经典' }),
    rec({ cid: 100, progress_ms: 125_000, content: '第三分钟' }),
  ];
  const md = renderDanmakuMd(V, { ...META, rows: 4, peak_minute_rows: 2 }, tl);
  const lines = md.split('\n');
  assert.equal(lines[4], '## 00:00-01:00(2 条)', '单 P 直接桶小节，无 P 分组层');
  assert.equal(lines[5], '[00:01] 前排', '桶内按 progress 升序（与入参顺序无关）');
  assert.equal(lines[6], '[00:03] 经典');
  assert.equal(lines[8], '## 01:00-02:00(1 条)');
  assert.equal(lines[9], '[01:01] 后插的', '61s → 01:01');
  assert.equal(lines[11], '## 02:00-03:00(1 条)');
  assert.equal(lines[12], '[02:05] 第三分钟');
});

test('mode 标注:mode 1 滚动不加注;4 底部/5 顶部等 mode>1 尾注 [M<mode>]', () => {
  const tl = [
    rec({ cid: 100, progress_ms: 1_000, content: '滚动' , mode: 1 }),
    rec({ cid: 100, progress_ms: 2_000, content: '底部' , mode: 4 }),
    rec({ cid: 100, progress_ms: 3_000, content: '顶部' , mode: 5 }),
    rec({ cid: 100, progress_ms: 4_000, content: '无mode', mode: null }),
  ];
  const lines = renderDanmakuMd(V, META, tl).split('\n');
  assert.equal(lines[5], '[00:01] 滚动', 'mode 1 默认形态不加注');
  assert.equal(lines[6], '[00:02] 底部 [M4]');
  assert.equal(lines[7], '[00:03] 顶部 [M5]');
  assert.equal(lines[8], '[00:04] 无mode', 'mode NULL 不加注');
});

// ── renderDanmakuMd：多 P 分组与桶前缀 / 无时间点 / 空 P ──

test('多 P:每 P 出「## P<N> cid=<cid>」分组,桶小节带 P 前缀防跨 P 重名', () => {
  const tl = [
    rec({ cid: 200, page: 2, progress_ms: 61_000, content: 'P2第二分钟' }),
    rec({ cid: 100, page: 1, progress_ms: 1_000, content: 'P1首分钟' }),
    rec({ cid: 200, page: 2, progress_ms: 2_000, content: 'P2首分钟' }),
  ];
  const md = renderDanmakuMd(V, { ...META, rows: 3, pages: 2 }, tl);
  const lines = md.split('\n');
  assert.equal(lines[4], '## P1 cid=100', 'P 分组按 cid 升序（100 在 200 前）');
  assert.equal(lines[6], '## P1 00:00-01:00(1 条)', '多 P 时桶小节带 P 前缀');
  assert.equal(lines[9], '## P2 cid=200');
  assert.equal(lines[11], '## P2 00:00-01:00(1 条)');
  assert.equal(lines[14], '## P2 01:00-02:00(1 条)');
  assert.ok(md.indexOf('[00:01] P1首分钟') < md.indexOf('[00:02] P2首分钟'), '桶内仍是 progress 升序');
});

test('无时间点行(负值/NULL)归 P 末尾「无时间点」小节,不进分钟桶;单 P 时小节不带 P 前缀', () => {
  const tl = [
    rec({ cid: 100, progress_ms: 1_000, content: '首条' }),
    rec({ cid: 100, progress_ms: -1, mode: 7, content: '高级弹幕' }),
    rec({ cid: 100, progress_ms: null, content: '无时间' }),
  ];
  const md = renderDanmakuMd(V, { ...META, rows: 3, peak_minute_rows: 1 }, tl);
  const lines = md.split('\n');
  assert.equal(lines[4], '## 00:00-01:00(1 条)');
  assert.equal(lines[7], '## 无时间点(2 条)', '负值与 NULL 同归无时间点小节（保真原池不丢行）');
  assert.equal(lines[8], '- 高级弹幕 [M7]', '无时间点行列表形态，mode 标注保留');
  assert.equal(lines[9], '- 无时间', 'NULL mode 无标注');
});

test('空 P(rows=0)不出 P 分组也不出桶小节;只有存在行时才有小节', () => {
  // 渲染层面验证：timeline 只含 P1 行 → 输出不含任何 P2/cid=200 痕迹
  const tl = [rec({ cid: 100, page: 1, progress_ms: 1_000, content: '仅P1' })];
  const md = renderDanmakuMd(V, { ...META, pages: 2, rows: 1 }, tl);
  assert.ok(!md.includes('cid=200'), '无行 cid 不出分组（空 P 由 db 层 GROUP BY 天然过滤）');
  assert.equal(md.split('\n').filter((l) => l.startsWith('## ')).length, 1, '仅 1 个桶小节');
});

// ── buildBundle 集成：manifest danmaku 字段 + danmaku/<BV>.md 文件 ──

test('buildBundle:有弹幕视频出 danmaku/<BV>.md + manifest danmaku 摘要;0 弹幕视频省略字段不出文件', () => {
  const db = freshDb();
  try {
    const v1 = seedVideo(db, 'BV1', '标题A');
    seedVideo(db, 'BV2', '标题B');
    seedDanmaku(db, v1, [
      row({ id_str: 'd2', cid: 100, page: 1, progress_ms: 61_000, content: '第二分钟' }),
      row({ id_str: 'd1', cid: 100, page: 1, progress_ms: 1_000, content: '前排' }),
      row({ id_str: 'd3', cid: 100, page: 1, progress_ms: 2_000, content: '经典', mode: 5 }),
    ]);
    const r = buildBundle(db, { filters: {}, limit: 10, now: 0 });
    const bv1 = r.manifest.videos.find((x) => x.source_vid === 'BV1')!;
    const bv2 = r.manifest.videos.find((x) => x.source_vid === 'BV2')!;
    assert.equal('danmaku' in bv2, false, '0 弹幕视频省略 danmaku 字段（view/comments 哲学）');
    const dm = bv1.danmaku!;
    assert.equal(dm.file, 'danmaku/BV1.md');
    assert.equal(dm.rows, 3);
    assert.equal(dm.pages, 1);
    assert.equal(dm.peak_minute_rows, 2);
    assert.equal(dm.last_collected_at, AT);
    const md = r.files.find((f) => f.path === 'danmaku/BV1.md')!.content;
    assert.ok(md.startsWith('# 弹幕 · BV1\n'));
    assert.ok(md.includes('[00:01] 前排'), '时间轴行在正文');
    assert.ok(md.includes('[01:01] 第二分钟'));
    assert.ok(md.includes('## 00:00-01:00(2 条)'), '桶小节计数');
    // manifest.json 序列化含 danmaku 字段
    const manifestFile = JSON.parse(r.files.find((f) => f.path === 'manifest.json')!.content);
    assert.equal(manifestFile.videos.find((x: { source_vid: string }) => x.source_vid === 'BV1').danmaku.file, 'danmaku/BV1.md');
  } finally { db.close(); }
});

// ── ANALYZE.md 模板增补（PLAN §6.3）──

test('ANALYZE_MD:盲区第五类「弹幕盲区」+ 弹幕时间轴热点可选段 + 弹幕出处格式', () => {
  for (const anchor of ['覆盖盲区五类', '弹幕盲区', '未采弹幕', '弹幕时间轴热点', '峰值分钟', '观众情绪触发点',
    'danmaku/<BV号>.md']) {
    assert.ok(ANALYZE_MD.includes(anchor), `ANALYZE_MD 缺弹幕增补锚点: ${anchor}`);
  }
  // 观点汇总模板内含弹幕热点段与出处格式示例（单一事实源在模板正文）
  assert.ok(ANALYZE_MD.includes('> 来源: 视频A 弹幕 @03:05'), '缺弹幕出处格式示例行');
  assert.ok(ANALYZE_MD.includes('弹幕与评论互补：评论=观点论述，弹幕=时间轴即时反应'), '缺弹幕与评论互补表述');
});
