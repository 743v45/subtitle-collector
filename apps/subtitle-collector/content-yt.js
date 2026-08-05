// ISOLATED world（document_start）：YouTube 字幕聚合 + 归一化 + INGEST + GET_LOCAL_STATE。
// 与 B 站 content.js 同构（collected Map / flushIfReady / FETCH_SUBTITLE 兜底 / try-catch 兜底上下文失效），
// 独立文件、独立消息源标记 'yt-sub-ext'、独立轨字段（captionTracks/baseUrl/languageCode/kind/...）。
// 契约依据：docs/superpowers/specs/2026-07-19-youtube-collector-design.md §5.1 / §5.2 / §6 / §7。
//
// crxjs 把本文件作 Rollup 入口打包（vite.config.ts），故可直接 import youtube-format.mjs / youtube-payload.js。

import { normalizeYoutubeTimedtext, parseStatCount } from "./youtube-format.mjs";
import { buildYoutubePayload, kindToTrackType } from "./youtube-payload.js";

// vid -> { meta: CAPTION_TRACKS.data, bodies: Map<baseUrl, {body:[...]}>, fetched: Set<baseUrl>, ccTriggered: boolean }
const collected = new Map();

// 自动点 YouTube CC 按钮触发播放器请求 timedtext（YouTube 默认不请求字幕，需点 CC 才发请求；
// 否则 inject hook 拦不到、兜底无 body）。对齐 B 站 content.js triggerAiSubtitle 自动点字幕按钮的模式。
// 播放器 UI 未就绪时轮询重试 ~10s。选择器多兜底（ytp 经典类 + aria-label/title 多语言）。
function triggerYtSubtitle(round = 0) {
  const sel = '.ytp-subtitles-button, button[aria-label*="subtitles" i], button[aria-label*="字幕"], button[aria-label*="caption" i], button[title*="subtitles" i], button[title*="字幕"]';
  const btn = document.querySelector(sel);
  if (!btn) {
    if (round < 20) setTimeout(() => triggerYtSubtitle(round + 1), 500);
    else console.warn('[content-yt] CC 字幕按钮长时间未找到');
    return;
  }
  try { btn.click(); console.log('[content-yt] 已点 CC 按钮触发字幕请求'); } catch (e) {
    console.warn('[content-yt] 点 CC 失败', e?.message);
  }
}

// 辅助：在当前 ytp 菜单面板中按 textContent 正则找菜单项（YouTube 菜单面板切换时 .ytp-menuitem 仅含当前面板项）。
function findMenuItem(re) {
  const items = document.querySelectorAll('.ytp-menuitem');
  for (const it of items) {
    if (re.test(it.textContent || "")) return it;
  }
  return null;
}

