#!/usr/bin/env node
// 串行采集字幕：对 bvid 列表逐个 collect subtitle（sleep 1s 防风控）。
// 遇 need_login / risk_control 即停（skill 规定）。每步+总耗时打印。
// 用法：node scripts/collect-batch.mjs <bvid...>  （或 --file /tmp/bvids.txt）
// 环境：COLLECTOR_SERVER 指向代理（127.0.0.1:21528），COLLECTOR_TOKEN，PATH 含 node24。
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
let bvids = [];
if (args[0] === '--file') bvids = (await import('node:fs')).readFileSync(args[1], 'utf8').trim().split(/\s+/);
else bvids = args;
if (!bvids.length) { console.error('用法: collect-batch.mjs <bvid...> | --file <file>'); process.exit(1); }

const CLI_DIR = '/Users/taevas/code/mymy/bilibili-extensions/apps/collector-server';
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
    } else if (r.data?.reason === 'no_subtitle') {
      el(`  ○ [${i + 1}/${bvids.length}] ${bv} 无字幕（跳过） ${Date.now() - st}ms`);
      done.noSubtitle++;
    } else {
      el(`  ✓ [${i + 1}/${bvids.length}] ${bv} 采到 ${r.data?.tracks ?? '?'} 轨 ${Date.now() - st}ms`);
      done.ok++;
    }
  } catch (e) {
    el(`  ✗ [${i + 1}/${bvids.length}] ${bv} 异常: ${String(e.message).slice(0, 80)}`);
    done.fail++; fails.push(`${bv}: ${String(e.message).slice(0, 50)}`);
  }
  if (i < bvids.length - 1) await new Promise((r) => setTimeout(r, 1000));
}
el(`\n=== 完成：采到 ${done.ok} / 无字幕 ${done.noSubtitle} / 失败 ${done.fail} ===`);
if (fails.length) console.log('失败明细:\n' + fails.join('\n'));
console.log(`总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
