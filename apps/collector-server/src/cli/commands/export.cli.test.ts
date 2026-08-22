// export.ts commander 装配层测试：子进程跑真 CLI，覆盖 subtitle/videos/bundle 三 action 成功 +
// 各 parse 校验（sub-format/version/track/sort/since/limit）+ NOT_FOUND 各分支 + DB_UNREADABLE +
// -o 文件写盘。附带覆盖 main.ts 的 catch 分支（字幕 payload 结构损坏 → convertSubtitle 抛错穿透 parseAsync）。
// 纯函数（resolveSubtitle/serializeVideosResult）见 export.test.ts；bundle 构建见 bundle.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | subtitle 4 格式 + 轨/版本选择 + NOT_FOUND ×4 + -o；videos stdout/-o/table 拒绝；bundle 成功/非空目录 ARGS | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
const MAIN_TS = join(HERE, '..', 'main.ts');
const APP_ROOT = resolve(HERE, '../../..');

function cli(args_: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args_], { cwd: APP_ROOT }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

const args = (dbPath: string, rest: string[]): string[] =>
  ['--db', dbPath, '--server', 'http://127.0.0.1:1', '--token', 't', ...rest];

// 样本库：BV1 双轨（zh CC 默认 + en），正文两段；BV8 有轨无版本；BV4 无轨。
function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-export-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const ingest = (sv: string, title: string, tracks: Array<{ lan?: string; track_type?: number; versions: Array<{ origin: string; payload: unknown }> }>) =>
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sv, title, creator: { source_uid: '1', name: 'UP' }, extra: { tid: 17, tname: '单机游戏' }, duration: 60, published_at: 1 },
      tracks,
    });
  ingest('BV1', '标题A', [
    { lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: '中文正文一' }, { from: 2, to: 4, content: '中文正文二' }] } }] },
    { lan: 'en', track_type: 1, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: 'english line' }] } }] },
  ]);
  ingest('BV8', '空轨', [{ lan: 'xx', track_type: 1, versions: [] }]);
  ingest('BV4', '无轨', []);
  return { db, dbPath: join(dir, 'test.db'), dir };
}

// ── export subtitle ──

