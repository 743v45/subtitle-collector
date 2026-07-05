// 生成 B 站 v1 分区字典（tid → {name, code, parent, main}）。
// 数据源：pskdje/bilibili-API-collect（SocialSisterYi 原仓库已 deprecated）的 video_zone.md。
// view API 返回的 tid/tname 字段对应 v1（tname 恒为空，需本字典反查）；tid_v2/tname_v2 见 video_zone_v2.md。
// 用法：pnpm -C apps/collector-server exec node scripts/gen-zones.mjs
// 分区变动极少，必要时重跑刷新 data/zones-v1.json。
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = 'https://raw.githubusercontent.com/pskdje/bilibili-API-collect/main/docs/video/video_zone.md';
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'data', 'zones-v1.json');

const res = await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0' } });
if (!res.ok) throw new Error(`fetch zone md failed: ${res.status}`);
const md = await res.text();

// 大区由 `## 标题` 切分；每个表格行 `| 名称 | 代号 | tid | 简介 | url |`。
// 名称清洗：<br> 截断、去 (..)/(~~..~~) 注记、去首尾空白。
const zones = {};
let parent = '';
for (const line of md.split('\n')) {
  const h = line.match(/^##\s+(.+?)\s*$/);
  if (h) { parent = h[1].trim(); continue; }
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|/);
  if (!m) continue;
  const raw = m[1];
  const isMain = /主分区/.test(raw);
  const name = raw.replace(/<br>.*$/, '').replace(/\(.*?\)/g, '').replace(/~~.*?~~/g, '').trim();
  const code = m[2].trim();
  zones[Number(m[3])] = { name, code, parent, main: isMain };
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(zones, null, 2) + '\n');

console.log(`生成 ${Object.keys(zones).length} 条分区 → ${out}`);
const spot = [1, 207, 208, 36, 95, 211];
console.log('抽验:', spot.map((t) => `${t}=${zones[t] ? zones[t].name + (zones[t].main ? '(主)' : `/${zones[t].parent}`) : '缺失'}`).join('  '));