// 自动点 YouTube 播放器的"翻译菜单"选目标语言，让播放器被动请求翻译 timedtext（带 pot）。
// 背景：background FETCH tlang url pot 受限拿空（与原轨同病），靠播放器被动请求（带 pot）才能拿到翻译体。
// inject-yt 已 hook /api/timedtext（不挑 tlang），content-yt 收 TIMEDTEXT_BODY 归一化入库（tlang 兜底见 TIMEDTEXT_BODY 处理）。
// 菜单多级：齿轮 → 字幕项 → 自动翻译 → 选语言。每步等 ~600ms 让 UI 渲染，失败 console.warn 不崩溃。
// YouTube UI 脆弱：选择器随改版可能变，用 textContent 多语言正则兜底（中英文），真机未验证见返回说明。
function triggerYtTranslation(targetLang) {
  // 目标语言 → 菜单项 textContent 正则（YouTube 自动翻译语言列表的中英文标签）
  let langRe;
  if (targetLang.startsWith("zh")) {
    langRe = /简体|simplified/i; // 精确简体（不匹配繁体）
  } else if (targetLang === "en") {
    langRe = /^english|英语|英文/i;
  } else {
    console.warn(`[content-yt] 翻译菜单不支持的目标语言 targetLang=${targetLang}`);
    return;
  }

  // step 4：选目标语言项（展开语言列表后）
  const step4PickLang = () => {
    const item = findMenuItem(langRe);
    if (!item) {
      console.warn(`[content-yt] 翻译菜单 目标语言项未找到 targetLang=${targetLang}`);
      return;
    }
    try {
      item.click();
      console.log(`[content-yt] 翻译菜单 已选目标语言 targetLang=${targetLang}`);
    } catch (e) {
      console.warn(`[content-yt] 翻译菜单 选目标语言失败 targetLang=${targetLang}`, e?.message);
    }
  };

  // step 3：找"自动翻译"项点击 → 展开语言列表
  const step3AutoTranslate = () => {
    const item = findMenuItem(/auto.?translate|自动翻译|auto-trans|translate/i);
    if (!item) {
      console.warn('[content-yt] 翻译菜单 自动翻译项未找到');
      return;
    }
    try { item.click(); } catch (e) {
      console.warn('[content-yt] 翻译菜单 点自动翻译项失败', e?.message);
      return;
    }
    setTimeout(step4PickLang, 600);
  };

  // step 2：找字幕项点击 → 进字幕子菜单
  const step2Subtitles = () => {
    const item = findMenuItem(/subtitle|caption|字幕|CC/i);
    if (!item) {
      console.warn('[content-yt] 翻译菜单 字幕项未找到');
      return;
    }
    try { item.click(); } catch (e) {
      console.warn('[content-yt] 翻译菜单 点字幕项失败', e?.message);
      return;
    }
    setTimeout(step3AutoTranslate, 600);
  };

  // step 1：点齿轮开设置菜单（播放器 UI 未就绪则轮询重试 ~10s）
  const step1Gear = (round) => {
    const gear = document.querySelector('.ytp-settings-button');
    if (!gear) {
      if (round < 20) setTimeout(() => step1Gear(round + 1), 500);
      else console.warn('[content-yt] 翻译菜单 齿轮按钮长时间未找到');
      return;
    }
    try { gear.click(); } catch (e) {
      console.warn('[content-yt] 翻译菜单 点齿轮失败', e?.message);
      return;
    }
    setTimeout(step2Subtitles, 600);
  };

  step1Gear(0);
}

// YouTube 已从 ytInitialPlayerResponse.videoDetails 移除 likeCount（实测 keys 无此字段）；
// 点赞数仅在 like 按钮 DOM 可见（like-button-view-model textContent "6137" / button aria-label）。
// CAPTION_TRACKS 到达后异步读 like 按钮，用 parseStatCount 解析（千分位/万/亿/K/M/B）补 meta.likeCount。
function readLikeCountFromDom() {
  // 优先 like-button-view-model textContent（语言无关；当前版本为纯数字或格式化值如 "1.2万"/"1.2M"）。
  const vm = document.querySelector('like-button-view-model');
  if (vm) {
    const n = parseStatCount(vm.textContent);
    if (n != null) return n;
  }
  // 兜底：segmented like 容器内带 aria-label 的 button（aria-label 含精确数字 + 千分位，如「与另外 6,137 人一起顶此视频」）。
  const btn = document.querySelector('segmented-like-dislike-button-view-model button[aria-label]');
  if (btn) {
    const n = parseStatCount(btn.getAttribute('aria-label'));
    if (n != null) return n;
  }
  return null;
}

