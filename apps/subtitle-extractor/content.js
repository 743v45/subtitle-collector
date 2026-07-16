// apps/subtitle-extractor/content.js
// ISOLATED world:收 inject 的 AUDIO_TRACKS,按"自动提取"开关决定是否让 background 抓音轨转写。
// 抄 subtitle-collector/content.js 的 message 接收模式;开关默认关(fail-closed,显式开才自动提取)。
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const { type, data } = event.data || {};
  if (type !== "AUDIO_TRACKS") return;
  chrome.storage.local.get(["extractEnabled"], ({ extractEnabled }) => {
    if (extractEnabled !== true) return; // 关:不自动提取(手动模式)
    try {
      chrome.runtime.sendMessage({
        type: "FETCH_AUDIO",
        audioUrl: data.audioUrl,
        backupUrls: data.backupUrls ?? [],
        bvid: data.bvid,
        title: data.title,
      });
      console.log(
        `[content] 自动提取触发 bvid=${data.bvid} title=${data.title}`,
      );
    } catch (e) {
      console.warn("[content] FETCH_AUDIO 发送失败", e?.message);
    }
  });
});
