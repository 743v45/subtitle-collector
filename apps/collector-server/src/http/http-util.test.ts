import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { json, readJsonBody, runHandler, HttpError } from './http-util.js';

// runHandler + readJsonBody 集成：此前 8 份拷贝中 6 份对非法 JSON 裸 reject 且无人接，
// 一个请求即可崩掉整个 server —— 现在必须只影响该请求。

function startServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void runHandler(res, async () => {
      if (req.url === '/echo' && req.method === 'POST') {
        const body = await readJsonBody(req);
        json(res, 200, { ok: true, got: body });
        return;
      }
      if (req.url === '/boom') {
        throw new Error('unexpected');
      }
      // 已发响应头之后再抛（非 HttpError）：runHandler 走 else res.end() 分支，不重复写头
      if (req.url === '/late-boom') {
        json(res, 200, { ok: true, early: true });
        throw new Error('late failure');
      }
      json(res, 404, { ok: false, error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function post(port: number, path: string, raw: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (c: string) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    r.on('error', reject);
    r.end(raw);
  });
}

test('runHandler 集成：非法 JSON → 400 不崩进程，后续请求照常；空 body → {}', async () => {
  const { server, port, close } = await startServer();
  try {
    const bad = await post(port, '/echo', '{"broken json');
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).ok, false);
    assert.match(JSON.parse(bad.body).error, /invalid JSON/i);

    // 同一 server 后续请求正常（进程未崩、连接未拖垮）
    const ok2 = await post(port, '/echo', '{"a":1}');
    assert.equal(ok2.status, 200);
    assert.deepEqual(JSON.parse(ok2.body), { ok: true, got: { a: 1 } });

    // 空 body → {}（合法：可选项端点不发 body）
    const empty = await post(port, '/echo', '');
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(empty.body), { ok: true, got: {} });

    // handler 意外异常 → 500 不崩
    const boom = await post(port, '/boom', '{}');
    assert.equal(boom.status, 500);
    assert.equal(JSON.parse(boom.body).ok, false);

    // 响应头已发出后再抛非 HttpError → 保留已发的 200 响应体（不二次写头、不崩）
    const late = await post(port, '/late-boom', '{}');
    assert.equal(late.status, 200);
    assert.deepEqual(JSON.parse(late.body), { ok: true, early: true });
    // 后续请求照常（连接未被拖垮）
    const after = await post(port, '/echo', '{"b":2}');
    assert.equal(after.status, 200);
  } finally {
    await close();
  }
});

test('HttpError：status 与 message 透传', () => {
  const e = new HttpError(418, "I'm a teapot");
  assert.equal(e.status, 418);
  assert.equal(e.message, "I'm a teapot");
});

// httpAuthOk：暴露部署的 /api/* 鉴权判定
import { httpAuthOk, httpOriginAllowed } from './http-util.js';
test('httpAuthOk：loopback 部署不鉴权；同源浏览器放行；其余必须 Bearer', () => {
  const base = { required: true, token: 'T0KEN' };
  // loopback（required=false）全放行
  assert.equal(httpAuthOk({ ...base, required: false }), true);
  // Sec-Fetch-Site: same-origin（同源 GET fetch——浏览器不发 Origin，此前会被误判 401）
  assert.equal(httpAuthOk({ ...base, secFetchSite: 'same-origin' }), true);
  // Sec-Fetch-Site: none（地址栏直达导航）
  assert.equal(httpAuthOk({ ...base, secFetchSite: 'none' }), true);
  // 跨站（浏览器 JS 攻击）→ 拒（即便伪造不了 Sec-Fetch-Site 时 cross-site 也要拒）
  assert.equal(httpAuthOk({ ...base, secFetchSite: 'cross-site' }), false);
  assert.equal(httpAuthOk({ ...base, secFetchSite: 'cross-site', authorization: 'Bearer T0KEN' }), true);
  // Origin 与 Host 的 hostname 同源（POST 带 Origin；反代后端口不可靠 → 比 hostname）
  assert.equal(httpAuthOk({ ...base, origin: 'https://collector.local:443', host: 'collector.local:21527' }), true);
  assert.equal(httpAuthOk({ ...base, origin: 'http://192.168.1.5:21527', host: '192.168.1.5:21527' }), true);
  // 跨源/无浏览器头（curl、CLI、扩展）必须 Bearer：无/错 token 拒，对 token 过
  assert.equal(httpAuthOk({ ...base }), false);
  assert.equal(httpAuthOk({ ...base, origin: 'chrome-extension://abc', host: '192.168.1.5:21527' }), false);
  assert.equal(httpAuthOk({ ...base, authorization: 'Bearer wrong' }), false);
  assert.equal(httpAuthOk({ ...base, origin: 'chrome-extension://abc', host: '192.168.1.5:21527', authorization: 'Bearer T0KEN' }), true);
  // 非 server 域 Origin 不放行
  assert.equal(httpAuthOk({ ...base, origin: 'http://evil.com:21527', host: '192.168.1.5:21527' }), false);
});

