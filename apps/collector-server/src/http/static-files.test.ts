// static-files 单测：静态文件服务（main.ts serveStatic 抽出件）。
// 核心回归：目录路径请求不得崩进程（EISDIR 2026-10-04 冒烟实测），一律 404；
// 正常文件按 MIME 回；路径穿越拒绝；'/' 回 index.html。
// 跑法：npx c8 node --test --import tsx src/http/static-files.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 目录请求 404 / 正常文件 / MIME / 穿越 / index.html 五例 | 通过 | 2026-10-04 EISDIR 崩溃回归 |
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticFileServer } from './static-files.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

let root = '';
let res: { status?: number; headers?: Record<string, string>; body?: string; ended: boolean };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'static-test-'));
  writeFileSync(join(root, 'index.html'), '<html>home</html>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  res = { ended: false };
  // @ts-expect-error 测试桩只需三参子集
  res.writeHead = (status: number, headers?: Record<string, string>) => { res.status = status; res.headers = headers; };
  // @ts-expect-error 同上
  res.end = (body?: string) => { res.body = body; res.ended = true; };
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const serve = () => createStaticFileServer(root, MIME);

test('目录路径请求返回 404 而非崩进程（EISDIR 回归：此前 readFileSync 目录同步抛出崩掉 server）', () => {
  serve()('/assets/', res as never);
  assert.equal(res.status, 404);
  assert.equal(res.body, 'not found');
  serve()('/assets', res as never); // 无尾斜杠的目录同样 404
  assert.equal(res.status, 404);
});

test('正常文件按 MIME 返回内容', () => {
  serve()('/assets/app.js', res as never);
  assert.equal(res.status, 200);
  assert.equal(res.headers?.['Content-Type'], 'application/javascript; charset=utf-8');
  assert.equal(String(res.body), 'console.log(1)'); // res.end 收 Buffer，比较转 string
});

test("'/' 返回 index.html", () => {
  serve()('/', res as never);
  assert.equal(res.status, 200);
  assert.equal(String(res.body), '<html>home</html>');
});

test('路径穿越拒绝（../ 出根）与不存在文件一律 404', () => {
  serve()('/../escape.html', res as never);
  assert.equal(res.status, 404);
  serve()('/nope.html', res as never);
  assert.equal(res.status, 404);
});
