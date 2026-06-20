document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const video = document.getElementById("video");
  const stats = document.getElementById("stats");
  const btn = document.getElementById("btn-capture");

  function refresh() {
    chrome.runtime.sendMessage({ type: "WS_STATUS" }, (resp) => {
      if (resp?.connected) { status.textContent = "已连接"; status.className = "status ok"; }
      else { status.textContent = "未连接"; status.className = "status no"; }
    });
  }

  btn.onclick = () => { chrome.runtime.sendMessage({ type: "MANUAL_CAPTURE" }); };

  refresh();
  setInterval(refresh, 2000);
});