// 轮询读 like 按钮补 likeCount（按钮渲染晚于 CAPTION_TRACKS）。读到即定居 meta + 触发 flush（若 INGEST 尚未发则带上）。
function fillLikeCount(vid, round = 0) {
  const cur = collected.get(vid);
  if (!cur?.meta) return;
  if (cur.meta.likeCount != null) return; // inject 读到或已补
  const like = readLikeCountFromDom();
  if (like != null) {
    cur.meta.likeCount = String(like);
    console.log(`[content-yt] likeCount 补全 vid=${vid} like=${like}（videoDetails 已无此字段，从 like 按钮读）`);
    flushIfReady(vid);
    return;
  }
  if (round < 12) setTimeout(() => fillLikeCount(vid, round + 1), 500); // 轮询 ~6s 等按钮渲染
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "yt-sub-ext") return; // 仅处理本扩展 MAIN world inject 发的消息
  const { type, data } = msg;

  if (type === "CAPTION_TRACKS") {
    const vid = data?.videoId;
    if (!vid) return;
    const cur = collected.get(vid) ?? { meta: null, bodies: new Map(), fetched: new Set() };
    cur.meta = data;
    collected.set(vid, cur);
    // YouTube 已从 videoDetails 移除 likeCount（实测 keys 无此字段），仅 like 按钮 DOM 可见 → 异步补全（见 fillLikeCount）。
    if (cur.meta.likeCount == null) setTimeout(() => fillLikeCount(vid), 1500);
    const tracks = data.captionTracks ?? [];
    console.log(`[content-yt] CAPTION_TRACKS vid=${vid} tracks=${tracks.length} title=${data.title}`);
    if (tracks.length === 0) return; // captionTracks 空（纯音乐/直播/真无字幕；或 YT 偶发读不到 captionTracks 但播放器仍请求 timedtext）：meta 已定居 collected，不 FETCH/flush——若播放器后续请求 timedtext，下方 TIMEDTEXT_BODY 兜底会构造轨入库；popup 经 GET_LOCAL_STATE 见 no-subtitle
    // 路径 B（兜底，覆盖 ~96% 不需 pot 视频）：对每轨发 FETCH_SUBTITLE 让 background 免 CORS 抓 baseUrl+&fmt=json3。
    fetchSubtitleBodiesViaBg(vid, tracks);
    // 自动点 CC 按钮触发播放器请求 timedtext（YouTube 默认不请求；被动 hook 拦到后归一化入库）。
    // guard：每视频点一次，等播放器 UI 就绪后点。standalone/server 都点（用户要本地看字幕或上报）。
    if (!cur.ccTriggered) {
      cur.ccTriggered = true;
      setTimeout(triggerYtSubtitle, 1500);
    }
    // 自动点翻译菜单选中文/英文，让播放器被动请求翻译 timedtext（带 pot，绕开 background FETCH pot 受限）。
    // guard：每视频触发一次；串行（中文先、英文后 ~5s）避免同时操作播放器菜单冲突。
    // 时序：CC(1.5s) → 翻译中文(3s，菜单四级各 ~600ms) → 翻译英文(8s，留足中文菜单导航 + timedtext 拦截)。
    if (!cur.translationTriggered) {
      cur.translationTriggered = true;
      // 优先中文翻译（每视频仅 1 次翻译请求，避免频繁触发 YouTube 429 限流）
      setTimeout(() => triggerYtTranslation("zh-Hans"), 6000); // CC(1.5s) 后等 ~4.5s 字幕稳定再切翻译菜单（不急，原轨已采）
    }
    flushIfReady(vid);
  } else if (type === "TIMEDTEXT_BODY") {
    // 路径 A（主，复用播放器拼好的 pot，覆盖含 pot 视频）：按 url 匹配源轨，归一化存 body。
    const vid = data?.videoId;
    if (!vid) return;
    const cur = collected.get(vid);
    if (!cur?.meta) {
      // 早于 CAPTION_TRACKS 到达（无法匹配轨）：丢弃，路径 B 兜底会抓同一轨。
      console.log(`[content-yt] TIMEDTEXT_BODY 早于 CAPTION_TRACKS，丢弃 vid=${vid} url=${String(data.url).slice(-60)}`);
      return;
    }
    const tracks = cur.meta.captionTracks ?? [];
    let track = findTrackForUrl(tracks, data.url);
    if (!track) {
      // 匹配不到已入库轨（YT 偶发 captionTracks 读为空但播放器仍请求 timedtext——真机 tracks=0 场景；
      // 或翻译轨 tlang= 尚未入库——源轨非可翻译、或翻译目标语言与源同语言被 fetchSubtitleBodiesViaBg 跳过）。
      // 对齐 B 站 content.js:38-48 AI 字幕兜底（player 无 CC、inject 拦到 aisubtitle 就构造 ai-zh 轨）：
      // 从请求 url 反解 tlang/lang/kind 构造轨，push 进 cur.meta.captionTracks 让已到手的 body 入库不丢。
      let u;
      try { u = new URL(data.url, location.origin); } catch { return; }
      const tlang = u.searchParams.get("tlang"); // 翻译目标语言（有=翻译轨被动请求）
      const lang = u.searchParams.get("lang") || "";
      const kind = u.searchParams.get("kind"); // 'asr' 或 null
      const finalLang = tlang || lang || "unknown"; // 翻译轨优先 tlang 作 languageCode（翻译目标语言）
      const isTranslation = !!tlang;
      track = {
        baseUrl: data.url, // 完整请求 url（含 pot 签名）作 bodies key + source_url，保证 buildYoutubePayload 的 bodies[t.baseUrl] 命中
        languageCode: finalLang,
        kind: kind ?? null,
        name: isTranslation
          ? `${tlang === "zh-Hans" ? "中文" : tlang === "en" ? "英文" : tlang}（自动翻译）`
          : kind === "asr"
          ? `${lang || ""}（自动生成）`
          : (lang || "未知"),
        vssId: isTranslation ? `.${tlang}` : kind === "asr" ? `a.${lang || ""}` : `.${lang || ""}`,
        isTranslatable: false,
      };
      if (!tracks.some((t) => t.baseUrl === track.baseUrl)) {
        cur.meta.captionTracks = [...tracks, track]; // 动态增长源轨表，让 flushIfReady/getLocalState 见到该轨
        console.log(`[content-yt] TIMEDTEXT_BODY 兜底构造轨 vid=${vid} lang=${track.languageCode} kind=${track.kind ?? "null"}`);
      }
    }
    const normalized = normalizeYoutubeTimedtext(data.body, data.fmt);
    if (normalized?.body?.length > 0) {
      cur.bodies.set(track.baseUrl, normalized);
      console.log(`[content-yt] TIMEDTEXT_BODY vid=${vid} lang=${track.languageCode} cues=${normalized.body.length}`);
      flushIfReady(vid);
    } else {
      console.warn(`[content-yt] TIMEDTEXT_BODY 归一化后空 cues vid=${vid} lang=${track.languageCode}（pot 受限或无语音）`);
    }
  }
});

