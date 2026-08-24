#!/usr/bin/env node
/**
 * SQLite 损坏库抢救重建工具(2026-08-24 生产库 SQLITE_CORRUPT 事故产物,零依赖 node:sqlite)。
 *
 * 适用场景:PRAGMA integrity_check 报 btreeInitPage/database disk image is malformed,
 * 且 sqlite3 CLI 的 `.recover` 对现表零产出(数据全进 lost_and_found 孤儿页)时。
 * 前提:有一份 integrity_check ok 的近期备份(兜底基线)。
 *
 * 策略:
 *   1) 按依赖序搬运(creators→videos→tracks→versions→…),关外键解耦顺序;
 *   2) 可整表读的表全量搬(最新数据优先);
 *   3) 损坏表按 rowid 分段读,失败段二分到单行,坏页行跳过并计数;
 *   4) 跳过行从备份 INSERT OR IGNORE 兜底(旧行胜于丢行);
 *   5) JSON 列降级:坏页边缘截断的 JSON(如 videos.extra,表达式索引 json_extract 写库时
 *      报 malformed JSON)置 NULL 保行——项目 schema 相关配置见 JSON_DEGRADE;
 *   6) 孤儿引用登记(不删行,保留证据;UP 归属可日后重采 upsert creator 修复);
 *   7) sqlite_sequence 按 max(id) 修正;末尾 integrity_check 验收,非 ok 拒绝上线。
 *
 * 可观察性:每表 [rescue] 行打 读出/写入/跳过/降级/丢弃 计数,失败 rowid 清单落盘。
 * 用法:node scripts/sqlite-rescue.mjs <损坏主库> <完好备份> <新库输出路径>
 *   (在 apps/collector-server 外可跑;产物新库替换上线前先 PRAGMA journal_mode=WAL + VACUUM)
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const [srcPath, bakPath, outPath] = process.argv.slice(2);
if (!srcPath || !bakPath || !outPath) {
  console.error('用法: node scripts/sqlite-rescue.mjs <损坏主库> <完好备份> <新库输出>');
  process.exit(2);
}
const log = (...a) => console.error('[rescue]', ...a);

const src = new DatabaseSync(srcPath, { readOnly: true });
const bak = new DatabaseSync(bakPath, { readOnly: true });
const db = new DatabaseSync(outPath);
// node:sqlite 默认外键关闭(与 better-sqlite3 相反),搬运期依赖表可后到;阶段3 做引用检查。

// —— 1. 建库:主库 schema(sqlite_master 可读,结构完整;排除 sqlite_sequence/lost_and_found)
const schemaSqls = src
  .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND sql IS NOT NULL AND name != 'lost_and_found' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.sql);
db.exec(schemaSqls.join(';\n') + ';');
log(`schema 建立完成: ${schemaSqls.length} 个对象`);

const insCache = new Map();
// JSON 列降级配置(项目 schema 相关):行写入失败时把该列置 NULL 重试一次(保行舍 JSON);
// settings.value 为唯一载荷,置 NULL 无意义 → 整行跳过。其它表行失败直接丢并计数。
const JSON_DEGRADE = { videos: ['extra'], settings: null };
function inserter(table, cols, mode = 'OR REPLACE') {
  const key = `${table}:${mode}`;
  let ins = insCache.get(key);
  if (!ins) {
    ins = db.prepare(`INSERT ${mode} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    insCache.set(key, ins);
  }
  return (rows) => {
    if (rows.length === 0) return { written: 0, degraded: 0, dropped: 0 };
    let degraded = 0;
    let dropped = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        try {
          ins.run(...cols.map((c) => r[c] ?? null));
        } catch {
          const dg = JSON_DEGRADE[table];
          if (dg) {
            const fixed = { ...r };
            for (const c of dg) fixed[c] = null;
            try {
              ins.run(...cols.map((c) => fixed[c] ?? null));
              degraded++;
              continue;
            } catch {
              /* 降级仍失败 → 丢行 */
            }
          }
          dropped++;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { written: rows.length - degraded - dropped, degraded, dropped };
  };
}
const colsOf = (conn, table) => conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// —— 2. 分段抢救:rowid 闭区间 [lo,hi],段读失败 → 二分;单行仍读失败 → 跳过(坏页行)。
//    读与写分别 try:读失败=主库坏页(二分细化);写失败=新库问题(向上抛中止)。
function rescueSegmented(table, maxId) {
  const cols = colsOf(src, table);
  const read = src.prepare(`SELECT * FROM ${table} WHERE rowid BETWEEN ? AND ? ORDER BY rowid`);
  const write = inserter(table, cols);
  const skipped = [];
  let ok = 0;
  let degraded = 0;
  let dropped = 0;
  const walk = (lo, hi) => {
    if (lo > hi) return;
    let part;
    try {
      part = read.all(lo, hi);
    } catch {
      if (lo === hi) {
        skipped.push(lo);
        return;
      }
      const mid = (lo + hi) >> 1;
      walk(lo, mid);
      walk(mid + 1, hi);
      return;
    }
    const st = write(part);
    ok += st.written;
    degraded += st.degraded;
    dropped += st.dropped;
  };
  walk(1, maxId);
  log(
    `${table}: 主库读出写入 ${ok} 行,读失败跳过 ${skipped.length} 行,JSON 降级 ${degraded} 行,写入丢弃 ${dropped} 行`,
  );
  if (skipped.length > 0) writeFileSync(`${outPath}-skipped-${table}.txt`, skipped.join('\n') + '\n');
  return { table, cols, skipped };
}

