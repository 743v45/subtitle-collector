#!/usr/bin/env node
// YouTube 频道采集验收：频道全量清单 vs 库内已采，输出覆盖率与缺失明细。
// 用法：node scripts/verify-yt-channel.mjs <@handle|UCxxx|URL> [--server <url>] [--token <t>] [--top 20]
//   --server/--token 缺省取 COLLECTOR_SERVER/COLLECTOR_TOKEN 环境变量。
// 数据源（2026-08-24 定稿）：
//   全量清单 = scripts/youtube-collect-videos.mjs（InnerTube 续页拉满；扩展 list-yt-channel-videos
//   的 tab 注入路径有 browse 故障只回 30 条，勿作验收基准）；
//   库内已采 = server HTTP /api/videos?creator_uid=（不直读生产库——virtiofs 宿主机直读违禁）。
// 退出码：0 全采 / 1 有缺失或请求失败。日志纪律（§9）：[list]/[fetch]/[compare] 分步 stderr 计数。
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const channel = args.find((a) => !a.startsWith('--') && a !== flag('--server') && a !== flag('--token') && a !== flag('--top'));
const SERVER = flag('--server') ?? process.env.COLLECTOR_SERVER ?? 'http://127.0.0.1:21527';
const TOKEN = flag('--token') ?? process.env.COLLECTOR_TOKEN ?? '';
const TOP = Number(flag('--top') ?? 20);

if (!channel) { console.error('用法: verify-yt-channel.mjs <@handle|UCxxx|URL> [--server <url>] [--token <t>] [--top <n>]'); process.exit(2); }

const log = (tag, msg) => console.error(`[${tag}] ${msg}`);

// ── list：频道全量清单（youtube-collect-videos.mjs 全量分页；月数 240 覆盖全历史）──
const listOut = await new Promise((resolve) => {
  execFile('node', [join(HERE, 'youtube-collect-videos.mjs'), channel, '240'], { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => {
      for (const line of String(stderr ?? '').split('\n')) {
        if (/\[(handle|main|browse|parse|filter)\]/.test(line)) log('list', line);
      }
      if (err) { log('list', `清单脚本失败: ${err.message}`); process.exit(1); }
      resolve(String(stdout));
    });
});
const allVids = listOut.split('\n').map((l) => l.split('\t')[0]).filter((v) => /^[A-Za-z0-9_-]{11}$/.test(v));
if (allVids.length === 0) { log('list', '清单为 0 条——解析失败或频道无视频'); process.exit(1); }
log('list', `频道全量清单: ${allVids.length} 条`);

// ── fetch：库内该频道已采（/api/videos 分页拉全量）──
const channelId = /^UC[\w-]{22}$/.test(channel) ? channel : null;
const api = (path) => fetch(`${SERVER}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then(async (r) => {
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.ok === false) throw new Error(`HTTP ${r.status}: ${b.error ?? r.statusText}`);
  return b;
});
let collectedSet;
try {
  collectedSet = new Set();
  let page = 1;
  for (;;) {
    const filterQs = channelId ? `&creator_uid=${encodeURIComponent(channelId)}` : '';
    const b = await api(`/api/videos?source=youtube${filterQs}&size=100&page=${page}`);
    for (const it of b.items ?? []) collectedSet.add(it.source_vid);
    if ((b.items ?? []).length === 0 || collectedSet.size >= (b.total ?? 0)) break;
    page++;
    if (page > 20) break; // 兜底：>2000 条不支持，验收场景足够
  }
} catch (e) {
  log('fetch', `库内查询失败: ${e.message}（server=${SERVER}；token 带了吗？）`);
  process.exit(1);
}
log('fetch', `库内已采（该频道归属）: ${collectedSet.size} 条`);

// ── compare ──
const missing = allVids.filter((v) => !collectedSet.has(v));
const pct = ((allVids.length - missing.length) / allVids.length * 100).toFixed(1);
log('compare', `已采 ${allVids.length - missing.length}/${allVids.length}（${pct}%）缺失 ${missing.length}`);
if (missing.length > 0) {
  const byVid = new Map(listOut.split('\n').filter(Boolean).map((l) => [l.split('\t')[0], l.split('\t')[2] ?? '']));
  console.error(`[compare] 缺失清单（前 ${Math.min(TOP, missing.length)} 条，全量见 stdout JSON）：`);
  for (const m of missing.slice(0, TOP)) console.error(`  ${m}  ${(byVid.get(m) ?? '').slice(0, 60)}`);
}
console.log(JSON.stringify({ channel, total: allVids.length, collected: allVids.length - missing.length, missing: missing.length, missing_vids: missing }));
process.exit(missing.length === 0 ? 0 : 1);

