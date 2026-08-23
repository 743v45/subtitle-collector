#!/usr/bin/env node
// 串行采集字幕：对 bvid 列表逐个 collect subtitle（sleep 1s 防风控）。
// 遇 need_login / risk_control 即停（skill 规定）。每步+总耗时打印。
// --tag "a,b"：采完后对采集成功的清单一次性 tags apply --source batch（批量档标签）。
// 用法：node scripts/collect-batch.mjs <bvid...>  （或 --file /tmp/bvids.txt [--tag "ai,面试题"]）
// 环境：COLLECTOR_SERVER 指向代理（127.0.0.1:21528），COLLECTOR_TOKEN，PATH 含 node24。
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
let bvids = [];
let batchTags = null;
{
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag') { batchTags = args[++i]; continue; }
    rest.push(args[i]);
  }
  if (rest[0] === '--file') bvids = (await import('node:fs')).readFileSync(rest[1], 'utf8').trim().split(/\s+/);
  else bvids = rest;
}
if (!bvids.length) { console.error('用法: collect-batch.mjs <bvid...> | --file <file> [--tag "a,b"]'); process.exit(1); }
const tagNames = batchTags ? batchTags.split(',').map((s) => s.trim()).filter(Boolean) : [];

// 仓库根相对定位（脚本在 scripts/ 下），避免硬编码绝对路径换环境即挂
const CLI_DIR = new URL('../apps/collector-server/', import.meta.url).pathname;
const env = { ...process.env };
const t0 = Date.now();
const el = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

function collectSubtitle(bvid) {
  const out = execFileSync('npx', ['tsx', 'src/cli/main.ts', 'collect', 'subtitle', bvid, '--format', 'json'],
    { cwd: CLI_DIR, env, encoding: 'utf8', timeout: 60000 });
  // CLI 输出是 pretty JSON，可能前面混 zsh 噪音行——取首个 '{' 到末尾整体 parse
  const start = out.indexOf('{');
  if (start < 0) throw new Error('no JSON in output: ' + out.slice(0, 100));
  return JSON.parse(out.slice(start));
}

const done = { ok: 0, noSubtitle: 0, fail: 0 };
const fails = [];
const collectedVids = []; // 采集成功（含无字幕但已入库）的清单，--tag 打 batch 标用
el(`开始采集 ${bvids.length} 条`);
for (let i = 0; i < bvids.length; i++) {
  const bv = bvids[i];
  const st = Date.now();
  try {
    const j = collectSubtitle(bv);
    const r = j?.result ?? {};
    if (r.ok === false) {
      const err = r.error ?? 'unknown';
      if (err === 'need_login' || err === 'risk_control') {
        el(`  ✗ [${i + 1}/${bvids.length}] ${bv} → ${err} —— 按纪律停止批量`);
        console.log(`\nSTOP_REASON=${err}`);
        process.exit(2);
      }
      el(`  ✗ [${i + 1}/${bvids.length}] ${bv} → ${err}`);
      done.fail++; fails.push(`${bv}: ${err}`);
    } else if (r.reason === 'no_subtitle') {
      el(`  ○ [${i + 1}/${bvids.length}] ${bv} 无字幕（跳过） ${Date.now() - st}ms`);
      done.noSubtitle++;
      collectedVids.push(bv); // video 行已入库，同样打标（防重采语义保留）
    } else {
      el(`  ✓ [${i + 1}/${bvids.length}] ${bv} 采到 ${r.tracks ?? '?'} 轨 ${Date.now() - st}ms`);
      done.ok++;
      collectedVids.push(bv);
    }
  } catch (e) {
    el(`  ✗ [${i + 1}/${bvids.length}] ${bv} 异常: ${String(e.message).slice(0, 80)}`);
    done.fail++; fails.push(`${bv}: ${String(e.message).slice(0, 50)}`);
  }
  if (i < bvids.length - 1) await new Promise((r) => setTimeout(r, 1000));
}
el(`\n=== 完成：采到 ${done.ok} / 无字幕 ${done.noSubtitle} / 失败 ${done.fail} ===`);
if (fails.length) console.log('失败明细:\n' + fails.join('\n'));

// --tag 收尾：对采集成功清单一次性打 batch 档标签
if (tagNames.length > 0 && collectedVids.length > 0) {
  try {
    const out = execFileSync('npx', ['tsx', 'src/cli/main.ts', 'tags', 'apply', ...collectedVids, '--names', tagNames.join(','), '--source', 'batch', '--format', 'json'],
      { cwd: CLI_DIR, env, encoding: 'utf8', timeout: 60000 });
    const j = JSON.parse(out.slice(out.indexOf('{')));
    el(`标签：${tagNames.join(',')} × ${collectedVids.length} 视频（batch 档）→ inserted=${j.inserted}${(j.missing ?? []).length ? ' missing=' + j.missing.length : ''}`);
  } catch (e) {
    console.log(`标签打标失败: ${String(e.message).slice(0, 100)}`);
  }
}
console.log(`总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