// 按 url 匹配 captionTracks 已入库轨：源轨按 lang+kind，翻译轨（带 tlang=）按 tlang。
// 翻译轨必须按 tlang 匹配——否则 lang=ko&tlang=zh-Hans 的翻译体会错配到 ko 源轨（翻译体存进源轨 baseUrl，覆盖原轨）。
// 匹配不到（源轨非可翻译、或翻译轨尚未入库）返 null，由 TIMEDTEXT_BODY 兜底构造轨。
function findTrackForUrl(tracks, url) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  let u;
  try { u = new URL(url, location.origin); } catch { return null; }
  const tlang = u.searchParams.get("tlang"); // 翻译目标语言（有=翻译轨请求）
  const kind = u.searchParams.get("kind"); // 'asr' 或 null
  if (tlang) {
    // 翻译轨：fetchSubtitleBodiesViaBg 构造的 translation 轨 languageCode=tlang、kind=null
    return tracks.find((t) => t.languageCode === tlang && (t.kind ?? null) === null) ?? null;
  }
  const lang = u.searchParams.get("lang");
  if (!lang) return null;
  return tracks.find((t) => t.languageCode === lang && (t.kind ?? null) === (kind ?? null)) ?? null;
}

// baseUrl 已含 fmt= 则不重复加，否则追加 &fmt=json3（spec §6 路径 B）。
function appendFmt(baseUrl, fmt) {
  if (!baseUrl) return baseUrl;
  if (/[?&]fmt=/.test(baseUrl)) return baseUrl;
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}fmt=${fmt}`;
}

// 自动翻译目标语言（YouTube timedtext &tlang= 服务端机翻）：中文 + 英文。
const TARGET_LANGS = ["zh-Hans", "en"];

// 语言粗匹配：zh-Hans/zh-Hant/zh-HK 都算中文；en-US/en-GB 都算英文。
function langIs(lang, target) {
  if (!lang) return false;
  if (target.startsWith("zh")) return lang.startsWith("zh");
  if (target === "en") return lang.startsWith("en");
  return lang === target;
}

// baseUrl 追加 &tlang=（翻译目标语言）；已含则不重复加。
function appendTlang(baseUrl, tlang) {
  if (!baseUrl) return baseUrl;
  if (/[?&]tlang=/.test(baseUrl)) return baseUrl;
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}tlang=${tlang}`;
}

