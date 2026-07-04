import { REPORTING_KEY } from "./reporting.mjs";

document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const biliLogin = document.getElementById("bili-login");
  const video = document.getElementById("video");
  const collected = document.getElementById("collected");
  const reportToggle = document.getElementById("report-toggle");
  const reportLabel = document.getElementById("report-label");
  const btn = document.getElementById("btn-capture");

  function refresh() {
    chrome.runtime.sendMessage({ type: "WS_STATUS" }, (resp) => {
      if (resp?.connected) { status.textContent = "已连接"; status.className = "status ok"; }
      else { status.textContent = "未连接"; status.className = "status no"; }
    });
  }

  function checkBiliLogin() {
    fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.code === 0 && d.data?.isLogin) {
          biliLogin.textContent = `已登录 (${d.data.uname || '用户'})`;
          biliLogin.className = "status ok";
        } else {
          biliLogin.textContent = "未登录（无法采集字幕，请先登录 bilibili.com）";
          biliLogin.className = "status no";
        }
      })
      .catch(() => { biliLogin.textContent = "检查失败（网络问题）"; biliLogin.className = "status no"; });
  }

  // 查询当前视频在本地服务端的已收集情况（上次收集时间 + 字幕轨数 + extra 摘要）。
  // 扩展声明了 *://127.0.0.1/* host_permissions，popup 直连本地 API 不受 CORS 限制。
  function loadCollected() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const m = tab?.url?.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/);
      if (!m) {
        video.textContent = "当前视频: 非视频页";
        collected.textContent = "";
        return;
      }
      const bvid = m[1];
      video.textContent = "当前视频: " + bvid;
      fetch(`http://127.0.0.1:21527/api/videos/bilibili/${bvid}`)
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) {
            collected.innerHTML = '<span class="muted">未收集（在视频页打开字幕后会自动采集）</span>';
            return;
          }
          const v = d.video || {};
          const extra = parseExtra(v.extra);
          const stat = extra.stat || {};
          const tags = Array.isArray(extra.tags) ? extra.tags : [];
          const pages = Array.isArray(extra.pages) ? extra.pages : [];
          const updated = v.updated_at ? new Date(v.updated_at).toLocaleString() : "-";
          const tracks = d.tracks?.length ?? 0;
          // stat.danmaku = 该视频收到的弹幕条数（B 站公开统计字段），非本项目采集的弹幕内容
          const lines = [
            "上次收集 " + esc(updated),
            "字幕轨 " + tracks + (pages.length > 1 ? " · 分P " + pages.length : "") + (extra.tname ? " · " + esc(extra.tname) : ""),
            "播放 " + fmtNum(stat.view) + " · 点赞 " + fmtNum(stat.like) + " · 投币 " + fmtNum(stat.coin) + " · 收藏 " + fmtNum(stat.fav),
            "转发 " + fmtNum(stat.share) + " · 弹幕数 " + fmtNum(stat.danmaku),
          ];
          if (tags.length) {
            lines.push("标签(" + tags.length + "): " + esc(tags.slice(0, 6).map((t) => t.tag_name).join(" / ")) + (tags.length > 6 ? " …" : ""));
          }
          collected.innerHTML = lines.map((h) => '<div>' + h + '</div>').join("");
        })
        .catch(() => {
          collected.innerHTML = '<span class="muted">服务端未运行，无法查询已收集数据</span>';
        });
    });
  }

  function parseExtra(s) {
    try { return typeof s === "string" ? JSON.parse(s) : (s || {}); } catch { return {}; }
  }
  function fmtNum(n) {
    if (n == null) return "-";
    const x = Number(n);
    if (x >= 10000) return (x / 10000).toFixed(1).replace(/\.0$/, "") + "万";
    return String(x);
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 上报开关：打开时从 storage 读（默认开），onchange 发 SET_REPORTING 由 background 统一处理
  chrome.storage.local.get([REPORTING_KEY], (items) => {
    const enabled = items[REPORTING_KEY] !== false;
    reportToggle.checked = enabled;
    reportLabel.textContent = enabled ? "开" : "关";
  });
  reportToggle.onchange = () => {
    reportLabel.textContent = reportToggle.checked ? "开" : "关";
    chrome.runtime.sendMessage({ type: "SET_REPORTING", enabled: reportToggle.checked });
  };

  btn.onclick = () => { chrome.runtime.sendMessage({ type: "MANUAL_CAPTURE" }); setTimeout(loadCollected, 1500); };

  refresh();
  checkBiliLogin();
  loadCollected();
  setInterval(refresh, 2000);
  setInterval(checkBiliLogin, 30000);
});
