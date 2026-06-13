let subtitleMeta = [];
let subtitleContents = {};

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const { type, data } = event.data || {};

  if (type === "BILIBILI_SUBTITLE_META") {
    subtitleMeta = data;
  } else if (type === "BILIBILI_SUBTITLE_CONTENT") {
    subtitleContents[data.url] = data.data;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_SUBTITLE") {
    sendResponse({ meta: subtitleMeta, contents: subtitleContents });
  }
});