// httpOriginAllowed：Host（防 DNS rebinding）+ Origin（浏览器来源）校验
test('httpOriginAllowed：Host 校验 + 无 Origin 放行 + 扩展 Origin 放行', () => {
  const base = { allowedHosts: [] as string[] };
  // Host 非 loopback 且未放行 → 拒（DNS rebinding）
  assert.equal(httpOriginAllowed({ ...base, host: 'evil.example.com', origin: 'http://evil.example.com' }), false);
  // loopback Host 放行；无 Origin（curl / 服务端 fetch）放行
  assert.equal(httpOriginAllowed({ ...base, host: 'localhost:21527' }), true);
  assert.equal(httpOriginAllowed({ ...base, host: '127.0.0.1:21527' }), true);
  // 扩展 Origin 放行
  assert.equal(httpOriginAllowed({ ...base, host: 'localhost:21527', origin: 'chrome-extension://abcdef0123456789' }), true);
});

test('httpOriginAllowed：loopback Origin 精确匹配 hostname（防 localhost.evil.com 前缀注入）', () => {
  const base = { host: 'localhost:21527', allowedHosts: [] as string[] };
  // 合法：localhost / 127.0.0.1 的 http 与 https，端口任意
  assert.equal(httpOriginAllowed({ ...base, origin: 'http://localhost:21527' }), true);
  assert.equal(httpOriginAllowed({ ...base, origin: 'https://localhost:5173' }), true);
  assert.equal(httpOriginAllowed({ ...base, origin: 'http://127.0.0.1:21527' }), true);
  assert.equal(httpOriginAllowed({ ...base, origin: 'https://127.0.0.1' }), true);
  // 前缀注入：hostname 不是 localhost 本身 → 拒
  assert.equal(httpOriginAllowed({ ...base, origin: 'http://localhost.evil.com' }), false, 'localhost.evil.com 前缀绕过应被拒');
  assert.equal(httpOriginAllowed({ ...base, origin: 'http://127.0.0.1.evil.com' }), false);
  assert.equal(httpOriginAllowed({ ...base, origin: 'http://evil.com/?x=http://localhost' }), false);
  // 非法 Origin 字符串（解析失败）→ 拒
  assert.equal(httpOriginAllowed({ ...base, origin: '::not an origin::' }), false);
});

test('httpOriginAllowed：ALLOWED_HOSTS 精确 host 匹配（放行主机及其 Origin）', () => {
  const base = { host: 'collector.local:21527', allowedHosts: ['collector.local'] };
  // 放行主机的 Host + 同源 Origin（http/https、带/不带端口）
  assert.equal(httpOriginAllowed({ ...base, origin: 'http://collector.local:21527' }), true);
  assert.equal(httpOriginAllowed({ ...base, origin: 'https://collector.local' }), true);
  // Host 未放行（即便 Origin 是放行主机）→ 拒（Host 防的是 rebinding，先于 Origin 校验）
  assert.equal(httpOriginAllowed({ host: '192.168.1.5:21527', allowedHosts: ['collector.local'], origin: 'http://collector.local' }), false);
  assert.equal(httpOriginAllowed({ host: 'other.host', allowedHosts: ['collector.local'], origin: 'http://collector.local' }), false);
  // 放行主机的 Origin 但 hostname 精确不匹配（前缀注入）→ 拒
  assert.equal(httpOriginAllowed({ ...base, origin: 'http://collector.local.evil.com' }), false);
});

// ── 分支洼地：非法 Origin URL 的 catch 降级、Host 头缺失 ──
test('httpAuthOk：Origin 为非法 URL 字符串 → 解析失败按无 Origin 处理（须 Bearer）', () => {
  const base = { required: true, token: 'T0KEN' };
  // '::bad::' 令 new URL 抛错 → catch 置 null → 同源分支不成立 → 走 Bearer
  assert.equal(httpAuthOk({ ...base, origin: '::bad::', host: '192.168.1.5:21527' }), false);
  assert.equal(httpAuthOk({ ...base, origin: '::bad::', host: '192.168.1.5:21527', authorization: 'Bearer T0KEN' }), true);
});

test('httpOriginAllowed：Host 头缺失（undefined 归空串）→ 非 loopback 未放行 → 拒', () => {
  assert.equal(httpOriginAllowed({ allowedHosts: [] }), false);
  assert.equal(httpOriginAllowed({ allowedHosts: [], origin: 'http://localhost:5173' }), false, 'Host 缺失时即便 Origin 是 loopback 也拒');
});