// —— 3. 可整表读的表直接全量(读失败自动回退分段)
function fullCopy(table, maxId) {
  const cols = colsOf(src, table);
  try {
    const rows = src.prepare(`SELECT * FROM ${table}`).all();
    const st = inserter(table, cols, '')(rows);
    log(`${table}: 主库全量 ${st.written} 行(JSON 降级 ${st.degraded},丢弃 ${st.dropped})`);
    return { table, cols, skipped: [] };
  } catch (e) {
    log(`${table}: 全量搬运失败(${String(e.message).slice(0, 80)}),转分段`);
    return rescueSegmented(table, maxId);
  }
}

log('=== 阶段1: 主库搬运(依赖序: creators→videos→其余) ===');
// 依赖序:无依赖的 creators 先行,videos 随后(分段),tracks/versions 依赖前两者,末尾独立表。
// videos/change_log/video_tags 的 max rowid 用实测/基线+增量放宽上界(见各行注释)。
const result = {};
result.creators = fullCopy('creators', 100_000);
result.videos = rescueSegmented('videos', 5200); // 上界按主库实测 max id 放宽,跑前自行核对
for (const t of ['subtitle_tracks', 'subtitle_versions', 'collect_tasks', 'tags', 'categories', 'settings']) result[t] = fullCopy(t, 200_000);
result.change_log = rescueSegmented('change_log', 30_000); // 上界 = 基线行数 + 估计增量
result.video_tags = rescueSegmented('video_tags', 6000);

log('=== 阶段2: 备份兜底(损坏表按 UNIQUE/PK OR IGNORE 补跳过行) ===');
for (const t of ['creators', 'videos', 'change_log', 'video_tags']) {
  const { cols } = result[t];
  try {
    const bakRows = bak.prepare(`SELECT * FROM ${t}`).all();
    const st = inserter(t, cols, 'OR IGNORE')(bakRows);
    const n = db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
    log(`${t}: 备份基线 ${bakRows.length} 行灌入(新写入 ${st.written},降级 ${st.degraded},丢弃 ${st.dropped}),当前合计 ${n} 行`);
  } catch (e) {
    log(`${t}: 备份读失败 ${e.message}`);
  }
}

log('=== 阶段2.5: 孤儿 creator 登记(不修复,输出补救清单) ===');
// creators 坏页跳过 + 备份也没有(备份后的新增 UP)→ 引用它们的 videos 成孤儿。
// owner 只落 creators 表、不冗余存 videos.extra,库内无法反推;
// 补救路径:对孤儿视频重采(collect subtitle 全链路会 upsert creator 重建归属)。
{
  const rows = db
    .prepare(
      `SELECT creator_id, count(*) n, min(source_vid) sample_vid FROM videos
       WHERE creator_id IS NOT NULL AND creator_id NOT IN (SELECT id FROM creators)
       GROUP BY creator_id ORDER BY n DESC`,
    )
    .all();
  if (rows.length === 0) log('无孤儿 creator 引用');
  else {
    const vids = rows.reduce((s, r) => s + r.n, 0);
    log(`孤儿 UP 引用 ${rows.length} 个 creator / ${vids} 个 video(清单 → ${outPath}-orphan-creators.txt)`);
    writeFileSync(
      `${outPath}-orphan-creators.txt`,
      rows.map((r) => `creator_id=${r.creator_id}\tvideos=${r.n}\tsample=${r.sample_vid}`).join('\n') + '\n',
    );
  }
}

log('=== 阶段3: 引用完整性 / sequence / 验收 ===');
for (const [t, col, ref] of [
  ['subtitle_tracks', 'video_id', 'videos'],
  ['subtitle_versions', 'track_id', 'subtitle_tracks'],
  ['video_tags', 'video_id', 'videos'],
  ['videos', 'creator_id', 'creators'],
]) {
  const n = db.prepare(`SELECT count(*) c FROM ${t} WHERE ${col} IS NOT NULL AND ${col} NOT IN (SELECT id FROM ${ref})`).get().c;
  if (n > 0) log(`!! 孤儿引用: ${t}.${col} → ${ref} 共 ${n} 行(目标行未抢救到,保留待查)`);
  else log(`引用完整: ${t}.${col} → ${ref}`);
}
for (const t of ['videos', 'creators', 'subtitle_tracks', 'subtitle_versions', 'change_log', 'categories', 'tags', 'collect_tasks']) {
  const row = db.prepare(`SELECT max(id) m FROM ${t}`).get();
  db.prepare(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES (?, ?)`).run(t, row.m ?? 0);
}
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
for (const t of tables) log(`${t}: ${db.prepare(`SELECT count(*) c FROM ${t}`).get().c} 行`);
const ck = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join('; ');
log(`integrity_check: ${ck}`);
if (ck !== 'ok') {
  log('!! 新库 integrity_check 未通过,禁止上线');
  process.exit(1);
}
log('完成: ' + outPath);
