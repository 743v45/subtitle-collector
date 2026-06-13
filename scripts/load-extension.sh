# 加载扩展（旧方法，已过时）

> ⚠️ **此脚本的方法已证明无效**：CDP `Extensions.loadUnpacked` 虽能注册扩展，
> 但 content scripts 不注入（`window.fetch` 仍为 native）。
>
> **正确方法**见 MANUAL.md「决定性突破」与 [verify-extension.mjs](verify-extension.mjs)：
> 用 Chrome for Testing + puppeteer `--load-extension` 才能让 content scripts 完整注入。
>
> ~~2026-06-10 记录，Chrome 149.0.7827.55~~

## 清理 + 启动

```bash
pkill -f "chrome-ext-test" 2>/dev/null; sleep 1; rm -rf /tmp/chrome-ext-test

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/chrome-ext-test \
  --no-first-run \
  --remote-debugging-port=9222 \
  "--remote-allow-origins=*" \
  &>/dev/null &

sleep 4
curl -s http://127.0.0.1:9222/json/version | python3 -c "import json,sys; v=json.load(sys.stdin); print('Browser:', v.get('Browser')); print('WebSocket:', v.get('webSocketDebuggerUrl'))"
```

## 加载扩展

```bash
python3 << 'PYEOF'
import json, urllib.request, websocket

v = json.loads(urllib.request.urlopen('http://127.0.0.1:9222/json/version').read())
ws_url = v['webSocketDebuggerUrl']

ws = websocket.create_connection(ws_url, timeout=10)
ws.send(json.dumps({
    "id": 1,
    "method": "Extensions.loadUnpacked",
    "params": {
        "path": "/Users/taevas/code/mymy/bilibili-extensions/apps/subtitle-extractor"
    }
}))

while True:
    msg = ws.recv()
    parsed = json.loads(msg)
    if parsed.get("id") == 1:
        print(json.dumps(parsed, indent=2))
        break

ws.close()
PYEOF
```

## 验证

```bash
curl -s http://127.0.0.1:9222/json/list | python3 -c "
import json, sys
for t in json.load(sys.stdin):
    print(t.get('type'), '|', t.get('title'), '|', t.get('url', '')[:80])
"
```

## 清理

```bash
pkill -f "chrome-ext-test"
rm -rf /tmp/chrome-ext-test
```
