#!/usr/bin/env node
/**
 * 部署后服务状态自检(2026-08-24 生产库 SQLITE_CORRUPT 事故后补的验收工具)。
 *
 * 背景:该事故中 /ping 探活正常、多数接口 200,只有 collect-tasks 等 JOIN 路径 500——
 * 纯探活发现不了库级损坏。本工具两层检查:
 *   1. HTTP 层:免鉴权 /ping + 全部核心只读 API(带 token,断言 200 + ok:true + 关键字段形态);
 *   2. DB 层:两种给法,二选一(同传报参数错):
 *      --db <宿主路径>        node:sqlite 只读跑 PRAGMA integrity_check,非 'ok' 即失败;
 *      --via-docker [容器名]  经 docker exec <容器> node -e 用容器内 better-sqlite3 readonly
 *                             对 /data/bilibili-collector.db 跑 integrity_check(volume 部署下
 *                             宿主无库文件时的通道;缺省容器名 collector-server),
 *                             同时打库文件与 -wal 体积字节(容器内 stat)。
 *      都不传则跳过 DB 层(HTTP 层照跑,退 0/1 照常)。
 *
 * 用法:node scripts/verify-deployed.mjs [--server <url>] [--token <t>] [--db <path> | --via-docker [容器]]
 *   --server 默认 https://collector.local.taevas.host
 *   --token 默认取环境变量 COLLECTOR_TOKEN
 * 退出码:0 全过 / 1 有失败项(含参数错)。结果与失败原因全部走 stderr、带 [check]/[FAIL] 分项 tag——stdout 无数据产物,
 * 留空(输出契约 docs/quality/SCRIPTS-CONTRACT.md;§9 可观察性)。
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
};
const SERVER = argOf('server') ?? 'https://collector.local.taevas.host';
const TOKEN = argOf('token') ?? process.env.COLLECTOR_TOKEN;
const DB = argOf('db');

// --via-docker [容器名]:后随非 -- 开头的参数视为容器名,缺省 collector-server(裸选项同义)
const viaIdx = args.indexOf('--via-docker');
const VIA_DOCKER = viaIdx !== -1
  ? (args[viaIdx + 1] && !args[viaIdx + 1].startsWith('--') ? args[viaIdx + 1] : 'collector-server')
  : undefined;
const DOCKER_DB_PATH = '/data/bilibili-collector.db'; // 2026-10-04 实查 docker exec collector-server ls /data/ 确认

if (DB && VIA_DOCKER) {
  console.error('[fatal] --db 与 --via-docker 互斥(DB 层检查二选一:宿主直开 or 容器内校验)');
  process.exit(1);
}

// HTTP 检查清单:path → 断言(响应 JSON 形态;db 层检查单列在后)
const HTTP_CHECKS = [
  { path: '/ping', noAuth: true, assert: (d) => d?.ok === true, desc: '探活(免鉴权)' },
  { path: '/api/collect-tasks?limit=1', assert: (d) => d?.ok === true && Array.isArray(d.items), desc: '任务列表(原 500 事故接口,JOIN videos 路径)' },
  { path: '/api/videos?page=1&size=1', assert: (d) => d?.ok === true && typeof d.total === 'number', desc: '视频列表' },
  { path: '/api/changes?page=1&size=1', assert: (d) => d?.ok === true && typeof d.total === 'number', desc: '变更历史' },
  { path: '/api/stats/overview', assert: (d) => d?.ok === true && typeof d.total?.videos === 'number' && d.by_source?.bilibili != null, desc: '统计总览(全表聚合 + 分平台 by_source)' },
  { path: '/api/creators?page=1&size=1', assert: (d) => d?.ok === true && typeof d.total === 'number', desc: 'UP 列表' },
  { path: '/api/tags', assert: (d) => d?.ok === true && Array.isArray(d.items), desc: '标签列表' },
];

let failed = 0;
const report = (ok, name, detail) => {
  console.error(`${ok ? '[check]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

if (!TOKEN) {
  console.error('[fatal] 缺 token:--token <t> 或环境变量 COLLECTOR_TOKEN(鉴权接口无法自检)');
  process.exit(1);
}

const dbLabel = DB ?? (VIA_DOCKER ? `(容器内 ${VIA_DOCKER}: ${DOCKER_DB_PATH})` : '(跳过 DB 检查)');
console.error(`[verify-deployed] server=${SERVER} db=${dbLabel}\n— HTTP 层 —`);
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
  console.error('— DB 层 —');
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
} else if (VIA_DOCKER) {
  console.error(`— DB 层(--via-docker 容器内校验) —`);
  try {
    // 复用 backup-restore.mjs --drill 已验证的容器内单行实现:better-sqlite3 readonly + integrity_check。
    // 脚本同时 stat 库文件与 -wal(WAL 积压字节本身就是要看的信号),逐行回传宿主侧打印。
    const script = [
      `const fs=require('fs');`,
      `const P='${DOCKER_DB_PATH}';`,
      `for (const p of [P, P+'-wal']) { try { console.log('[stat] '+p+'='+fs.statSync(p).size+'B'); } catch { console.log('[stat] '+p+'=missing'); } }`,
      `const db=require('better-sqlite3')(P,{readonly:true});`,
      `console.log('integrity_check '+db.pragma('integrity_check',{simple:true}));`,
      `db.close()`,
    ].join('');
    const out = execFileSync('docker', ['exec', VIA_DOCKER, 'node', '-e', script], { encoding: 'utf8' });
    for (const line of out.split('\n').filter((l) => l.startsWith('[stat]'))) console.error(`[verify] ${line}`);
    const verdictLine = out.split('\n').find((l) => l.startsWith('integrity_check '));
    const verdict = verdictLine ? verdictLine.slice('integrity_check '.length).trim() : '';
    report(
      verdict === 'ok',
      `integrity_check ${DOCKER_DB_PATH} (via ${VIA_DOCKER})`,
      verdict === 'ok' ? '' : `容器内输出: ${(verdictLine ?? out).slice(0, 400)}`,
    );
  } catch (e) {
    // docker exec 失败(容器没跑/镜像内无 better-sqlite3/库损坏到 require 阶段崩):报错必须含容器名
    report(false, `integrity_check (via ${VIA_DOCKER})`, `docker exec 失败: ${String(e?.stderr ?? e?.message ?? e).slice(0, 400)}`);
  }
} else {
  console.error('— DB 层 —\n[check] 跳过(未传 --db / --via-docker;建议带其中之一跑,坏页损坏 HTTP 探活测不出)');
}

console.error(failed === 0 ? '\n[verify-deployed] ✓ 全部通过' : `\n[verify-deployed] ✗ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