test('export subtitle：默认 srt 纯文本写 stdout（不走 JSON 包装），退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1']));
    assert.equal(r.code, 0);
    assert.match(r.out, /^1\n00:00:00,000 --> 00:00:02,000\n中文正文一/);
    assert.doesNotMatch(r.out, /^\{/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle --sub-format vtt/txt/json', async () => {
  const { dir, dbPath } = setup();
  try {
    const vtt = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '--sub-format', 'vtt']));
    assert.match(vtt.out, /^WEBVTT/);
    const txt = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '--sub-format', 'txt']));
    assert.equal(txt.out, '中文正文一\n中文正文二\n');
    const json = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '--sub-format', 'json']));
    assert.ok(Array.isArray(JSON.parse(json.out).body), 'json 格式经 emitResult 包装 payload');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle --track en：取指定轨', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '--track', 'en', '--sub-format', 'txt']));
    assert.equal(r.code, 0);
    assert.equal(r.out, 'english line\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle --track 不存在的轨 → NOT_FOUND 退 5', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '--track', 'ja']));
    assert.equal(r.code, 5);
    assert.match(r.err, /track not found: lan=ja/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle：视频不存在 → NOT_FOUND；无轨视频 → NOT_FOUND；轨无版本 → NOT_FOUND', async () => {
  const { dir, dbPath } = setup();
  try {
    const r1 = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'NOPE']));
    assert.equal(r1.code, 5);
    assert.match(r1.err, /video not found: bilibili\/NOPE/);
    const r2 = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV4']));
    assert.equal(r2.code, 5);
    assert.match(r2.err, /无字幕轨/);
    const r3 = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV8']));
    assert.equal(r3.code, 5);
    assert.match(r3.err, /无字幕版本/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle --version <id>：疑似生产 bug——program 级 --version 吞掉子命令同名 option', async () => {
  const { db, dir, dbPath } = setup();
  try {
    // ⚠️ 实测（2026-08-22）：export subtitle 定义了 .option('--version <id>')，但 program.version()
    // 注册的全局 -v/--version 优先接管——传任意 --version 值都直接打印版本号退 0，
    // resolveSubtitle 的显式版本分支（versionId）经真实 CLI 不可达（纯函数分支由 export.test.ts 覆盖）。
    // 此处固化当前行为防静默漂移；修复后应改为断言取到指定版本正文。
    const r = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '--version', '1', '--sub-format', 'txt']));
    assert.equal(r.code, 0);
    assert.equal(r.out, '0.1.0\n', '当前行为：全局 --version 拦截（bug，见测试报告）');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle --sub-format bogus → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '--sub-format', 'bogus']));
    assert.equal(r.code, 2);
    assert.match(r.err, /非法 --sub-format: bogus/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle -o <file>：写文件 + 结构化回执，退 0', async () => {
  const { db, dir, dbPath } = setup();
  const outFile = join(dir, 'out.srt');
  try {
    const r = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1', '-o', outFile]));
    assert.equal(r.code, 0);
    const receipt = JSON.parse(r.out);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.path, outFile);
    assert.ok(receipt.bytes > 0);
    assert.equal(receipt.format, 'srt');
    assert.match(readFileSync(outFile, 'utf-8'), /中文正文一/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(join(tmpdir(), 'cli-export-no-such.db'), ['export', 'subtitle', 'bilibili', 'BV1']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

test('export subtitle：payload 结构损坏 → convertSubtitle 抛错进 main catch → RUNTIME 退 1 + stderr 一行', async () => {
  const { db, dir, dbPath } = setup();
  try {
    // 损坏 payload：body 非数组（getVersionPayload 能 parse，convertSubtitle 校验抛）
    db.prepare('UPDATE subtitle_versions SET payload = ?').run('{"body": 42}');
    const r = await cli(args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /\[collector-cli\] RUNTIME: 字幕 payload 结构不符/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('export subtitle：payload 损坏 + -q → stderr 静默（main catch 的 quiet 分支），退 1', async () => {
  const { db, dir, dbPath } = setup();
  try {
    db.prepare('UPDATE subtitle_versions SET payload = ?').run('{"body": 42}');
    const r = await cli(['-q', ...args(dbPath, ['export', 'subtitle', 'bilibili', 'BV1'])]);
    assert.equal(r.code, 1);
    assert.equal(r.err, '');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── export videos ──

test('export videos：stdout json {total,page,size,items}，退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['export', 'videos', '--has-subtitle']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.total, 1);
    assert.equal(data.items[0].source_vid, 'BV1');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('export videos --format csv / ndjson：复用全局 --format', async () => {
  const { dir, dbPath } = setup();
  try {
    const csv = await cli(['--format', 'csv', ...args(dbPath, ['export', 'videos', '--has-subtitle'])]);
    // emitResult csv 走对象键序（id 开头）；固定列序的 CSV 只在 -o 序列化（serializeVideosResult）
    assert.match(csv.out, /^id,source,source_vid,/);
    assert.match(csv.out, /BV1/);
    const nd = await cli(['--format', 'ndjson', ...args(dbPath, ['export', 'videos', '--has-subtitle'])]);
    assert.equal(nd.out.split('\n').filter(Boolean).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export videos --format table → ARGS 退 2（与导出语义冲突）', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(['--format', 'table', ...args(dbPath, ['export', 'videos'])]);
    assert.equal(r.code, 2);
    assert.match(r.err, /export videos 不支持 table 格式/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export videos -o <file>：写文件（固定列序 CSV）+ JSON 回执，退 0', async () => {
  const { db, dir, dbPath } = setup();
  const outFile = join(dir, 'videos.csv');
  try {
    // -o 时序列化格式取全局 --format；回执同样经 emitResult(ctx.format)——用 csv 序列化 + json 回执需分两次跑。
    // 这里跑两态：csv 序列化（回执也 csv）与默认 json（回执 json + 文件 pretty JSON）。
    const rCsv = await cli(['--format', 'csv', ...args(dbPath, ['export', 'videos', '-o', outFile])]);
    assert.equal(rCsv.code, 0);
    assert.match(readFileSync(outFile, 'utf-8'), /^id,source,source_vid,title,/); // serializeVideosResult 固定列序
    const rJson = await cli(args(dbPath, ['export', 'videos', '-o', join(dir, 'videos.json')]));
    assert.equal(rJson.code, 0);
    const receipt = JSON.parse(rJson.out);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.format, 'json');
    assert.equal(receipt.total, 3);
    assert.match(readFileSync(join(dir, 'videos.json'), 'utf-8'), /标题A/);
    // ndjson 序列化分支：每行一个 item JSON
    const rNd = await cli(['--format', 'ndjson', ...args(dbPath, ['export', 'videos', '-o', join(dir, 'videos.ndjson')])]);
    assert.equal(rNd.code, 0);
    const ndLines = readFileSync(join(dir, 'videos.ndjson'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(ndLines.length, 3);
    assert.deepEqual(Object.keys(JSON.parse(ndLines[0]!)).slice(0, 3), ['id', 'source', 'source_vid']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('export videos：--tid/--since/--sort 非法 → ARGS；DB 缺失 → DB_UNREADABLE', async () => {
  const { dir, dbPath } = setup();
  try {
    assert.equal((await cli(args(dbPath, ['export', 'videos', '--tid', 'abc']))).code, 2);
    assert.equal((await cli(args(dbPath, ['export', 'videos', '--since', 'bad']))).code, 2);
    assert.equal((await cli(args(dbPath, ['export', 'videos', '--sort', 'bogus']))).code, 2);
    const r = await cli(args(join(tmpdir(), 'cli-export-no-such.db'), ['export', 'videos']));
    assert.equal(r.code, 4);
    assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── export bundle ──

test('export bundle --out <dir>：写 manifest/videos/ANALYZE.md + 回执，退 0', async () => {
  const { db, dir, dbPath } = setup();
  const outDir = join(dir, 'bundle');
  try {
    const r = await cli(args(dbPath, ['export', 'bundle', '--out', outDir, '--has-subtitle']));
    assert.equal(r.code, 0);
    const receipt = JSON.parse(r.out);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.exported, 1);
    assert.equal(receipt.with_subtitle, 1);
    assert.equal(receipt.without_subtitle, 0);
    assert.ok(existsSync(join(outDir, 'manifest.json')));
    assert.ok(existsSync(join(outDir, 'ANALYZE.md')));
    const files = readFileSync(join(outDir, 'manifest.json'), 'utf-8');
    assert.match(files, /标题A/);
    const txt = readFileSync(join(outDir, 'videos', 'BV1.txt'), 'utf-8'); // bundle 文件名 = videos/<source_vid>.txt
    assert.match(txt, /中文正文一/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('export bundle：--out 已存在非空且无 --force → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  const outDir = mkdtempSync(join(tmpdir(), 'cli-bundle-nonempty-'));
  writeFileSync(join(outDir, 'keep.txt'), 'x');
  try {
    const r = await cli(args(dbPath, ['export', 'bundle', '--out', outDir]));
    assert.equal(r.code, 2);
    assert.match(r.err, /已存在且非空/);
    // --force 允许写入
    const r2 = await cli(args(dbPath, ['export', 'bundle', '--out', outDir, '--force']));
    assert.equal(r2.code, 0);
    assert.equal(JSON.parse(r2.out).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }); }
});

test('export bundle：--limit abc / --sort bogus / --since bad → ARGS；DB 缺失 → DB_UNREADABLE', async () => {
  const { dir, dbPath } = setup();
  const outDir = join(dir, 'b2');
  try {
    assert.equal((await cli(args(dbPath, ['export', 'bundle', '--out', join(dir, 'b1'), '--limit', 'abc']))).code, 2);
    assert.equal((await cli(args(dbPath, ['export', 'bundle', '--out', join(dir, 'b2'), '--sort', 'bogus']))).code, 2);
    assert.equal((await cli(args(dbPath, ['export', 'bundle', '--out', join(dir, 'b3'), '--since', 'bad']))).code, 2);
    const r = await cli(args(join(tmpdir(), 'cli-export-no-such.db'), ['export', 'bundle', '--out', join(dir, 'b4')]));
    assert.equal(r.code, 4);
    assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
