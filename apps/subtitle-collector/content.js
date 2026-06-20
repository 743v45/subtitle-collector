const collected = new Map(); // bvid -> { meta, bodies: Map<url, body> }
const riskControl = new Set();
const needLogin = new Set();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const { type, data } = event.data || {};
  if (type === "PLAYER_META") {
    const cur = collected.get(data.bvid) ?? { meta: data, bodies: new Map() };
    cur.meta = data;
    collected.set(data.bvid, cur);
    flushIfReady(data.bvid);
  } else if (type === "SUBTITLE_BODY") {
    // 找到对应 bvid（暴力遍历，简单起见；可优化）
    for (const [bvid, cur] of collected.entries()) {
      if (cur.meta.subs.some((s) => s.subtitle_url === data.url)) {
        cur.bodies.set(data.url, data.body);
        flushIfReady(bvid);
        return;
      }
    }
  } else if (type === "RISK_CONTROL") {
    // 简化：标记当前页 bvid
    if (collected.size > 0) riskControl.add([...collected.keys()].pop());
  } else if (type === "NEED_LOGIN") {
    if (collected.size > 0) needLogin.add([...collected.keys()].pop());
  }
});

function flushIfReady(bvid) {
  const cur = collected.get(bvid);
  if (!cur?.meta) return;
  const ready = cur.meta.subs.filter((s) => cur.bodies.has(s.subtitle_url) || !s.subtitle_url);
  if (ready.length === 0) return;
  // 组装上报
  const tracks = cur.meta.subs.map((s) => {
    const body = cur.bodies.get(s.subtitle_url);
    if (!body) return null;
    return {
      lan: s.lan, lan_doc: s.lan_doc, track_type: s.track_type,
      versions: [{ origin: "external", payload: body, source_url: s.subtitle_url }],
    };
  }).filter(Boolean);
  if (tracks.length === 0) return;
  const record = {
    source: "bilibili",
    video: {
      source_vid: cur.meta.bvid,
      creator: { source_uid: String(cur.meta.up_mid ?? "unknown"), name: cur.meta.up_name },
      title: cur.meta.title,
      extra: { aid: cur.meta.aid, cid: cur.meta.cid, pic: cur.meta.pic },
      duration: cur.meta.duration,
      published_at: cur.meta.published_at,
    },
    tracks,
  };
  chrome.runtime.sendMessage({ type: "INGEST", payload: record });
}

// 接受 background 命令：在当前页执行 DOM 操作（如点字幕开关）
// operate 用短超时观察点击后是否真的触发了字幕请求（aisubtitle/bfs/subtitle），
// 只报"找到并点了"不够——必须确认点击产生了字幕流量，否则上层据此降级到 CDP（见 Task 4b spike）。
let operateWatch = { active: false, observedSubtitle: false };
// 复用 message 监听窗口：inject 发来的 SUBTITLE_BODY（source === window）出现即视为点击生效
// （在已有 message listener 之外追加一个轻量标记监听，避免改动上面的聚合逻辑）
window.addEventListener("message", (event) => {
  // 修正：inject.js 用 window.postMessage，source === window；plan 原文写 !== window 系笔误
  if (event.source === window && event.data?.type === "SUBTITLE_BODY") {
    operateWatch.observedSubtitle = true;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPERATE") {
    const { op } = msg;
    if (op === "click-subtitle-toggle") {
      const sel = ".bpx-player-ctrl-btn-icon, [aria-label*='字幕'], .subtitle-btn";
      const el = document.querySelector(sel);
      if (!el) { sendResponse({ ok: false, error: "toggle not found" }); return true; }

      // 点击前重置观察窗口，尝试真实 click()
      operateWatch = { active: true, observedSubtitle: false };
      try { el.click(); } catch {}

      // 5s 内监听是否出现字幕请求；不行再试 pointerdown+pointerup+click 序列
      const tryWait = (clickedOk) => {
        setTimeout(() => {
          if (!operateWatch.observedSubtitle && clickedOk) {
            // click() 无效，退而试完整指针序列（部分播放器需要 pointerdown/up 配合）
            operateWatch.observedSubtitle = false;
            try {
              el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
              el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            } catch {}
            setTimeout(() => finish(operateWatch.observedSubtitle), 5000);
          } else {
            finish(operateWatch.observedSubtitle);
          }
          function finish(observed) {
            operateWatch.active = false;
            sendResponse({
              ok: true, clicked: true, subtitleObserved: observed,
              // subtitleObserved=false 即点击未触发字幕请求，上层据此决定是否走 CDP 降级
              note: observed ? "click 触发了字幕请求" : "点击后 5s 内未观察到字幕请求，建议 CDP 降级",
            });
          }
        }, 5000);
      };
      tryWait(true);
    } else {
      sendResponse({ ok: false, error: "unknown op" });
    }
    return true; // 异步 sendResponse
  }
});