// 单轨抓取：让 background（host_permissions 免 CORS）抓 fetchUrl 字幕体，归一化后存 body。
function fetchOneSubtitle(vid, track, fetchUrl) {
  const cur = collected.get(vid);
  if (!cur) return;
  const baseUrl = track.baseUrl;
  if (cur.bodies.has(baseUrl)) return; // 路径 A 已拦到，不重复
  if (cur.fetched.has(baseUrl)) return; // 已尝试过（避免重复请求）
  cur.fetched.add(baseUrl);
  const lang = track.languageCode;
  try {
    chrome.runtime.sendMessage({ type: "FETCH_SUBTITLE", url: fetchUrl }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn(`[content-yt] FETCH_SUBTITLE 失败 vid=${vid} lang=${lang} err=${chrome.runtime.lastError.message}`);
        flushIfReady(vid);
        return;
      }
      const c = collected.get(vid);
      if (!c) return;
      if (resp?.ok && resp.body) {
        const normalized = normalizeYoutubeTimedtext(resp.body, "json3");
        if (normalized?.body?.length > 0) {
          c.bodies.set(baseUrl, normalized);
          console.log(`[content-yt] background 抓到字幕体 vid=${vid} lang=${lang} cues=${normalized.body.length}`);
        } else {
          console.warn(`[content-yt] 字幕体空 cues vid=${vid} lang=${lang}（pot 受限或无语音）`);
        }
      } else {
        // 空 200（pot 受限）或 HTTP 错：该轨 body 空，靠路径 A 拦截补；两路径空则该轨跳过不上报（spec §7）。
        console.warn(`[content-yt] FETCH_SUBTITLE 返回失败 vid=${vid} lang=${lang} err=${resp?.error ?? "empty"}`);
      }
      flushIfReady(vid);
    });
  } catch (e) {
    console.warn(`[content-yt] FETCH_SUBTITLE 发送异常（扩展上下文可能已失效）vid=${vid} lang=${lang} err=${e?.message}`);
    flushIfReady(vid);
  }
}

// 路径 B：对每轨抓原字幕体；可翻译轨额外抓中文/英文翻译（tlang=），翻译轨构造加入 captionTracks 入 payload。
function fetchSubtitleBodiesViaBg(vid, tracks) {
  const cur = collected.get(vid);
  if (!cur) return;
  // 只 FETCH 原轨字幕体。翻译轨不主动 FETCH——避免频繁请求触发 YouTube 429 限流。
  // 翻译靠 triggerYtTranslation 点播放器菜单触发被动请求（带 pot），inject 拦 TIMEDTEXT_BODY 兜底入库。
  for (const t of tracks) {
    const baseUrl = t.baseUrl;
    if (!baseUrl) continue;
    fetchOneSubtitle(vid, t, appendFmt(baseUrl, "json3"));
  }
}

