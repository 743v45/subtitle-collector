#!/usr/bin/env node
// 回填 no-subtitle 系统标：从 collect_tasks 提取「确认无字幕」历史（status=succeeded 且
// result 含 reason:"no_subtitle"），对当前仍无字幕轨的视频批量打 no-subtitle system 档标。
// 场景：2026-08-23 自动打标上线前的存量（功能上线后采集链路自动打，无需再跑本脚本）。
// 语义对齐 db/tags.ts markNoSubtitle：标只打在「确认过无字幕且至今仍无轨」的视频上；
// 已有轨的跳过（重采到了轨，标本就不该在）。
//
// 用法：node scripts/backfill-no-subtitle-tags.mjs [--db <sqlite>] [--dry-run] [--batch <n>]
//   --db    生产库绝对路径（默认 <repo>/data/bilibili-collector.db）；须与 server 实连库一致
//           （打标走 server HTTP /api/tags/apply，库不一致会打到别的库上）
//   --dry-run 只列待打标清单不写库
// 环境：COLLECTOR_SERVER / COLLECTOR_TOKEN（打标走 server，对齐 tags apply 既定模式）。
// 日志纪律（§9）：[scan]/[filter]/[apply] 分步 stderr 计数，每步可独立定位。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// node:sqlite（Node 24 内置）：scripts/ 在 pnpm 隔离下引不到 apps 的 better-sqlite3，零依赖直读
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes('--dry-run');
const REPO = new URL('..', import.meta.url).pathname;
const DB_PATH = flag('--db') ?? `${REPO}data/bilibili-collector.db`;
const BATCH = Number(flag('--batch') ?? 200);
const CLI_DIR = new URL('../apps/collector-server/', import.meta.url).pathname;

const log = (tag, msg) => console.error(`[${tag}] ${msg}`);

// ── scan：collect_tasks 里确认过无字幕的 (source, source_vid) 去重 ──
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare(
  `SELECT DISTINCT source, source_vid FROM collect_tasks
   WHERE status = 'succeeded' AND result LIKE '%"reason":"no_subtitle"%'`,
).all();
log('scan', `collect_tasks 确认无字幕记录（去重）: ${rows.length} 条`);

// ── filter：仍无字幕轨且不在库外（视频行存在）→ 待打标；已有轨 → 跳过 ──
const stmt = db.prepare(
  `SELECT (SELECT COUNT(*) FROM subtitle_tracks t WHERE t.video_id = v.id) AS tracks
   FROM videos v WHERE v.source = ? AND v.source_vid = ?`,
);
const toTag = [];
let alreadyHasTracks = 0, notInDb = 0;
for (const r of rows) {
  const v = stmt.get(r.source, r.source_vid);
  if (!v) { notInDb++; continue; }          // 任务行在但视频未入库（异常态，不打）
  if (v.tracks > 0) { alreadyHasTracks++; continue; } // 后续重采到了轨，标不该在
  toTag.push(r);
}
log('filter', `待打标 ${toTag.length} | 已有轨跳过 ${alreadyHasTracks} | 视频不在库 ${notInDb}`);
db.close();
if (toTag.length === 0) { console.error('[done] 无待打标项'); process.exit(0); }

// ── apply：分批走 CLI tags apply --source system（写走 server，对齐既定模式）──
if (DRY) {
  for (const r of toTag) console.log(`${r.source}\t${r.source_vid}`);
  console.error('[done] dry-run 未写库');
  process.exit(0);
}
let inserted = 0, missing = 0;
for (let i = 0; i < toTag.length; i += BATCH) {
  const chunk = toTag.slice(i, i + BATCH);
  const out = execFileSync('npx', ['tsx', 'src/cli/main.ts', 'tags', 'apply',
    ...chunk.filter((r) => r.source === 'bilibili').map((r) => r.source_vid),
    '--names', 'no-subtitle', '--source', 'system', '--format', 'json'],
  { cwd: CLI_DIR, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  const j = JSON.parse(out.slice(out.indexOf('{')));
  inserted += j.inserted ?? 0;
  missing += (j.missing ?? []).length;
  log('apply', `批次 ${Math.floor(i / BATCH) + 1}/${Math.ceil(toTag.length / BATCH)}：inserted=${j.inserted} missing=${(j.missing ?? []).length}`);
}
console.error(`[done] 打标完成：inserted=${inserted} missing=${missing}（非 bilibili 源 ${toTag.filter((r) => r.source !== 'bilibili').length} 条暂无 CLI 通道，见日志）`);
