// translate.ts commander 装配层测试：子进程跑真 CLI；pending/source 直读临时 DB，
// fill 走本地 mock HTTP server（断言请求体）。覆盖三 action 成功 + ARGS 校验 + DB/错误归一化。
// 纯函数见 translate.test.ts。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | pending（json/table）+ source（stdout 纯文本）+ fill（mock server 断言 body）+ ARGS ×2 + DB_UNREADABLE | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

interface SrvReq { method: string; path: string; body: Record<string, unknown> | null }
type Responder = (req: SrvReq) => { status: number; json?: unknown };

function startMockServer(respond: Responder): Promise<{ url: string; reqs: SrvReq[]; close(): Promise<void> }> {
  return new Promise((resolveSrv) => {
    const reqs: SrvReq[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: Record<string, unknown> | null = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 空 body */ }
        const rec: SrvReq = { method: req.method ?? '', path: req.url ?? '', body };
        reqs.push(rec);
        const r = respond(rec);
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(r.json === undefined ? '' : JSON.stringify(r.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolveSrv({ url: `http://127.0.0.1:${addr.port}`, reqs, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

// 造库：BVA=ai-en 无中文（pending/source/fill 全链路目标）
function seedDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collector-translate-cli2-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BVA', title: '英文视频', creator: { source_uid: '1', name: 'up' }, duration: 10 },
    tracks: [{
      lan: 'ai-en', lan_doc: 'English',
      versions: [{ origin: 'external', payload: { type: 'AIsubtitle', body: [
        { from: 0, to: 1, sid: 0, content: 'Hello' }, { from: 1, to: 2, sid: 1, content: 'World' },
      ] } }],
    }],
  });
  return { dbPath: join(dir, 'test.db'), cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('translate CLI 装配：pending / source / fill 三 action + 校验错误归一化', async () => {
  const { dbPath, cleanup } = seedDb();
  const dir = mkdtempSync(join(tmpdir(), 'collector-translate-cli3-'));
  try {
    const base = ['--db', dbPath, '-q'];

    // 1. pending：json 输出 {total,page,size,items}，stderr 日志被 -q 抑制
    let r = await cli([...base, 'translate', 'pending']);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.items[0].source_vid, 'BVA');
    assert.equal(parsed.items[0].langs[0].lan, 'ai-en');
    assert.equal(parsed.items[0].langs[0].lines, 2);

    // 2. pending ARGS：--sort 非法 → exit 2；--since 非法时间 / --page 非数字 → exit 2
    r = await cli([...base, 'translate', 'pending', '--sort', 'nope']);
    assert.equal(r.code, 2);
    r = await cli([...base, 'translate', 'pending', '--since', 'not-a-time']);
    assert.equal(r.code, 2);
    r = await cli([...base, 'translate', 'pending', '--page', 'abc']);
    assert.equal(r.code, 2);

    // 2b. pending DB_UNREADABLE：--db 指不存在文件 → exit 4（action catch 分支）
    r = await cli(['--db', join(dir, 'nope.db'), '-q', 'translate', 'pending']);
    assert.equal(r.code, 4);

    // 3. source：stdout 纯文本 `行号\t原文`（对齐 export subtitle 先例，不走 emitResult）
    r = await cli([...base, 'translate', 'source', 'BVA', '--from', 'ai-en']);
    assert.equal(r.code, 0);
    assert.equal(r.out, '1\tHello\n2\tWorld\n');

    // 3b. source -o：写文件（stdout 无正文）
    const f0 = join(dir, 'src.txt');
    r = await cli([...base, 'translate', 'source', 'BVA', '--from', 'ai-en', '-o', f0]);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(readFileSync(f0, 'utf8'), '1\tHello\n2\tWorld\n');

    // 4. source：不存在的视频 → DB_UNREADABLE exit 4
    r = await cli([...base, 'translate', 'source', 'BVnope']);
    assert.equal(r.code, 4);

    // 5. fill：mock server 200 → 透传响应；断言请求体（lines 剥前缀后 2 行）
    const srv = await startMockServer(() => ({ status: 200, json: { ok: true, lines: 2 } }));
    try {
      const f = join(dir, 'zh.txt');
      writeFileSync(f, '1\t你好\n2\t世界\n');
      r = await cli([...base, '--server', srv.url, 'translate', 'fill', 'BVA', '--from', 'ai-en', '--file', f]);
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.out).ok, true);
      assert.equal(srv.reqs.length, 1);
      assert.equal(srv.reqs[0].path, '/api/translate/fill');
      assert.deepEqual(srv.reqs[0].body, { source: 'bilibili', source_vid: 'BVA', from_lan: 'ai-en', lines: ['你好', '世界'] });
    } finally {
      await srv.close();
    }

    // 6. fill 本地预校验（行数不符 → RUNTIME exit 1，未发请求）
    const srv2 = await startMockServer(() => ({ status: 200, json: { ok: true } }));
    try {
      const f = join(dir, 'short.txt');
      writeFileSync(f, '只有一行\n');
      r = await cli([...base, '--server', srv2.url, 'translate', 'fill', 'BVA', '--from', 'ai-en', '--file', f]);
      assert.equal(r.code, 1);
      assert.match(JSON.parse(r.out).error, /源字幕 2 行.*译文 1 行/);
      assert.equal(srv2.reqs.length, 0, '预校验失败不发请求');
    } finally {
      await srv2.close();
    }

    // 7. fill ARGS：缺 --file → commander requiredOption exit 1（commander 默认用法错误码）
    r = await cli([...base, 'translate', 'fill', 'BVA', '--from', 'ai-en']);
    assert.notEqual(r.code, 0);

    // 8. fill 错误归一化：server 不可达 → exit 3；server 拒绝（500）→ exit 1 RUNTIME
    const f = join(dir, 'zh2.txt');
    writeFileSync(f, '你好\n世界\n');
    r = await cli([...base, '--server', 'http://127.0.0.1:1', 'translate', 'fill', 'BVA', '--from', 'ai-en', '--file', f]);
    assert.equal(r.code, 3);
    const srv3 = await startMockServer(() => ({ status: 500, json: { ok: false, error: 'boom' } }));
    try {
      r = await cli([...base, '--server', srv3.url, 'translate', 'fill', 'BVA', '--from', 'ai-en', '--file', f]);
      assert.equal(r.code, 1);
      assert.match(JSON.parse(r.out).error, /server 拒绝/);
    } finally {
      await srv3.close();
    }
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