// 所有轨都已「定居」（有 body 或 FETCH_SUBTITLE 已尝试）后组装 payload 发 INGEST（spec §6）。
// force=true 透传 {force:true} 绕过上报开关（对齐 content.js flushIfReady 的 force 语义，供手动上报）。
function flushIfReady(vid, force = false) {
  const cur = collected.get(vid);
  if (!cur?.meta) return;
  const tracks = cur.meta.captionTracks ?? [];
  if (tracks.length === 0) return;
  // force 时立即 flush；否则等所有轨定居，避免过早 flush 漏轨（路径 A 后到的 body 会触发再 flush，server 去重）。
  if (!force && !tracks.every((t) => cur.bodies.has(t.baseUrl) || cur.fetched.has(t.baseUrl))) return;
  // 只含有 body 的轨（pot 全受限时为空 → 不上报脏数据，spec §7）。
  const tracksWithBody = tracks.filter((t) => cur.bodies.has(t.baseUrl));
  if (tracksWithBody.length === 0) {
    console.warn(`[content-yt] vid=${vid} 所有轨 body 为空（pot 受限？），跳过上报`);
    return;
  }
  const payload = buildYoutubePayload({
    videoId: cur.meta.videoId,
    title: cur.meta.title,
    channelId: cur.meta.channelId,
    channelName: cur.meta.channelName,
    duration: cur.meta.duration,
    captionTracks: tracksWithBody,
    bodies: Object.fromEntries(cur.bodies),
  });
  console.log(`[content-yt] INGEST vid=${vid} tracks=${payload.tracks.length}${force ? " force=true（绕过开关）" : ""}`);
  try {
    chrome.runtime.sendMessage({ type: "INGEST", payload, ...(force ? { force: true } : {}) });
  } catch (e) {
    console.warn(`[content-yt] INGEST 发送异常（扩展上下文可能已失效）vid=${vid} err=${e?.message}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // popup「已收集」直取 content-yt 内存（chrome.tabs.sendMessage → 当前 tab，不经 background）。
  // 回复结构对齐 content.js:191-205（bvid/extra/subs/bodies），popup useLocalCollected（hooks.ts:327-333）无需改解析。
  // track_type 用 kindToTrackType 映射成 1(asr)/2(人工)，与 INGEST 路径及 B 站 popup 展示一致。
  if (msg?.type === "RE_AGG") {
    // popup「手动上报」（MANUAL_CAPTURE → background RE_AGG）：force 重发当前页已采集的 YouTube 字幕。
    // 对齐 content.js RE_AGG 语义。vid 从 URL 取（watch?v=）；collected 已有该 vid 才 flush（否则不上报，让 popup 兜底超时）。
    const vid = new URL(location.href).searchParams.get('v');
    if (vid && collected.has(vid)) {
      flushIfReady(vid, true);
      sendResponse({ ok: true });
    } else {
      console.warn('[content-yt] RE_AGG 但当前页 vid 未采集', vid);
      sendResponse({ ok: false, err: '未采集到字幕' });
    }
    return false;
  }
  if (msg?.type === "GET_LOCAL_STATE") {
    // popup 发 {type:'GET_LOCAL_STATE', bvid}（hooks.ts:313）；兼容 vid，对齐 content.js:184。
    const vid = msg.vid ?? msg.bvid;
    const cur = vid ? collected.get(vid) : null;
    if (!cur?.meta) {
      sendResponse({ ok: true, state: "not-loaded" });
      return false;
    }
    const tracks = cur.meta.captionTracks ?? [];
    sendResponse({
      ok: true,
      state: tracks.length === 0 ? "no-subtitle" : "has-subtitle",
      bvid: vid,
      extra: {
        // YouTube 简介 + 统计：popup CollectedBlock 数据驱动渲染
        desc: cur.meta.shortDescription ?? null,
        stat: {
          view: cur.meta.viewCount ? Number(cur.meta.viewCount) : null,
          like: cur.meta.likeCount ? Number(cur.meta.likeCount) : null,
        },
      },
      subs: tracks.map((t) => ({
        lan: t.languageCode,
        lan_doc: t.name,
        track_type: kindToTrackType(t.kind),
        subtitle_url: t.baseUrl, // 对齐 content.js 的 subtitle_url
        url_missing: false,
        has_body: cur.bodies.has(t.baseUrl),
      })),
      bodies: Object.fromEntries(cur.bodies),
    });
    return false;
  }
  return false;
});

// 自动跳过 YouTube 广告：轮询检测"跳过广告"按钮，可见且可点就点击。
// .ytp-ad-skip-button 是 YouTube 专门的 skip button class，只在广告可跳过时出现
// （不需额外 ad-showing 判断——该 class 本身就是广告信号，不会误触非广告）。
function setupAdSkipper() {
  const sel = '.ytp-skip-ad-button';
  let pending = false; // 防重复调度（按钮持续可见时只触发一次延迟点）
  setInterval(() => {
    try {
      const btn = document.querySelector(sel);
      // 按钮出现（可见）后延迟 0.5-1.5s 点（用户要求）。倒计时未完 click 无效时，pending reset 后下轮自动重试直到可点生效。
      if (btn && btn.offsetParent !== null && !pending) {
        pending = true;
        // 按钮出现后等 0.5-1.5s 再点（让 5s 倒计时结束、按钮真正可点；大概率 0.5-1s 内生效）
        const delay = 500 + Math.random() * 1000;
        setTimeout(() => {
          pending = false;
          const b = document.querySelector(sel);
          if (b && b.offsetParent !== null) {
            try { b.click(); console.log('[content-yt] 自动跳过广告'); } catch {}
          }
        }, delay);
      }
    } catch {}
  }, 1000);
}
setupAdSkipper();
