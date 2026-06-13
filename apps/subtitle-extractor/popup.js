document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const content = document.getElementById("content");
  let lastDataStr = "";

  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function normalizeUrl(url) {
    if (!url) return "";
    return url.startsWith("//") ? "https:" + url : url;
  }

  function render(meta, contents) {
    // Merge meta with content by URL
    const items = (meta || []).map((m) => {
      const url = normalizeUrl(m.subtitle_url);
      return { ...m, _url: url, contentData: contents[url] || null };
    });

    // Add unmatched contents
    const matchedUrls = new Set(items.map((i) => i._url));
    for (const [url, data] of Object.entries(contents || {})) {
      if (!matchedUrls.has(url)) {
        items.push({
          subtitle_url: url,
          lan: "unknown",
          lan_doc: "未知",
          type: 0,
          _url: url,
          contentData: data,
        });
      }
    }

    if (items.length === 0) return false;

    status.style.display = "none";
    content.innerHTML = "";

    for (const item of items) {
      const card = document.createElement("div");
      card.className = "card";

      const isAI = item.type === 1;
      const typeLabel = isAI
        ? "AI 自动生成"
        : item.type === 2
        ? "UP 主上传"
        : "未知";
      const badgeClass = isAI
        ? "badge-ai"
        : item.type === 2
        ? "badge-cc"
        : "badge-unknown";

      // Header
      const header = document.createElement("div");
      header.className = "card-header";
      header.innerHTML =
        `<span class="badge ${badgeClass}">${typeLabel}</span>` +
        `<span class="lang">${item.lan_doc || item.lan || "?"}</span>`;
      card.appendChild(header);

      // Body
      if (item.contentData?.body?.length) {
        const body = document.createElement("div");
        for (const line of item.contentData.body) {
          const el = document.createElement("div");
          el.className = "line";
          el.innerHTML =
            `<span class="time">${fmt(line.from)} → ${fmt(line.to)}</span>` +
            `<span class="text">${line.content || ""}</span>`;
          body.appendChild(el);
        }
        card.appendChild(body);

        const btn = document.createElement("button");
        btn.className = "copy-btn";
        btn.textContent = "复制字幕";
        btn.onclick = () => {
          const text = item.contentData.body
            .map((l) => l.content)
            .join("\n");
          navigator.clipboard.writeText(text).then(() => {
            btn.textContent = "已复制！";
            setTimeout(() => (btn.textContent = "复制字幕"), 2000);
          });
        };
        card.appendChild(btn);
      } else {
        const loading = document.createElement("div");
        loading.className = "loading";
        loading.textContent = "字幕内容加载中...";
        card.appendChild(loading);
      }

      content.appendChild(card);
    }

    return true;
  }

  function query() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        status.textContent = "请在 B 站视频页面使用此扩展";
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: "GET_SUBTITLE" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          status.textContent = "未连接到页面，请刷新视频页面后重试";
          return;
        }

        const dataStr = JSON.stringify(res);
        if (dataStr === lastDataStr) return;
        lastDataStr = dataStr;

        if (!render(res.meta, res.contents)) {
          status.textContent = "未检测到字幕，请刷新视频页面后重试";
          status.style.display = "";
        }
      });
    });
  }

  query();
  setInterval(query, 2000);
});
