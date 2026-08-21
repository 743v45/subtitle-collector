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
  const sel = '.ytp-subtitles-button, button[aria-label*="subtitles" i], button[aria-label*="字幕"], button[aria-label*="caption" i], button[title*="subtitles" i], button[title*="字幕"]' +
    ', button[aria-label*="utertexte" i], button[aria-label*="sous-titres" i], button[aria-label*="subtítulos" i], button[aria-label*="자막"]' +
    ', button[aria-label*="субтитры" i], button[aria-label*="sottotitoli" i], button[aria-label*="legendas" i]';
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

// 轮询等待选择器命中（菜单/按钮渲染延迟、其它扩展抢占的容错），返回 el 或 null（超时）
function waitForSelector(selector, timeoutMs = 5000, intervalMs = 200) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - t0 >= timeoutMs) return resolve(null);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// 轮询等待菜单项：matcher 为 RegExp（测 textContent）或函数（text=>bool）。返回 item 或 null（超时）
function waitForMenuItem(matcher, timeoutMs = 3000, intervalMs = 200) {
  const test = typeof matcher === 'function' ? matcher : (text) => matcher.test(text);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      for (const it of document.querySelectorAll('.ytp-menuitem')) {
        if (test(it.textContent || '')) return resolve(it);
      }
      if (Date.now() - t0 >= timeoutMs) return resolve(null);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// 打开字幕子菜单（齿轮 → 字幕项），返回是否就绪。用 waitFor 容错菜单渲染（替代固定 setTimeout）
async function openSubtitleMenu() {
  const gear = await waitForSelector('.ytp-settings-button');
  if (!gear) { console.warn('[content-yt] 菜单 齿轮未找到'); return false; }
  try { gear.click(); } catch (e) { console.warn('[content-yt] 点齿轮失败', e?.message); return false; }
  const sub = await waitForMenuItem(/^(字幕|subtitles?|caption|CC|utertexte|sous-titres|subtítulos|자막|субтитры|sottotitoli|legendas)/i);
  if (!sub) { console.warn('[content-yt] 菜单 字幕项未找到'); return false; }
  try { sub.click(); } catch { return false; }
  return true;
}

// 选原轨（切到原轨，触发原轨 timedtext 请求 → inject 拦 → 原轨 body，如英文）
// 原轨项：字幕菜单里不含「关闭/自动翻译/>>/选项」的语言项；优先含 langName（如"英语"），否则第一个语言项。
// 排除表覆盖中简繁/英/主流界面（關閉/自動翻譯/自動翻訳/off/options/translate 系），缺词即误点非语言项。
const NON_LANG_MENU_RE = /关闭|關閉|自动翻译|自動翻譯|自動翻訳|auto.?translat|translate|übersetzen|traducir|traduire|>>|选项|選項|options?|off\b/i;
async function selectOriginalTrack(langName) {
  if (!(await openSubtitleMenu())) return false;
  const isLang = (t) => !!t && !NON_LANG_MENU_RE.test(t) && (!langName || t.includes(langName));
  let item = langName ? await waitForMenuItem(isLang) : null;
  if (!item) item = await waitForMenuItem((t) => !!t && !NON_LANG_MENU_RE.test(t));
  if (!item) { console.warn('[content-yt] 原轨项未找到'); return false; }
  try { item.click(); console.log(`[content-yt] 选原轨: ${item.textContent.trim()}`); } catch { return false; }
  return true;
}

// 点翻译菜单选目标语言，触发播放器被动请求翻译 timedtext（带 pot，绕开 background FETCH pot 受限）
// async + waitFor：菜单渲染延迟/其它扩展（如沉浸式翻译）抢占时轮询等待，不再固定 600ms
async function triggerYtTranslation(targetLang) {
  let langRe;
  if (targetLang.startsWith("zh")) {
    langRe = /简体|簡體|simplified|中文/i;
  } else if (targetLang === "en") {
    langRe = /^english|英语|英文/i;
  } else {
    console.warn(`[content-yt] 翻译菜单不支持的目标语言 targetLang=${targetLang}`);
    return;
  }
  if (!(await openSubtitleMenu())) return;
  const auto = await waitForMenuItem(/auto.?translate|自动翻译|自動翻譯|自動翻訳|auto-trans|translate|übersetzen|traducir|traduire/i);
  if (!auto) { console.warn('[content-yt] 翻译菜单 自动翻译项未找到'); return; }
  try { auto.click(); } catch (e) { console.warn('[content-yt] 翻译菜单 点自动翻译项失败', e?.message); return; }
  const lang = await waitForMenuItem(langRe);
  if (!lang) { console.warn(`[content-yt] 翻译菜单 目标语言项未找到 targetLang=${targetLang}`); return; }
  try { lang.click(); console.log(`[content-yt] 翻译菜单 已选目标语言 targetLang=${targetLang}`); } catch (e) {
    console.warn(`[content-yt] 翻译菜单 选目标语言失败 targetLang=${targetLang}`, e?.message);
  }
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
    if (tracks.length === 0) {
      // captionTracks 空（纯音乐/直播/真无字幕；或 YT 偶发读不到 captionTracks 但播放器仍请求 timedtext）：
      // 元信息也要入库（0 轨 video 行——标题/频道/统计可查，任务卡 title 直出，对齐 B 站「仅元信息入库」
      // 展示语义）；不 FETCH。若播放器后续请求 timedtext，下方 TIMEDTEXT_BODY 兜底会构造轨，
      // flushIfReady 再发带轨 payload，server ingest 幂等补轨。popup 经 GET_LOCAL_STATE 见 no-subtitle。
      flushIfReady(vid);
      return;
    }
    // 路径 B（兜底，覆盖 ~96% 不需 pot 视频）：对每轨发 FETCH_SUBTITLE 让 background 免 CORS 抓 baseUrl+&fmt=json3。
    fetchSubtitleBodiesViaBg(vid, tracks);
    // 触发播放器请求各轨 timedtext（原轨 + 中文翻译），inject 拦截 → 双语 body。
    // guard：每视频一次；串行（CC 开字幕 → 选原轨英文 → 选翻译中文），中间留 800ms 让播放器发请求 + inject 拦截。
    if (!cur.menuTriggered) {
      cur.menuTriggered = true;
      setTimeout(async () => {
        triggerYtSubtitle(); // 点 CC 开字幕（兜底；selectOriginalTrack 也会开）
        await new Promise((r) => setTimeout(r, 800));
        await selectOriginalTrack(); // 选原轨（如英语）→ 原轨 body
        await new Promise((r) => setTimeout(r, 800));
        await triggerYtTranslation("zh-Hans"); // 选翻译 → 中文 body
      }, 2000);
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
// 0 轨（no-subtitle）与全轨无 body（pot 受限）不再整体跳过：上报 0 轨元信息 payload——
// videos 表入行（标题/频道/统计可查）；字幕后续到手（重试/翻译轨迟到/timedtext 兜底）时
// 再 flush 带轨 payload，server ingest 幂等 upsert 补轨（2026-08-22 决策：元信息不是脏数据）。
function flushIfReady(vid, force = false) {
  const cur = collected.get(vid);
  if (!cur?.meta) return;
  const tracks = cur.meta.captionTracks ?? [];
  // force 时立即 flush；否则等所有轨定居，避免过早 flush 漏轨（路径 A 后到的 body 会触发再 flush，server 去重）。
  // 0 轨天然定居（every 对空数组恒真），立即上报元信息。
  if (!force && tracks.length > 0 && !tracks.every((t) => cur.bodies.has(t.baseUrl) || cur.fetched.has(t.baseUrl))) return;
  // 只含有 body 的轨（受限轨无版本内容，不上报轨行；pot 全受限时为 0 轨 → 仅元信息入库）。
  const tracksWithBody = tracks.filter((t) => cur.bodies.has(t.baseUrl));
  if (tracksWithBody.length === 0) {
    console.warn(`[content-yt] vid=${vid} 全部 ${tracks.length} 轨 body 为空（pot 受限？）→ 上报 0 轨元信息（字幕到手后重 flush 补轨）`);
  }
  const payload = buildYoutubePayload({
    videoId: cur.meta.videoId,
    title: cur.meta.title,
    channelId: cur.meta.channelId,
    channelName: cur.meta.channelName,
    avatar: cur.meta.avatar,
    duration: cur.meta.duration,
    publishedAt: cur.meta.publishedAt,
    viewCount: cur.meta.viewCount,
    likeCount: cur.meta.likeCount,
    shortDescription: cur.meta.shortDescription,
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
      // settled：所有轨已定居（有 body 或 FETCH 已尝试）——与 flushIfReady 的判定同条件。
      // 供 fetch-youtube-subtitle 主动采集轮询判定「采集完成」（has-subtitle 只代表有轨,body 可能还在抓）。
      settled: tracks.every((t) => cur.bodies.has(t.baseUrl) || cur.fetched.has(t.baseUrl)),
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
