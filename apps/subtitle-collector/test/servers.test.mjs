import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseServerUrl,
  resolveActiveServer,
  normalizeServers,
  genServerId,
  maskServerUrl,
  isLocalServer,
  DEFAULT_SERVER_URL,
} from '../servers.mjs';

// ---------------- parseServerUrl ----------------

test('parseServerUrl：ws + 端口 + token query → 派生 wsUrl/httpBase/pingUrl/token', () => {
  const r = parseServerUrl('ws://127.0.0.1:21527/ext?token=abc');
  assert.deepEqual(r, {
    wsUrl: 'ws://127.0.0.1:21527/ext?token=abc',
    httpBase: 'http://127.0.0.1:21527',
    pingUrl: 'http://127.0.0.1:21527/ping',
    token: 'abc',
  });
});

test('parseServerUrl：wss + 无 token（server 不要 token）', () => {
  const r = parseServerUrl('wss://example.com/ext');
  assert.equal(r.httpBase, 'https://example.com');
  assert.equal(r.token, null);
  assert.equal(r.pingUrl, 'https://example.com/ping');
  assert.equal(r.wsUrl, 'wss://example.com/ext');
});

test('parseServerUrl：远程 IP + 端口（LAN 场景）', () => {
  const r = parseServerUrl('ws://192.168.1.5:8080/ext?token=x');
  assert.equal(r.httpBase, 'http://192.168.1.5:8080');
  assert.equal(r.pingUrl, 'http://192.168.1.5:8080/ping');
  assert.equal(r.token, 'x');
});

test('parseServerUrl：非法/空/non-ws → null', () => {
  assert.equal(parseServerUrl(''), null);
  assert.equal(parseServerUrl(null), null);
  assert.equal(parseServerUrl(undefined), null);
  assert.equal(parseServerUrl('http://127.0.0.1:21527'), null); // 非 ws/wss
  assert.equal(parseServerUrl('not a url'), null);
});

// ---------------- resolveActiveServer ----------------

test('resolveActiveServer：activeId 匹配 / 回退首个 / 空列表', () => {
  const servers = [
    { id: 'a', name: 'A', url: 'ws://h:1/ext' },
    { id: 'b', name: 'B', url: 'ws://h:2/ext' },
  ];
  assert.equal(resolveActiveServer(servers, 'b').id, 'b');
  assert.equal(resolveActiveServer(servers, 'zzz').id, 'a'); // 脏 activeId 回退首个
  assert.equal(resolveActiveServer(servers, null).id, 'a');  // null 回退首个
  assert.equal(resolveActiveServer([], 'a'), null);
  assert.equal(resolveActiveServer(null, 'a'), null);
});

// ---------------- normalizeServers ----------------

test('normalizeServers：过滤脏项 + 去 id 重 + name 缺失回退 url', () => {
  const out = normalizeServers([
    { id: 'a', url: 'ws://h:1/ext' },            // name 缺失 → name=url
    { id: 'a', url: 'ws://h:2/ext' },            // 重复 id → 去重（保留首个）
    { id: 'b', url: 'http://h:3/ext' },          // 非 ws → 过滤
    { id: 'c', name: 'C', url: 'ws://h:4/ext' }, // 正常
    null, 'garbage', { id: 'd' },                // 脏项过滤
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[0].name, 'ws://h:1/ext'); // name 回退 url
  assert.equal(out[1].id, 'c');
  assert.equal(out[1].name, 'C');
});

test('normalizeServers：非数组 → []', () => {
  assert.deepEqual(normalizeServers(undefined), []);
  assert.deepEqual(normalizeServers(null), []);
});

// ---------------- genServerId ----------------

test('genServerId：8 位 [a-z0-9]，多次不撞（概率上）', () => {
  const id = genServerId();
  assert.match(id, /^[a-z0-9]{8}$/);
  const ids = new Set(Array.from({ length: 20 }, () => genServerId()));
  assert.equal(ids.size, 20); // 20 次全不同（8 位 36 进制，撞概率极低）
});

// ---------------- DEFAULT_SERVER_URL ----------------

test('DEFAULT_SERVER_URL 可被 parseServerUrl 解析（内置默认合法）', () => {
  const r = parseServerUrl(DEFAULT_SERVER_URL);
  assert.equal(r?.httpBase, 'http://127.0.0.1:21527');
  assert.equal(r?.pingUrl, 'http://127.0.0.1:21527/ping');
  assert.equal(r?.token, null); // 默认无 token（本地 server 可不要）
});

// ---------------- maskServerUrl ----------------

test('maskServerUrl：token 值替换为 ***（path/其他 query 不动）', () => {
  assert.equal(maskServerUrl('ws://10.1.0.75:21527/ext?token=secret'), 'ws://10.1.0.75:21527/ext?token=***');
  assert.equal(maskServerUrl('ws://127.0.0.1:21527/ext?token=abc'), 'ws://127.0.0.1:21527/ext?token=***');
});

test('maskServerUrl：无 token / 非法 / 空 → 原样', () => {
  assert.equal(maskServerUrl('ws://10.1.0.75:21527/ext'), 'ws://10.1.0.75:21527/ext');
  assert.equal(maskServerUrl('not a url'), 'not a url');
  assert.equal(maskServerUrl(''), '');
});

test('maskServerUrl：非字符串入参原样返回（UI 容错，不抛错）', () => {
  // storage 脏读（旧值/手改）可能读出非字符串，mask 层不设防会 TypeError 炸 UI
  assert.equal(maskServerUrl(null), null);
  assert.equal(maskServerUrl(undefined), undefined);
  assert.equal(maskServerUrl(123), 123);
});

test('maskServerUrl：&token= 形式（多 query 参数）也被替换', () => {
  assert.equal(
    maskServerUrl('wss://example.com/ext?a=1&token=sec&b=2'),
    'wss://example.com/ext?a=1&token=***&b=2',
  );
});

// ---------------- isLocalServer ----------------

test('isLocalServer：127.0.0.1 / localhost / ::1 → true，其余 false', () => {
  assert.equal(isLocalServer('ws://127.0.0.1:21527/ext?token=x'), true);
  assert.equal(isLocalServer('ws://localhost:21527/ext'), true);
  assert.equal(isLocalServer('ws://10.1.0.75:21527/ext'), false);
  assert.equal(isLocalServer('ws://example.com/ext'), false);
  assert.equal(isLocalServer('not a url'), false);
  assert.equal(isLocalServer(''), false);
});
