import { REPORTING_KEY } from "./reporting.mjs";

document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const biliLogin = document.getElementById("bili-login");
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

  btn.onclick = () => { chrome.runtime.sendMessage({ type: "MANUAL_CAPTURE" }); };

  refresh();
  checkBiliLogin();
  setInterval(refresh, 2000);
  setInterval(checkBiliLogin, 30000);
});
