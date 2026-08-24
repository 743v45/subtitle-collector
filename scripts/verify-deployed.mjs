#!/usr/bin/env node
/**
 * 部署后服务状态自检(2026-08-24 生产库 SQLITE_CORRUPT 事故后补的验收工具)。
 *
 * 背景:该事故中 /ping 探活正常、多数接口 200,只有 collect-tasks 等 JOIN 路径 500——
 * 纯探活发现不了库级损坏。本工具两层检查:
 *   1. HTTP 层:免鉴权 /ping + 全部核心只读 API(带 token,断言 200 + ok:true + 关键字段形态);
 *   2. DB 层(--db 给出库文件路径时):node:sqlite 只读跑 PRAGMA integrity_check,
 *      非 'ok' 即失败(HTTP 测不出的坏页在这里暴露)。
 *
 * 用法:node scripts/verify-deployed.mjs [--server <url>] [--token <t>] [--db <path>]
 *   --server 默认 https://collector.local.taevas.host
 *   --token 默认取环境变量 COLLECTOR_TOKEN
 *   --db    部署机上的 SQLite 库路径(可选;给了才跑完整性检查)
 * 退出码:0 全过 / 1 有失败项。stdout 每项一行结果,失败项带原因(§9 可观察性)。
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
};
const SERVER = argOf('server') ?? 'https://collector.local.taevas.host';
const TOKEN = argOf('token') ?? process.env.COLLECTOR_TOKEN;
const DB = argOf('db');

// HTTP 检查清单:path → 断言(响应 JSON 形态;db 层检查单列在后)
const HTTP_CHECKS = [
  { path: '/ping', noAuth: true, assert: (d) => d?.ok === true, desc: '探活(免鉴权)' },
  { path: '/api/collect-tasks?limit=1', assert: (d) => d?.ok === true && Array.isArray(d.items), desc: '任务列表(原 500 事故接口,JOIN videos 路径)' },
  { path: '/api/videos?page=1&size=1', assert: (d) => d?.ok === true && typeof d.total === 'number', desc: '视频列表' },
  { path: '/api/changes?page=1&size=1', assert: (d) => d?.ok === true && typeof d.total === 'number', desc: '变更历史' },
  { path: '/api/stats/overview', assert: (d) => d?.ok === true && typeof d.overview?.videos === 'number', desc: '统计总览(全表聚合)' },
  { path: '/api/creators?page=1&size=1', assert: (d) => d?.ok === true && typeof d.total === 'number', desc: 'UP 列表' },
  { path: '/api/tags', assert: (d) => d?.ok === true && Array.isArray(d.items), desc: '标签列表' },
];

let failed = 0;
const report = (ok, name, detail) => {
  console.log(`${ok ? '[check]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

if (!TOKEN) {
  console.error('[fatal] 缺 token:--token <t> 或环境变量 COLLECTOR_TOKEN(鉴权接口无法自检)');
  process.exit(1);
}

console.log(`[verify-deployed] server=${SERVER} db=${DB ?? '(跳过 DB 检查)'}\n— HTTP 层 —`);
for (const c of HTTP_CHECKS) {
  const url = `${SERVER}${c.path}${c.noAuth ? '' : ''}`;
  try {
    const headers = c.noAuth ? {} : { Authorization: `Bearer ${TOKEN}` };
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (r.status !== 200) {
      report(false, `${c.path} ${c.desc}`, `HTTP ${r.status}: ${text.slice(0, 120)}`);
      continue;
    }
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      report(false, `${c.path} ${c.desc}`, `响应非 JSON: ${text.slice(0, 120)}`);
      continue;
    }
    if (c.assert(d)) report(true, `${c.path} ${c.desc}`);
    else report(false, `${c.path} ${c.desc}`, `形态不符: ${JSON.stringify(d).slice(0, 160)}`);
  } catch (e) {
    report(false, `${c.path} ${c.desc}`, `请求失败: ${String(e?.message ?? e)}`);
  }
}

if (DB) {
  console.log('— DB 层 —');
  try {
    // 只读打开:不开 WAL 写路径;integrity_check 全库扫描坏页(HTTP 层测不出的损坏在此暴露)
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all();
    db.close();
    const verdict = rows.map((r) => Object.values(r)[0]).join('; ');
    report(verdict === 'ok', `integrity_check ${DB}`, verdict === 'ok' ? '' : verdict.slice(0, 400));
  } catch (e) {
    report(false, `integrity_check ${DB}`, `打开/查询失败: ${String(e?.message ?? e)}`);
  }
} else {
  console.log('— DB 层 —\n[check] 跳过(未传 --db;建议部署机上带库路径跑,坏页损坏 HTTP 探活测不出)');
}

console.log(failed === 0 ? '\n[verify-deployed] ✓ 全部通过' : `\n[verify-deployed] ✗ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
