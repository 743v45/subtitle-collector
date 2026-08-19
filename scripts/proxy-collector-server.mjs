#!/usr/bin/env node
// 本机转发代理：127.0.0.1:21528 → 10.0.0.100:21527，重写 Host: localhost。
// 用途：远端 collector-server 的 httpOriginAllowed 只放行 loopback Host，
// CLI（undici fetch 无法覆盖 Host 头）直连 10.0.0.100 会 403。
// 经此代理后 CLI 连 http://127.0.0.1:21528（Host 校验过），流量透传远端。
import { createServer, request as httpRequest } from 'node:http';

const UPSTREAM_HOST = '10.0.0.100';
const UPSTREAM_PORT = 21527;
const LISTEN_PORT = 21528;

const proxy = createServer((req, res) => {
  const up = httpRequest(
    {
      host: UPSTREAM_HOST, port: UPSTREAM_PORT,
      method: req.method, path: req.url,
      headers: { ...req.headers, host: 'localhost' }, // 关键：重写 Host 绕过校验
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'proxy upstream error: ' + e.message }));
  });
  req.pipe(up);
});

proxy.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[proxy] 127.0.0.1:${LISTEN_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT} (Host → localhost)`);
});
