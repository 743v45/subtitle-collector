import { parseServerUrl, resolveActiveServer, normalizeServers, genServerId, SERVERS_KEY, ACTIVE_SERVER_KEY, DEFAULT_SERVER_URL, DEFAULT_SERVER_NAME } from "./servers.mjs";
import { shouldReport, genClientId, normalizeClientName, CLIENT_ID_KEY, CLIENT_NAME_KEY, REPORTING_KEY } from "./reporting.mjs";
import { shouldAcceptTasks, TASK_DISPATCH_KEY, TASK_DISPATCH_DISABLED_ERROR } from "./task-dispatch.mjs";
import { resolveConnectionMode, isStandalone, CONNECTION_MODE_KEY, MODE_SERVER, MODE_STANDALONE } from "./connection-mode.mjs";
import { extractKeysFromNav } from "./wbi.js";
import { biliFetch, formatSearchResult, fetchSubtitleView } from "./bili-fetch.js";
import { buildIngestPayload, normalizeUrl, normalizeTags } from "./ingest-payload.js";
import {
  parseYtChannelHtml, parseYtBrowseResponse, channelVideosUrl,
} from "./yt-channel.mjs";
import {
  runYtSearchAction, YT_INNERTUBE_KEY_FALLBACK, YT_CLIENT_VERSION_FALLBACK,
} from "./yt-search.mjs";
import { createPendingQueue } from "./pending-ingests.mjs";
import { pruneExpired } from "./storage-prune.mjs";
import { selectStaleFetches } from "./fetch-resume.mjs";
import { upperAllCacheHit } from "./upper-cache.mjs";
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
let reportingEnabled = true; // 内存态；启动从 storage 载入，默认 true（fail-open）
let taskDispatchEnabled = true; // 内存态；任务派发开关（false=仅上报状态），启动从 storage 载入，默认 true（fail-open）
let clientId = null;         // 内存态；启动载入或首次生成
let clientName = null;       // 内存态；客户端名字（popup 可改名，id 不变），启动从 storage 载入，null=未命名
let connectionMode = MODE_SERVER; // 内存态；启动载入，默认 server（向后兼容）。standalone=纯扩展：不连不上报
let activeServer = null;          // 内存态；当前激活 server 的解析结果（{wsUrl,httpBase,pingUrl,token}）。启动载入 / SET_ACTIVE_SERVER 切换
let activeServerId = null;        // 内存态；当前激活 server entry.id（WS_STATUS 回执、popup 乐观更新用）
let lastError = null;             // 内存态；最近连接失败原因（hello-nack error / 不可达 / 连接错误），WS_STATUS 透传给 UI
let authenticated = false;        // 内存态；hello-ack 后 true（鉴权通过才算"已连接"，防 WS OPEN 但未握手时误显已连接 → 跳变）
let authFailed = false;           // 内存态；hello-nack 后 true（永久错误，onclose 不自动重连，等手动重连/切 server）
// 重连间隔/开关：loadReconnectConfig 从 storage 覆盖（reconnect_base_ms/reconnect_max_ms/auto_reconnect）
let reconnectBaseMs = 2000;
let reconnectMaxMs = 10000;
let autoReconnect = true;

// Wbi img_key/sub_key 缓存（全站每日更替，进程内缓存，按需 refresh）
let wbiKeys = null;
let wbiKeysAt = 0;
const WBI_KEYS_TTL_MS = 60 * 60 * 1000; // 1 小时：B 站 wbi keys 每日更替，TTL 兜底防 stale
async function refreshWbiKeys() {
  const parsed = await biliFetch('/x/web-interface/nav');
  if (!parsed.ok) throw new Error('nav fetch failed: ' + (parsed.code ?? ''));
  wbiKeys = extractKeysFromNav(parsed);
  wbiKeysAt = Date.now();
  return wbiKeys;
}
async function ensureWbiKeys() {
  if (!wbiKeys || Date.now() - wbiKeysAt > WBI_KEYS_TTL_MS) await refreshWbiKeys();
}

// P4：被动采 UP 资料（7 天 TTL）。TTL 用 chrome.storage 持久（SW 重启不丢）。失败抛错由调用方 catch。
async function ensureUpperInfo(mid) {
  const key = `upperInfoAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 7 * 24 * 3600 * 1000) return; // 7 天内跳过
  await ensureWbiKeys();
  const infoRes = await biliFetch('/x/space/wbi/acc/info', { wbi: true, params: { mid }, wbiKeys });
  if (!infoRes.ok) throw new Error('acc/info ' + infoRes.code);
  const statRes = await biliFetch('/x/relation/stat', { params: { vmid: mid } });
  const stat = statRes.ok ? statRes.data : {};
  const info = infoRes.data;
  const creator = {
    source_uid: String(mid),
    name: info.name ?? null, avatar: info.face ?? null,
    sign: info.sign ?? null, level: info.level ?? null, sex: info.sex ?? null,
    official_type: info.official?.type ?? null, official_title: info.official?.title ?? null,
    fans: stat.follower ?? null, following: stat.following ?? null,
  };
  ws.send(JSON.stringify({ type: "ingest-upper", payload: { source: "bilibili", creator } }));
  await chrome.storage.local.set({ [key]: Date.now() });
}

// P4：被动采 UP 最新视频（1h TTL，chrome.storage 缓存，不入库）。失败抛错由调用方 catch。
async function ensureUpperVideos(mid) {
  const key = `upperVideosAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 3600 * 1000) return; // 1h 内跳过
  await ensureWbiKeys();
  const parsed = await biliFetch('/x/space/wbi/arc/search', { wbi: true, params: { mid, pn: 1, ps: 10, order: 'pubdate' }, wbiKeys });
  if (!parsed.ok) throw new Error('arc/search ' + parsed.code);
  const items = (parsed.data?.list?.vlist ?? []).map((v) => ({ bvid: v.bvid, title: v.title, created: v.created ?? null }));
  await chrome.storage.local.set({ [`upperVideos:${mid}`]: { items, fetchedAt: Date.now() }, [key]: Date.now() });
}

// ── UP 全部视频：全量分页拉取（popup 空间页/视频页触发，2026-08-19）──
// storage 是唯一数据真相：每页增量写 chrome.storage.local[`upperAllVideos:${mid}`]，popup 用
// storage.onChanged 渲染进度；SW 意外回收不丢已拉页（重开 popup 重触发续拉——从头拉，B 站侧幂等）。
// 风控中断保留已拉页 + error 标记（部分结果仍可勾选批量采集）。
const upperAllInflight = new Set(); // 正在全量拉取的 mid（重复触发复用同一任务）
const UPPER_ALL_TTL_MS = 3600 * 1000;
const UPPER_ALL_PAGE_GAP_MS = 500; // 页间节流防风控（-412）
const UPPER_ALL_PS = 30;           // arc/search 单页条数

async function fetchAllUpperVideos(mid, refresh = false) {
  const key = `upperAllVideos:${mid}`;
  if (!refresh) {
    const { [key]: cached } = await chrome.storage.local.get(key);
    // 缓存命中：完成 + 无错 + 1h 内（refresh=true 强制重拉，供 popup ↻ 按钮清旧缓存）
    if (cached?.fetchedAt && cached.done && !cached.error && Date.now() - cached.fetchedAt < UPPER_ALL_TTL_MS) {
      return { status: 'cached' };
    }
  }
  if (upperAllInflight.has(mid)) return { status: 'inflight' };
  upperAllInflight.add(mid);
  let items = [];
  const seen = new Set(); // bvid 去重：页间新投稿使分页位移重叠时防重复（重复 key 会打乱 popup 列表渲染）
  let total = 0;
  let error = null;
  let noNewStreak = 0; // 连续整页无新视频页数（≥3 判定分页停滞，终止保部分结果）
  try {
    for (let pn = 1; ; pn++) {
      await ensureWbiKeys();
      const parsed = await biliFetch('/x/space/wbi/arc/search', {
        wbi: true, params: { mid, pn, ps: UPPER_ALL_PS, order: 'pubdate' }, wbiKeys,
      });
      if (!parsed.ok) {
        error = 'arc/search ' + parsed.code + (items.length ? `（已拉 ${items.length}/${total}，中断）` : '');
        break;
      }
      const vlist = parsed.data?.list?.vlist ?? [];
      total = parsed.data?.page?.count ?? items.length + vlist.length;
      let added = 0;
      for (const v of vlist) {
        if (!v?.bvid || seen.has(v.bvid)) continue;
        seen.add(v.bvid);
        added++;
        items.push({
          bvid: v.bvid, title: v.title, created: v.created ?? null,
          play: v.play ?? null, length: v.length ?? null,
          // 封面预览：pic 常为 "//i2.hdslb.com/..." 协议头相对形式，归一 https:
          pic: typeof v.pic === 'string' ? (v.pic.startsWith('//') ? 'https:' + v.pic : v.pic) : null,
        });
      }
      // 每页落盘：popup 实时进度 + SW 回收兜底
      await chrome.storage.local.set({ [key]: { items, total, done: false, error: null, fetchedAt: Date.now() } });
      if (vlist.length === 0 || items.length >= total) break;
      noNewStreak = added > 0 ? 0 : noNewStreak + 1;
      if (noNewStreak >= 3) break;
      await new Promise((r) => setTimeout(r, UPPER_ALL_PAGE_GAP_MS));
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  await chrome.storage.local.set({ [key]: { items, total, done: true, error, fetchedAt: Date.now() } });
  upperAllInflight.delete(mid);
  // 同前缀过期缓存淘汰（done 且超 TTL，见 storage-prune.mjs）：防只写不删涨满配额，
  // 配额耗尽 set 静默失败会连带废掉「每页落盘 + SW 回收兜底」的长任务恢复。清理失败不影响本任务结果。
  pruneExpired(chrome.storage.local, 'upperAllVideos:', UPPER_ALL_TTL_MS)
    .catch((e) => console.warn('[background] upperAllVideos 过期清理失败', String(e?.message ?? e)));
  return { status: 'done', error };
}

// ── 合集（ugc_season）视频：全量分页拉取（popup 合集卡触发，2026-08-19）──
// 对齐 fetchAllUpperVideos 模式：storage 唯一真相 + 页间节流 + 中断保部分结果。
// API：/x/polymer/web-space/seasons_archives_list（免 wbi 签名，season_id 单独可用——纯扩展模式也能拉）。
// item 字段对齐 UpperAllVideoItem（length 从 duration 秒转 "M:SS"，复用 popup 行渲染）。
const seasonAllInflight = new Set(); // 正在全量拉取的 seasonId（重复触发复用同一任务）
const SEASON_ALL_TTL_MS = 3600 * 1000;
const SEASON_ALL_PAGE_GAP_MS = 500; // 页间节流防风控（-412）
const SEASON_ALL_PS = 30;           // seasons_archives_list 单页条数

async function fetchAllSeasonVideos(seasonId, refresh = false) {
  const key = `seasonVideos:${seasonId}`;
  if (!refresh) {
    const { [key]: cached } = await chrome.storage.local.get(key);
    if (cached?.fetchedAt && cached.done && !cached.error && Date.now() - cached.fetchedAt < SEASON_ALL_TTL_MS) {
      return { status: 'cached' };
    }
  }
  if (seasonAllInflight.has(seasonId)) return { status: 'inflight' };
  seasonAllInflight.add(seasonId);
  const items = [];
  const seen = new Set(); // bvid 去重（合集追加投稿使分页位移重叠时防重复）
  let total = 0;
  let error = null;
  let noNewStreak = 0; // 连续整页无新条目页数（≥3 判定分页停滞，终止保部分结果）
  try {
    for (let pageNum = 1; ; pageNum++) {
      const parsed = await biliFetch('/x/polymer/web-space/seasons_archives_list', {
        params: { season_id: seasonId, sort_reverse: false, page_num: pageNum, page_size: SEASON_ALL_PS },
      });
      if (!parsed.ok) {
        error = 'seasons_archives_list ' + parsed.code + (items.length ? `（已拉 ${items.length}/${total}，中断）` : '');
        break;
      }
      const archives = parsed.data?.archives ?? [];
      total = parsed.data?.page?.total ?? items.length + archives.length;
      let added = 0;
      for (const a of archives) {
        if (!a?.bvid || seen.has(a.bvid)) continue;
        seen.add(a.bvid);
        added++;
        items.push({
          bvid: a.bvid, title: a.title, created: a.pubdate ?? null,
          play: a.stat?.view ?? null,
          // duration 秒 → "M:SS"（对齐 UP 卡 length 渲染；超 1 小时 "H:MM:SS"）
          length: typeof a.duration === 'number' && a.duration >= 0 ? fmtLength(a.duration) : null,
          pic: typeof a.pic === 'string' ? (a.pic.startsWith('//') ? 'https:' + a.pic : a.pic) : null,
        });
      }
      // 每页落盘：popup 实时进度 + SW 回收兜底
      await chrome.storage.local.set({ [key]: { items, total, done: false, error: null, fetchedAt: Date.now() } });
      if (archives.length === 0 || items.length >= total) break;
      noNewStreak = added > 0 ? 0 : noNewStreak + 1;
      if (noNewStreak >= 3) break;
      await new Promise((r) => setTimeout(r, SEASON_ALL_PAGE_GAP_MS));
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  await chrome.storage.local.set({ [key]: { items, total, done: true, error, fetchedAt: Date.now() } });
  seasonAllInflight.delete(seasonId);
  // 同前缀过期缓存淘汰（同 fetchAllUpperVideos 尾部的防配额涨满策略）
  pruneExpired(chrome.storage.local, 'seasonVideos:', SEASON_ALL_TTL_MS)
    .catch((e) => console.warn('[background] seasonVideos 过期清理失败', String(e?.message ?? e)));
  return { status: 'done', error };
}

// duration 秒 → "M:SS" / "H:MM:SS"（与 B 站 arc/search 的 length 字段同构）
function fmtLength(sec) {
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ── YouTube 频道（UP 主页）视频：全量分页拉取（2026-08-21）──
// 对齐 fetchAllUpperVideos 模式：storage 唯一真相 + 页间节流 + 去重 + 中断保部分结果。
// 数据源：频道 /videos tab SSR HTML（ytInitialData，首页 ~30 条 + continuation token）
//   + InnerTube POST /youtubei/v1/browse（续页）。2026-08 实测条目为 lockupViewModel（非旧 videoRenderer）。
// ident 三选一：{handle:'@xxx'} | {channelId:'UCxxx'} | {custom:'xxx'}（/c/、/user/ 旧式）。
// 解析全部宽容降级（yt-channel.mjs），结构变化时 error 透传 UI。
const ytChannelInflight = new Map(); // storage key → true（重复触发复用同一任务）
const YT_CHANNEL_TTL_MS = 3600 * 1000;
const YT_CHANNEL_PAGE_GAP_MS = 500; // 页间节流防风控

function ytChannelKey(ident) {
  return `ytChannelVideos:${ident.channelId ?? ident.handle ?? ident.custom}`;
}

// YouTube 页面 HTML 拉取（yt-search action 首页依赖；SSR HTML 请求不受 InnerTube Origin 校验，
// background 直拉即可）。UA 对齐页面请求，Accept-Language 英文（相对时间/计数文本按英文解析优先）。
async function ytFetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': navigator.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  return { status: res.status, text: res.ok ? await res.text() : null };
}

// 续页经页面运行时（2026-08-21 修 browse 403）：MV3 SW 跨源 POST 自动带
// Origin: chrome-extension://…（浏览器强制，header 盖不掉），YouTube InnerTube 对该 Origin 403；
// 页面 tab 上下文 fetch 的 Origin 是 youtube.com → 200。对齐 collectYoutubeViaNavigate 先例
//（YouTube 字幕 URL 同理必须靠页面运行时）。func 经 executeScript 序列化注入，args 传参，不能引外部闭包。
// endpoint ∈ 'browse' | 'search'（频道续页 / 搜索续页同一 InnerTube 通道，2026-08-24 搜索复用参数化）。
async function ytInnertubeViaTab(tabId, endpoint, inntertubeKey, clientVersion, token) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (ep, key, ver, tok) => {
      const r = await fetch(`https://www.youtube.com/youtubei/v1/${ep}?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'en', gl: 'US' } },
          continuation: tok,
        }),
      });
      const json = await r.json().catch(() => null);
      return { status: r.status, json };
    },
    args: [endpoint, inntertubeKey, clientVersion, token],
  });
  return res?.result ?? { status: 0, json: null };
}

// 拉取期间确保有一个 youtube.com tab：优先复用已开的（用户就在频道页/看 YouTube 时零感知）；
// 没有则后台开一个（active:false），由调用方在拉完后关闭（返回 opened 标记）。
async function ensureYoutubeTab(url) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  // 优先复用非活跃 tab：注入 executeScript 本不打断浏览，但仍不去寄生用户正在看的 tab
  const existing = tabs.find((t) => !t.active) ?? tabs[0];
  if (existing?.id) return { tabId: existing.id, opened: false };
  const tab = await chrome.tabs.create({ url: url ?? 'https://www.youtube.com/', active: false });
  // 等页面基本就绪（首个 executeScript 太早可能撞导航中——executeScript 自带等待，留 300ms 缓冲）
  await new Promise((r) => setTimeout(r, 300));
  return { tabId: tab.id, opened: true };
}

async function fetchAllYtChannelVideos(ident, refresh = false) {
  const key = ytChannelKey(ident);
  if (!refresh) {
    const { [key]: cached } = await chrome.storage.local.get(key);
    if (cached?.fetchedAt && cached.done && !cached.error && Date.now() - cached.fetchedAt < YT_CHANNEL_TTL_MS) {
      return { status: 'cached' };
    }
  }
  if (ytChannelInflight.has(key)) return { status: 'inflight' };
  ytChannelInflight.set(key, true);
  const url = channelVideosUrl(ident);
  const items = [];
  const seen = new Set(); // vid 去重
  let channelId = null;
  let channelName = null;
  let total = null;
  let error = null;
  let noNewStreak = 0;
  const persist = (done, err) => chrome.storage.local.set({
    [key]: { channelId, channelName, items, total, done, error: err, fetchedAt: Date.now() },
  });
  let ytTab = null; // 自建的后台 tab（拉完关；复用用户 tab 不关）
  try {
    if (!url) throw new Error('ident 需 handle/channelId/custom 至少其一');
    // 首页：SSR HTML 解析（HTML 请求不受 InnerTube Origin 校验，仍走 background fetch）
    const htmlRes = await fetch(url, {
      headers: { 'User-Agent': navigator.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!htmlRes.ok) throw new Error(`channel page HTTP ${htmlRes.status}`);
    const first = parseYtChannelHtml(await htmlRes.text());
    channelId = first.channelId;
    channelName = first.channelName;
    total = first.total;
    const inntertubeKey = first.inntertubeKey || YT_INNERTUBE_KEY_FALLBACK;
    const clientVersion = first.clientVersion || YT_CLIENT_VERSION_FALLBACK;
    for (const it of first.items) {
      if (!seen.has(it.vid)) { seen.add(it.vid); items.push(it); }
    }
    await persist(false, null);
    // 续页：InnerTube browse 经页面 tab 执行（见 ytBrowseViaTab 注释），直到无 token
    let token = first.continuation;
    while (token) {
      if (!ytTab) ytTab = await ensureYoutubeTab(url);
      const page = await ytInnertubeViaTab(ytTab.tabId, 'browse', inntertubeKey, clientVersion, token);
      if (page.status !== 200 || !page.json) throw new Error(`browse HTTP ${page.status || 'parse'}`);
      const parsed = parseYtBrowseResponse(page.json);
      let added = 0;
      for (const it of parsed.items) {
        if (!seen.has(it.vid)) { seen.add(it.vid); items.push(it); added++; }
      }
      await persist(false, null);
      token = parsed.continuation;
      if (total > 0 && items.length >= total) break;
      noNewStreak = added > 0 ? 0 : noNewStreak + 1;
      if (noNewStreak >= 3) break;
      await new Promise((r) => setTimeout(r, YT_CHANNEL_PAGE_GAP_MS));
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  if (ytTab?.opened) { try { await chrome.tabs.remove(ytTab.tabId); } catch {} }
  await persist(true, error);
  ytChannelInflight.delete(key);
  // 同前缀过期缓存淘汰（同 fetchAllUpperVideos 尾部的防配额涨满策略）
  pruneExpired(chrome.storage.local, 'ytChannelVideos:', YT_CHANNEL_TTL_MS)
    .catch((e) => console.warn('[background] ytChannelVideos 过期清理失败', String(e?.message ?? e)));
  return { status: 'done', error };
}

// MV3 SW 保活兜底：周期 alarm 唤醒 SW，若 ws 未 OPEN 则触发重连（C1）
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "keepalive") return;
  // 纯扩展模式：不自发重连（用户主动断开，alarm 唤醒也不连）
  if (ws?.readyState !== WebSocket.OPEN && !isStandalone(connectionMode)) connect();
  // 长任务恢复与连接无关（popup/CLI 两入口都受益），standalone 也扫
  resumeStaleFetches().catch((e) => console.warn('[background] 长任务恢复扫描失败', String(e?.message ?? e)));
});

// MV3 长任务恢复：任务态（inflight）在 SW 内存、数据态在 storage，SW 中途被杀后 storage 残留
// {done:false} 永久中间态——popup 触发的任务重开 popup 会续拉，CLI 经 WS 触发的（list-yt-channel-videos）
// 无人重触发，部分结果没有消费者。周期扫描宽限期（5min，见 fetch-resume.mjs）外的 done:false 键
// 重新触发对应拉取：inflight 互斥防重复（本 SW 内存里还在跑的不会被重启），重拉从头、数据侧幂等。
// 最小实现只覆盖 ytChannelVideos / upperAllVideos 两个前缀。
const RESUME_PREFIXES = ['ytChannelVideos:', 'upperAllVideos:'];
async function resumeStaleFetches() {
  const all = await chrome.storage.local.get(null);
  const stale = selectStaleFetches(all, RESUME_PREFIXES);
  for (const { key, prefix, id } of stale) {
    if (prefix === 'ytChannelVideos:') {
      // ident 还原：优先存储里的 channelId（首页解析即有、最稳）；无则按 key 形态兜底
      // （key = channelId ?? handle ?? custom，对齐 ytChannelKey 的取值顺序）
      const v = all[key];
      const ident = (typeof v?.channelId === 'string' && v.channelId) ? { channelId: v.channelId }
        : (/^UC[\w-]{22}$/.test(id) ? { channelId: id } : (id.startsWith('@') ? { handle: id } : { custom: id }));
      console.log(`[background] 恢复中断的 YT 频道拉取 key=${key}`);
      fetchAllYtChannelVideos(ident).catch((e) => console.warn('[background] 恢复拉取失败', String(e?.message ?? e)));
    } else {
      console.log(`[background] 恢复中断的 UP 视频拉取 mid=${id}`);
      fetchAllUpperVideos(id).catch((e) => console.warn('[background] 恢复拉取失败', String(e?.message ?? e)));
    }
  }
}

// 启动载入持久态：clientId（无则生成并回写）、clientName（null=未命名）、reportingEnabled（默认 true）、connectionMode（默认 server）、taskDispatchEnabled（默认 true）
async function loadPersistedState() {
  // 旧版整表 pendingIngests 数组 → 逐键队列（升级瞬间不丢已离线暂存的 payload）
  await ingestQueue.migrateLegacy();
  const items = await chrome.storage.local.get([CLIENT_ID_KEY, CLIENT_NAME_KEY, REPORTING_KEY, TASK_DISPATCH_KEY, CONNECTION_MODE_KEY, SERVERS_KEY, ACTIVE_SERVER_KEY]);
  if (items[CLIENT_ID_KEY]) {
    clientId = items[CLIENT_ID_KEY];
  } else {
    clientId = genClientId();
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
  }
  clientName = normalizeClientName(items[CLIENT_NAME_KEY]); // undefined/null/旧脏值 → null
  reportingEnabled = shouldReport(items[REPORTING_KEY]); // undefined → true
  taskDispatchEnabled = shouldAcceptTasks(items[TASK_DISPATCH_KEY]); // undefined → true
  connectionMode = resolveConnectionMode(items[CONNECTION_MODE_KEY]); // undefined → server
  // servers：旧版/首装无 → 初始化内置「本地 collector」（DEFAULT_SERVER_URL，行为同旧版连 127.0.0.1:21527）
  let servers = normalizeServers(items[SERVERS_KEY]);
  let activeId = typeof items[ACTIVE_SERVER_KEY] === 'string' ? items[ACTIVE_SERVER_KEY] : null;
  if (servers.length === 0) {
    const def = { id: genServerId(), name: DEFAULT_SERVER_NAME, url: DEFAULT_SERVER_URL };
    servers = [def];
    activeId = def.id;
    await chrome.storage.local.set({ [SERVERS_KEY]: servers, [ACTIVE_SERVER_KEY]: activeId });
  }
  const entry = resolveActiveServer(servers, activeId);
  activeServerId = entry?.id ?? null;
  activeServer = entry ? parseServerUrl(entry.url) : null;
}

// 统一更新开关：内存 + storage
async function applyReporting(enabled) {
  reportingEnabled = enabled === true;
  await chrome.storage.local.set({ [REPORTING_KEY]: reportingEnabled });
  return reportingEnabled;
}

// 统一更新任务派发开关（仅上报状态）：内存 + storage（对齐 applyReporting）
async function applyTaskDispatch(enabled) {
  taskDispatchEnabled = enabled === true;
  await chrome.storage.local.set({ [TASK_DISPATCH_KEY]: taskDispatchEnabled });
  return taskDispatchEnabled;
}

// 统一更新连接模式：内存 + storage（归一后落盘，防脏值）。不在此处切连/断连——由 SET_CONNECTION_MODE 调用方按返回值决定。
async function applyConnectionMode(mode) {
  connectionMode = resolveConnectionMode(mode);
  await chrome.storage.local.set({ [CONNECTION_MODE_KEY]: connectionMode });
  return connectionMode;
}

async function probeServer() {
  const pingUrl = activeServer?.pingUrl;
  if (!pingUrl) return false; // 无 server 配置（connect 已守卫 activeServer.wsUrl），双保险
  try {
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

function scheduleReconnect() {
  // 纯扩展模式：用户主动断开，不重连（覆盖 onclose→scheduleReconnect 路径）
  if (isStandalone(connectionMode)) return;
  if (!autoReconnect) { console.log('[background] 自动重连已关（auto_reconnect=false），等手动重连'); return; }
  reconnectAttempts++;
  const delay = Math.min(reconnectBaseMs * Math.pow(2, reconnectAttempts - 1), reconnectMaxMs);
  setTimeout(connect, delay);
}

// server 推送/本地事件 → 扩展页面（popup/options）广播。popup 关闭是常态：
// callback 形态 + 读取 lastError 吞掉「无接收端」报错，避免 unchecked send。
function notifyUI(msg) {
  chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
}

async function connect() {
  if (isStandalone(connectionMode)) return; // 纯扩展模式：不连 server
  if (!activeServer?.wsUrl) return;          // 无 server 配置：不连（SET_ACTIVE_SERVER 切到空列表时停连）
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!(await probeServer())) { lastError = "server 不可达（ping 失败）"; scheduleReconnect(); return; }
  authenticated = false; // 新连接：未握手
  authFailed = false;
  try {
    ws = new WebSocket(activeServer.wsUrl);
  } catch { scheduleReconnect(); return; }
  ws.onopen = () => {
    reconnectAttempts = 0;
    // token 可选（server 端可不要 token）：有则放 hello（兼容 server 从 hello body 取 token）；
    // wsUrl 原样含 ?token= query，兼容 server 从握手 URL 取 token——双兼容。
    const hello = { type: "hello", ext_version: EXT_VERSION, client_id: clientId, client_name: clientName, reporting_enabled: reportingEnabled, task_dispatch_enabled: taskDispatchEnabled };
    if (activeServer.token) hello.token = activeServer.token;
    ws.send(JSON.stringify(hello));
    // flushPendingIngests 移到 hello-ack：鉴权通过后才补发（未握手发 ingest 会被 server 丢，server.ts:44 守卫）
  };
  ws.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    // 无 id 的服务端推送（ingest-ack / hello-ack / hello-nack / task-update / task-delete）须在 id 守卫前消费
    if (msg.type === "ingest-ack") {
      if (msg.ok === false) {
        console.log(`[background] 上报失败 source_vid=${msg.source_vid}`);
      } else {
        console.log(`[background] 上报完成 source_vid=${msg.source_vid} 新增 ${msg.inserted_tracks} 条版本 / 跳过 ${msg.skipped_tracks} 条（已存在）`);
      }
      notifyUI({ type: "INGEST_RESULT", ok: msg.ok !== false, source_vid: msg.source_vid, inserted: msg.inserted_tracks, skipped: msg.skipped_tracks });
      return;
    }
    // 任务状态推送（server 落库后广播）：原样转发给 popup 进度卡（TASK_UPDATE upsert / TASK_DELETE 移除）。
    // 旧 server 不发这两类消息，新分支静默待命；popup 关闭时 notifyUI 自吞无接收端。
    if (msg.type === "task-update") {
      notifyUI({ type: "TASK_UPDATE", task: msg.task });
      return;
    }
    if (msg.type === "task-delete") {
      // server 载荷为 {type:'task-delete', taskId}（2026-08-21 去掉顶层 id；旧 server 无此推送）
      notifyUI({ type: "TASK_DELETE", taskId: msg.taskId });
      return;
    }
    if (msg.type === "hello-ack") {
      authenticated = true; // 鉴权通过，才算"已连接"
      authFailed = false;
      lastError = null; // 握手成功，清错误
      console.log(`[background] 握手结果 type=hello-ack`);
      flushPendingIngests(); // 鉴权通过后才补发离线期间的 ingest
      return;
    }
    if (msg.type === "hello-nack") {
      authFailed = true; // 永久错误（bad token 等），onclose 不自动重连，等用户改 token 手动重连
      authenticated = false;
      lastError = msg.error || "握手被拒"; // 透传 server 拒绝原因（如 bad token）给 UI
      console.log(`[background] 握手结果 type=hello-nack error=${lastError}`);
      return;
    }
    if (!msg.id) return;
    try {
      if (msg.action === "navigate") {
        await chrome.tabs.create({ url: msg.url });
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { opened: true } }));
      } else if (msg.action === "operate") {
        // 只找 B 站视频页（manifest content_scripts matches 决定哪些 tab 注入了 content.js）
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: ["*://www.bilibili.com/video/*", "*://www.bilibili.com/list/*"] });
        if (!tab?.id) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "当前活跃 tab 非 B 站视频页，无法执行 operate" }));
          return;
        }
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "OPERATE", op: msg.op });
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: resp?.ok !== false, data: resp }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "content script 通信失败: " + (err.message || err) }));
        }
      } else if (msg.action === "search") {
        try {
          await ensureWbiKeys();
          const parsed = await biliFetch('/x/web-interface/wbi/search/type', {
            wbi: true,
            params: {
              search_type: 'video',
              keyword: msg.keyword,
              page: msg.page ?? 1,
              order: msg.order ?? 'pubdate',
              ...(msg.tid ? { tid: msg.tid } : {}),
            },
            wbiKeys,
          });
          if (!parsed.ok) {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: parsed.code }));
          } else {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: formatSearchResult(parsed.data) }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "fetch-subtitle") {
        // 仅上报状态防御：本机开关本机说了算——旧 server 不识别 hello 新字段照派 / 旁路派发时按此回执
        if (!taskDispatchEnabled) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: TASK_DISPATCH_DISABLED_ERROR }));
          return;
        }
        const vidKey = `bilibili:${msg.bvid}`;
        if (inFlightCollects.has(vidKey)) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "duplicate in-flight: 同视频采集正在执行" }));
          return;
        }
        inFlightCollects.add(vidKey);
        try {
          const bvid = msg.bvid;
          // 1. view：完整元信息（标题/UP owner/stat/tags/pages/desc，组装 extra）
          const viewRes = await biliFetch('/x/web-interface/view', { params: { bvid } });
          if (!viewRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: viewRes.code })); return; }
          const view = viewRes.data;
          // 1.5. 标签：/x/tag/archive/tags（免 wbi 签名，GET ?aid=）。view 响应无 tags 数组，须单独抓。
          //       失败（404/风控/网络）绝不阻断主字幕采集——try/catch 吞掉，tags 保持 []。
          let tags = [];
          try {
            const tagRes = await biliFetch('/x/tag/archive/tags', { params: { aid: view.aid } });
            if (tagRes.ok) tags = normalizeTags(tagRes.data);
            else console.warn(`[background] fetch-subtitle 标签接口失败 aid=${view.aid} code=${tagRes.code}`);
          } catch (e) {
            console.warn(`[background] fetch-subtitle 标签接口异常 aid=${view.aid}`, String(e?.message ?? e));
          }
          // 2. player/wbi/v2：字幕轨
          await ensureWbiKeys();
          const playerRes = await biliFetch('/x/player/wbi/v2', { wbi: true, params: { bvid, aid: view.aid, cid: view.cid }, wbiKeys });
          if (!playerRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: playerRes.code })); return; }
          const pData = playerRes.data ?? {};
          // 2.5 AI 字幕独立接口 /x/v2/subtitle/web/view：新版播放器把 AI 字幕移到这里（player/wbi/v2 只剩 CC 字幕）。
          //     充电专属等「只有 AI 字幕、无 CC」的视频，player/wbi/v2 的 subtitles 为空，必须补这个接口才采得到。
          const aiSubs = await fetchSubtitleView(view.cid, view.aid);
          // 合并 CC（player/wbi/v2）+ AI（subtitle/web/view），按 subtitle_url 去重
          const seenUrl = new Set();
          const subs = [...(pData.subtitle?.subtitles ?? []), ...aiSubs].filter((s) => {
            const u = normalizeUrl(s.subtitle_url);
            if (!u || seenUrl.has(u)) return false;
            seenUrl.add(u); return true;
          });
          // 付费/充电标志（写 extra.paid，供 server 落独立列 + CLI --paid 过滤）
          const elecType = pData.elec_high_level?.privilege_type ?? null;
          const isPaid = !!(pData.is_upower_exclusive || pData.is_ugc_pay_preview || elecType || view.rights?.pay || view.rights?.ugc_pay || view.rights?.arc_pay);
          const paidInfo = isPaid ? {
            is_upower_exclusive: pData.is_upower_exclusive ?? false,
            is_ugc_pay_preview: pData.is_ugc_pay_preview ?? false,
            elec_privilege_type: elecType,
          } : null;
          // 3. 字幕体：fetch 用 normalize 后的 url，bodies key 也用 normalize 后的 url（对齐 ingest-payload.js 的 normalizeUrl 查找）
          const bodies = {};
          for (const s of subs) {
            const url = normalizeUrl(s.subtitle_url);
            if (!url) continue;
            try {
              const r = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
              if (!r.ok) { console.warn(`[background] fetch-subtitle 字幕体 HTTP ${r.status} bvid=${msg.bvid} url=${url}`); continue; }
              const body = await r.json().catch(() => null);
              if (body) bodies[url] = body;
              else console.warn(`[background] fetch-subtitle 字幕体 JSON 解析失败 bvid=${msg.bvid} url=${url}`);
            } catch (e) {
              // 单轨字幕体抓取失败（如加密 URL Chrome 拒绝 fetch）不阻断其它轨 + 主流程
              console.warn(`[background] fetch-subtitle 字幕体抓取异常 bvid=${msg.bvid} url=${url} err=${String(e?.message ?? e)}`);
            }
          }
          // 4. 过滤字幕体抓取失败的轨，避免 payload:null 入库污染 external 去重
          const validSubs = subs.filter((s) => {
            const u = normalizeUrl(s.subtitle_url);
            return u && bodies[u] != null;
          });
          if (validSubs.length > 0) {
            // 有字幕（普通视频 CC / AI 明文）：直接入库
            sendIngest(buildIngestPayload(view, validSubs, bodies, tags, paidInfo));
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { bvid, tracks: validSubs.length, ai_tracks: aiSubs.length, ingested: true, ...(isPaid ? { paid: true } : {}) },
            }));
          } else if (isPaid) {
            // 充电视频字幕加密（%00，Chrome 拒 fetch），API 拿不到 → navigate 打开页面，
            // 复用被动采集链路（content 自动点 AI 字幕 → inject 拦明文 aisubtitle → INGEST）。频率可控（锁+间隔）。
            sendIngest(buildIngestPayload(view, [], {}, tags, paidInfo)); // video 行先入库（含 paid 标记）
            const ok = await collectViaNavigate(bvid, 20000);
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { bvid, tracks: ok ? 1 : 0, ai_tracks: aiSubs.length, ingested: true, paid: true, navigated: true, ...(ok ? {} : { reason: 'no_subtitle' }) },
            }));
          } else {
            // 真无字幕：video 入库（避免重采），无轨
            sendIngest(buildIngestPayload(view, [], {}, tags, paidInfo));
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { bvid, tracks: 0, ai_tracks: aiSubs.length, ingested: true, reason: 'no_subtitle' },
            }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        } finally {
          inFlightCollects.delete(vidKey);
        }
      } else if (msg.action === "fetch-youtube-subtitle") {
        // 仅上报状态防御（同 fetch-subtitle）：拒绝后任务落 failed，error 文案指向开关而非重试
        if (!taskDispatchEnabled) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: TASK_DISPATCH_DISABLED_ERROR }));
          return;
        }
        // YouTube 主动采集（手机/网页任务驱动）：导航到视频页,复用 content-yt 被动采集链路
        // （inject-yt 读 captionTracks + 拦 timedtext → content-yt 归一化 → INGEST 入库）,
        // 编排层只负责「导航 + 等就绪 + 等采集完成 + 汇总回执」。
        const ytKey = `youtube:${msg.videoId}`;
        if (inFlightCollects.has(ytKey)) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "duplicate in-flight: 同视频采集正在执行" }));
          return;
        }
        inFlightCollects.add(ytKey);
        try {
          // msg.id（server 命令 id）透传作 taskId，供 [yt-navigate] 日志与 server 任务关联
          // 无进展窗口可配：server 派发时随 msg.timeout_ms 下发（settings.collect_timeout_ms,
          // 慢视频轨加载极慢时调大）；popup 直采/旧 server 不带该字段回落内置 45s
          const windowMs = Number.isInteger(msg.timeout_ms) && msg.timeout_ms >= 15000 ? msg.timeout_ms : 45000;
          const data = await collectYoutubeViaNavigate(msg.videoId, windowMs, msg.id);
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        } finally {
          inFlightCollects.delete(ytKey);
        }
      } else if (msg.action === "get-upper-info") {
        try {
          await ensureWbiKeys();
          const mid = msg.mid;
          // 1. acc/info（Wbi）：name/sign/level/sex/official/face
          const infoRes = await biliFetch('/x/space/wbi/acc/info', { wbi: true, params: { mid }, wbiKeys });
          if (!infoRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: infoRes.code })); return; }
          const info = infoRes.data;
          // 2. relation/stat（cookie）：follower/following
          const statRes = await biliFetch('/x/relation/stat', { params: { vmid: mid } });
          const statFailed = !statRes.ok;
          const stat = statRes.ok ? statRes.data : {};
          // 3. 上报 ingest-upper（入库 creators）
          const creator = {
            source_uid: String(mid),
            name: info.name ?? null,
            avatar: info.face ?? null,
            sign: info.sign ?? null,
            level: info.level ?? null,
            sex: info.sex ?? null,
            official_type: info.official?.type ?? null,
            official_title: info.official?.title ?? null,
            fans: stat.follower ?? null,
            following: stat.following ?? null,
          };
          ws.send(JSON.stringify({ type: "ingest-upper", payload: { source: "bilibili", creator } }));
          // 4. 回执
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { mid, ...creator, stat_failed: statFailed } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "list-upper-videos") {
        // 缓存复用（忽略 page/page_size）：popup 全量任务（fetchAllUpperVideos）拉完的完整结果
        // 在 TTL 内直接回执，免去 server expandUpperVideos / CLI collectUpperVideosAll 经此路径
        // 逐页全量重拉（分钟级 + 页间节流防风控）；total 对齐 items.length，翻页方第一页
        // items.length >= total 即自然终止。未命中/过期/中断（error）才走下面的单页实拉。
        try {
          const cacheKey = `upperAllVideos:${msg.mid}`;
          const { [cacheKey]: cached } = await chrome.storage.local.get(cacheKey);
          const hit = upperAllCacheHit(cached, UPPER_ALL_TTL_MS);
          if (hit) {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: hit }));
            return;
          }
          await ensureWbiKeys();
          const parsed = await biliFetch('/x/space/wbi/arc/search', {
            wbi: true,
            params: { mid: msg.mid, pn: msg.page ?? 1, ps: msg.page_size ?? 30, order: 'pubdate' },
            wbiKeys,
          });
          if (!parsed.ok) {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: parsed.code }));
          } else {
            const vlist = parsed.data?.list?.vlist ?? [];
            const items = vlist.map((v) => ({
              bvid: v.bvid, title: v.title, created: v.created ?? null,
              play: v.play ?? null, length: v.length ?? null,
              // 封面预览透传（"//" 协议头相对形式归一 https:；server expand → web 端缩略图）
              pic: typeof v.pic === 'string' ? (v.pic.startsWith('//') ? 'https:' + v.pic : v.pic) : null,
            }));
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { total: parsed.data?.page?.count ?? items.length, items },
            }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "list-yt-channel-videos") {
        // YouTube 频道视频全量列表（CLI collect yt-videos 用）：拉完（或命中 inflight/缓存）从
        // storage 读出全量数据回执。全量分页含页间节流，大频道（几百条）约十几秒——CLI 侧
        // 需配大 --timeout（建议 ≥120000）。refresh=true 绕过 1h 缓存。
        try {
          const ident = typeof msg.ident === 'object' && msg.ident
            ? msg.ident
            : (typeof msg.channelId === 'string' && /^UC[\w-]{22}$/.test(msg.channelId)
                ? { channelId: msg.channelId }
                : (typeof msg.handle === 'string' && msg.handle ? { handle: msg.handle } : null));
          if (!ident) throw new Error('ident（{handle|channelId}）required');
          const r = await fetchAllYtChannelVideos(ident, msg.refresh === true);
          if (r.status === 'inflight') throw new Error('该频道拉取进行中，请稍后重试');
          const key = ytChannelKey(ident);
          const { [key]: data } = await chrome.storage.local.get(key);
          ws.send(JSON.stringify({
            type: "result", id: msg.id, ok: true,
            data: {
              channel_id: data?.channelId ?? null,
              channel_name: data?.channelName ?? null,
              total: data?.total ?? data?.items?.length ?? 0,
              items: (data?.items ?? []).map((it) => ({
                vid: it.vid, title: it.title, created: it.created ?? null,
                play: it.play ?? null, length: it.length ?? null, pic: it.pic ?? null,
              })),
              error: data?.error ?? null,
              cache_status: r.status,
            },
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "yt-search") {
        // YouTube 关键词搜索（CLI collect yt-search 用，2026-08-24）：编排/解析/tab 管理全在
        // yt-search.mjs 的 runYtSearchAction（可测），此处只注入 chrome 依赖。同步回执（类
        // bilibili search），无 storage 缓存——即席查询不占配额。
        try {
          const data = await runYtSearchAction(msg, {
            fetchHtml: ytFetchPage,
            ensureTab: ensureYoutubeTab,
            innertubeViaTab: ytInnertubeViaTab,
            closeTab: async (tabId) => { try { await chrome.tabs.remove(tabId); } catch {} },
          });
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "list-season-videos") {
        // 合集视频列表（CLI collect season 用,2026-08-22）：同步分页拉全量回执。
        // fetchAllSeasonVideos 是 popup 异步任务模式（storage 渐进落盘 + 轮询）,不适合 WS 同步
        // 回执——此处独立循环（同 API 同节流同停滞判定）,拉完落盘复用 popup 的 seasonVideos:*
        // 缓存结构（TTL 内互认免重拉;mid 额外带上,建任务的 UP 归属用）。大合集页多,CLI 侧
        // --timeout 建议 ≥120000（默认 180000 已覆盖）。
        try {
          const seasonId = msg.season_id;
          if (!Number.isInteger(seasonId) || seasonId <= 0) throw new Error('season_id（合集 id,正整数）required');
          const cacheKey = `seasonVideos:${seasonId}`;
          const { [cacheKey]: cached } = await chrome.storage.local.get(cacheKey);
          if (cached?.done && !cached.error && Array.isArray(cached.items) && Date.now() - cached.fetchedAt < SEASON_ALL_TTL_MS) {
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { season_id: seasonId, mid: cached.mid ?? null, total: cached.total, items: cached.items },
            }));
            return;
          }
          const items = [];
          const seen = new Set(); // bvid 去重（合集追加投稿使分页位移重叠时防重复）
          let total = 0;
          let mid = cached?.mid ?? null;
          let noNewStreak = 0; // 连续整页无新条目（≥3 判定分页停滞,保已拉部分终止）
          for (let pageNum = 1; ; pageNum++) {
            const parsed = await biliFetch('/x/polymer/web-space/seasons_archives_list', {
              params: { season_id: seasonId, sort_reverse: false, page_num: pageNum, page_size: SEASON_ALL_PS },
            });
            if (!parsed.ok) throw new Error('seasons_archives_list ' + parsed.code + (items.length ? `（已拉 ${items.length}/${total},中断）` : ''));
            mid = parsed.data?.mid ?? mid;
            const archives = parsed.data?.archives ?? [];
            total = parsed.data?.page?.total ?? items.length + archives.length;
            let added = 0;
            for (const a of archives) {
              if (!a?.bvid || seen.has(a.bvid)) continue;
              seen.add(a.bvid);
              added++;
              items.push({
                bvid: a.bvid, title: a.title, created: a.pubdate ?? null,
                play: a.stat?.view ?? null,
                length: typeof a.duration === 'number' && a.duration >= 0 ? fmtLength(a.duration) : null,
                pic: typeof a.pic === 'string' ? (a.pic.startsWith('//') ? 'https:' + a.pic : a.pic) : null,
              });
            }
            if (archives.length === 0 || items.length >= total) break;
            noNewStreak = added > 0 ? 0 : noNewStreak + 1;
            if (noNewStreak >= 3) break;
            await new Promise((r) => setTimeout(r, SEASON_ALL_PAGE_GAP_MS));
          }
          // 落盘复用 popup 缓存（命中免重拉）;mid 为附加字段,popup 读取不受影响
          await chrome.storage.local.set({ [cacheKey]: { items, total, done: true, error: null, fetchedAt: Date.now(), mid } });
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { season_id: seasonId, mid, total, items } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "set-reporting") {
        const newEnabled = await applyReporting(msg.enabled === true);
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { reporting_enabled: newEnabled } }));
        // set-reporting 路径不发 reporting-state：server 作为发起方据 result 更新状态
      } else if (msg.action === "set-task-dispatch") {
        // server 远程切任务派发开关（CLI clients task-dispatch / web 客户端页）
        const newEnabled = await applyTaskDispatch(msg.enabled === true);
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { task_dispatch_enabled: newEnabled } }));
        // 同 set-reporting：不发 task-dispatch-state，server 作为发起方据 result 更新状态
      } else {
        // needs_update：server 下发了本版本不认识的 action（新 server + 旧扩展），
        // 让 server/CLI 据此提示升级扩展，而非记为普通 failed
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "unknown action: " + msg.action, needs_update: true }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
    }
  };
  ws.onclose = () => {
    ws = null;
    authenticated = false;
    // authFailed（hello-nack 永久错误）不自动重连——重试只会再 nack，等用户改 token 手动重连
    if (authFailed) { console.log('[background] 连接关闭（鉴权失败），不自动重连'); return; }
    scheduleReconnect();
  };
  ws.onerror = () => { lastError = "连接错误（WS error）"; try { ws.close(); } catch {} };
}

// 生成 ingest payload 摘要字符串，供各分支日志复用
function payloadSummary(payload) {
  const v = payload?.video || {};
  const tracks = payload?.tracks || [];
  const bodySizes = tracks.map((t) => t?.versions?.[0]?.payload?.length || 0).join(",");
  return `source_vid=${v.source_vid} title=${v.title} UP=${v.creator?.name} 轨数=${tracks.length} 各轨body_size=${bodySizes}`;
}

// FETCH_SUBTITLE 的请求头：按 url 域名决定是否带 Referer。
// YouTube / googlevideo 域不带 Referer（不需要、且可能有害）；B 站等保留现有 Referer。
function subtitleFetchHeaders(url) {
  try {
    const host = new URL(url).hostname;
    const isYt = host === "youtube.com" || host.endsWith(".youtube.com") ||
                 host === "googlevideo.com" || host.endsWith(".googlevideo.com");
    return isYt ? {} : { "Referer": "https://www.bilibili.com/" };
  } catch {
    return { "Referer": "https://www.bilibili.com/" };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "INGEST" && msg.payload) {
    const payload = msg.payload;
    // 纯扩展模式：丢弃所有被动上报（含 force 手动上报——无 server 可收）；content.js 本地捕获不受影响
    if (isStandalone(connectionMode)) {
      console.log(`[background] ingest 丢弃（纯扩展模式）source_vid=${payload.video?.source_vid}`);
      // standalone 不上报 server，但仍广播 INGEST_RESULT 让 popup 刷新本地数据
      // （content 已采到字幕；用户开 popup 后才采到的字幕需刷新才能看到。popup 未开时 lastError 忽略）
      const vid = payload.video?.source_vid;
      if (vid) chrome.runtime.sendMessage({ type: "INGEST_RESULT", ok: true, source_vid: vid, inserted: 0, skipped: 0 }, () => void chrome.runtime.lastError);
      sendResponse({ ok: true, dropped: true });
      return true;
    }
    // navigate 采集：被动 INGEST 到达，唤醒等待中的 collectViaNavigate
    const navBvid = payload?.video?.source_vid;
    const pending = pendingNavCollect.get(navBvid);
    const fromNavigate = !!pending; // navigate 采集的被动 INGEST，绕过上报开关（主动采集触发）
    if (pending) { pendingNavCollect.delete(navBvid); pending.resolve(true); }
    // YouTube 主动采集同理：正在 fetch-youtube-subtitle 的视频,其 content-yt 被动 INGEST 视为主动采集（绕过开关）
    const fromYtCollect = payload?.source === "youtube" && activeYtCollects.has(navBvid);
    const summary = payloadSummary(payload);
    const force = msg.force === true || fromNavigate || fromYtCollect;
    if (force) {
      console.log(`[background] ingest 强制上报（手动上报，绕过开关）source_vid=${payload.video?.source_vid}`);
    } else if (!shouldReport(reportingEnabled)) {
      console.log(`[background] ingest 丢弃（开关关）${summary}`);
      sendResponse({ ok: true, dropped: true });
      return true;
    }
    sendIngest(payload);
    // P4：顺带被动采 UP 资料（7天）+ 最新视频（1h），异步、失败静默（不影响字幕主链路）
    const mid = payload.video?.creator?.source_uid;
    // 仅 B 站采 UP 资料：YouTube 的 channelId 非 B 站 mid，调 ensureUpperInfo/Videos 会误请求 B 站 API（静默失败但不该触发）
    if (mid && payload.source === "bilibili") {
      ensureUpperInfo(mid).catch((e) => console.warn('[background] passive upper-info failed', String(e?.message ?? e)));
      ensureUpperVideos(mid).catch((e) => console.warn('[background] passive upper-videos failed', String(e?.message ?? e)));
    }
    sendResponse({ ok: true });
  } else if (msg?.type === "WS_STATUS") {
    sendResponse({ ok: true, connected: authenticated, mode: connectionMode, activeServerId, error: lastError });
  } else if (msg?.type === "FETCH_UPPER_ALL" && msg.mid) {
    // UP 全部视频全量拉取：异步长任务（页间节流），立即回执状态；数据经 storage 增量流出。
    // refresh=true 绕过缓存强制重拉（popup ↻ 按钮；inflight 进行中则忽略）。
    fetchAllUpperVideos(String(msg.mid), msg.refresh === true).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: String(e?.message ?? e) })
    );
    return true;
  } else if (msg?.type === "FETCH_SEASON_ALL" && msg.seasonId != null) {
    // 合集视频全量拉取：异步长任务（页间节流），立即回执状态；数据经 storage 增量流出。
    // refresh=true 绕过缓存强制重拉（popup ↻ 按钮；inflight 进行中则忽略）。
    fetchAllSeasonVideos(Number(msg.seasonId), msg.refresh === true).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: String(e?.message ?? e) })
    );
    return true;
  } else if (msg?.type === "FETCH_YT_CHANNEL_ALL" && msg.ident) {
    // YouTube 频道视频全量拉取：异步长任务，数据经 storage 增量流出（同上两分支模式）。
    fetchAllYtChannelVideos(msg.ident, msg.refresh === true).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: String(e?.message ?? e) })
    );
    return true;
  } else if (msg?.type === "FETCH_SUBTITLE" && msg.url) {
    // content script 请求 background 抓字幕体（background 有 host_permissions，免 CORS）
    // B 站新版播放器改用同源 protobuf endpoint，inject 拦不到旧 aisubtitle 请求，故由 background 主动抓
    fetch(msg.url, { headers: subtitleFetchHeaders(msg.url) })
      .then(async (r) => {
        if (!r.ok) { sendResponse({ ok: false, error: "HTTP " + r.status }); return; }
        const body = await r.json().catch(() => null);
        if (!body) { sendResponse({ ok: false, error: "json parse failed" }); return; }
        sendResponse({ ok: true, body });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
  } else if (msg?.type === "MANUAL_CAPTURE") {
    // 只找 B 站视频页/列表播放页（避免对 chrome:// 等无 content script 的 tab sendMessage 抛 "Receiving end does not exist"）
    chrome.tabs.query({ active: true, currentWindow: true, url: ["*://www.bilibili.com/video/*", "*://www.bilibili.com/list/*", "*://www.youtube.com/watch*"] }, ([tab]) => {
      if (tab?.id) {
        // force:true 绕过上报开关：用户在「手动」模式下点「上报」就是明确要上报，不该被自动开关拦截
        chrome.tabs.sendMessage(tab.id, { type: "RE_AGG", force: true }, () => {
          if (chrome.runtime.lastError) console.warn('[collector] RE_AGG 失败:', chrome.runtime.lastError.message);
        });
      }
    });
    sendResponse({ ok: true });
  } else if (msg?.type === "SET_REPORTING") {
    applyReporting(msg.enabled === true).then((enabled) => {
      // popup 本地变化 → 发 reporting-state 同步 server
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reporting-state", enabled }));
      }
      sendResponse({ ok: true, reporting_enabled: enabled });
    });
    return true;
  } else if (msg?.type === "SET_TASK_DISPATCH") {
    // popup/options 本地切任务派发开关 → 发 task-dispatch-state 同步 server 连接表（对齐 SET_REPORTING）
    applyTaskDispatch(msg.enabled === true).then((enabled) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "task-dispatch-state", enabled }));
      }
      sendResponse({ ok: true, task_dispatch_enabled: enabled });
    });
    return true;
  } else if (msg?.type === "SET_CLIENT_NAME") {
    // popup 改名（id 不变）：归一 → 内存 + storage 落盘 → client-name-state 同步 server（null=清除）
    clientName = normalizeClientName(msg.name);
    chrome.storage.local.set({ [CLIENT_NAME_KEY]: clientName });
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "client-name-state", name: clientName }));
    sendResponse({ ok: true, client_name: clientName });
  } else if (msg?.type === "SET_CONNECTION_MODE") {
    const newMode = resolveConnectionMode(msg.mode);
    applyConnectionMode(newMode).then(async (mode) => {
      if (mode === MODE_STANDALONE) {
        // 切纯扩展：断 WS + 清离线队列（onclose→scheduleReconnect 已被 isStandalone 守卫拦，不会重连）
        try { ws?.close(); } catch {}
        ws = null;
        lastError = null; // 纯扩展不连，无连接错误
        await ingestQueue.clear();
      } else {
        // 切回 server：重置退避计数并触发连接
        reconnectAttempts = 0;
        connect();
      }
      sendResponse({ ok: true, mode });
    });
    return true;
  } else if (msg?.type === "SET_ACTIVE_SERVER") {
    // 切激活 server：落盘 activeServerId + 重载 activeServer 内存 + 热切换（关旧 ws → 新地址 connect）。
    // 清离线队列：暂存 payload 是对旧 server 缓存的，补发到新 server 会错位（对齐切 standalone 的清空策略）。
    (async () => {
      const items = await chrome.storage.local.get(SERVERS_KEY);
      const servers = normalizeServers(items[SERVERS_KEY]);
      const entry = resolveActiveServer(servers, typeof msg.id === 'string' ? msg.id : null);
      const newId = entry?.id ?? null;
      await chrome.storage.local.set({ [ACTIVE_SERVER_KEY]: newId });
      activeServerId = newId;
      activeServer = entry ? parseServerUrl(entry.url) : null;
      reconnectAttempts = 0;
      lastError = null; // 切到新 server，清旧错误（重新评估可达性/握手）
      try { ws?.close(); } catch {}
      ws = null;
      await ingestQueue.clear();
      if (!isStandalone(connectionMode) && activeServer) connect();
      sendResponse({ ok: true, activeServerId: newId, hasServer: !!activeServer });
    })();
    return true;
  } else if (msg?.type === "RECONNECT") {
    // 手动重连：重置鉴权失败态 + 触发连接（用户改 token / 开自动重连后点「重连」）
    authFailed = false;
    lastError = null;
    reconnectAttempts = 0;
    try { ws?.close(); } catch {}
    ws = null;
    if (!isStandalone(connectionMode) && activeServer) connect();
    sendResponse({ ok: true });
  }
  return true;
});

// navigate 采集：主动采集对充电视频（字幕加密拿不到）打开页面，复用被动采集链路入库。
// 频率控制：同时只 1 个 navigate（navCollectBusy 锁）；tab 关闭后间隔 = navGapBaseMs + 随机 navGapRandomMs（防风控）。
let navCollectBusy = false;
const pendingNavCollect = new Map(); // bvid -> { resolve }
const activeYtCollects = new Set();
// 同视频采集互斥：server 重启重派（resetDispatched）或双入口（CLI 直发 + 调度器）会对同一视频
// 并发下发采集命令——两套上游请求并发跑（风控暴露翻倍）。执行中的视频直接拒绝重复命令。
const inFlightCollects = new Set(); // 正在 fetch-youtube-subtitle 的 videoId 集合（其被动 INGEST 视为主动采集,绕过上报开关）
// settled 后宽限期：菜单触发翻译轨（CC→原轨→翻译,~2s 起步 + 每步 800ms）迟到 body 的等待窗口
const YT_SETTLE_GRACE_MS = 8000;// 间隔配置（chrome.storage.local 可覆盖：nav_gap_base_ms / nav_gap_random_ms，单位 ms）。默认 1s + 随机 0-2s。
let navGapBaseMs = 1000;
let navGapRandomMs = 2000;
async function loadNavGapConfig() {
  const cfg = await chrome.storage.local.get(['nav_gap_base_ms', 'nav_gap_random_ms']);
  if (typeof cfg.nav_gap_base_ms === 'number' && cfg.nav_gap_base_ms >= 0) navGapBaseMs = cfg.nav_gap_base_ms;
  if (typeof cfg.nav_gap_random_ms === 'number' && cfg.nav_gap_random_ms >= 0) navGapRandomMs = cfg.nav_gap_random_ms;
}
async function loadReconnectConfig() {
  const cfg = await chrome.storage.local.get(['reconnect_base_ms', 'reconnect_max_ms', 'auto_reconnect']);
  if (typeof cfg.reconnect_base_ms === 'number' && cfg.reconnect_base_ms >= 0) reconnectBaseMs = cfg.reconnect_base_ms;
  if (typeof cfg.reconnect_max_ms === 'number' && cfg.reconnect_max_ms >= 0) reconnectMaxMs = cfg.reconnect_max_ms;
  if (typeof cfg.auto_reconnect === 'boolean') autoReconnect = cfg.auto_reconnect;
}
// 配置改了即时重载（options UI 改 → background 自动用新值，无需消息往返）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('reconnect_base_ms' in changes || 'reconnect_max_ms' in changes || 'auto_reconnect' in changes) loadReconnectConfig();
});
async function collectViaNavigate(bvid, timeoutMs = 20000) {
  while (navCollectBusy) await new Promise((r) => setTimeout(r, 500)); // 等锁（同时只 1 个 navigate）
  navCollectBusy = true;
  let tabId = null;
  try {
    // active:false 不抢用户前台焦点（采集是后台任务，不该打断浏览）。取舍：触发链路是 content
    // 对播放器字幕按钮/语言菜单的合成 DOM click——click 不依赖页面可见性（合成事件无手势要求，
    // 前台时同样非真实手势），但后台 tab 定时器被浏览器节流（对齐到 ~1s），content 的就绪重试
    // （按钮 500ms×20 / 菜单 300ms×10）会被拉长，本路径唯一场景（充电视频，20s 超时）内成功率
    // 可能下降。若实测退化，把 active 改回 true 即恢复旧行为。
    const tab = await chrome.tabs.create({ url: `https://www.bilibili.com/video/${bvid}`, active: false });
    tabId = tab.id;
    // 通知 content 强制点 AI 字幕（navigate 主动采集，绕过上报开关）。content 注入后接收，未就绪则重试。
    const notify = (retries = 0) => {
      chrome.tabs.sendMessage(tab.id, { type: "NAV_TRIGGER_AI", bvid }, () => {
        if (chrome.runtime.lastError && retries < 30) setTimeout(() => notify(retries + 1), 500);
      });
    };
    notify();
    // 等被动采集 INGEST 该 bvid（content 自动点 AI 字幕 → inject 拦明文 aisubtitle → INGEST）
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => { pendingNavCollect.delete(bvid); resolve(false); }, timeoutMs);
      pendingNavCollect.set(bvid, { resolve: (v) => { clearTimeout(t); resolve(v); } });
    });
    return ok;
  } catch (e) {
    console.warn(`[background] navigate 采集失败 bvid=${bvid}`, String(e?.message ?? e));
    return false;
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
    navCollectBusy = false;
    await new Promise((r) => setTimeout(r, navGapBaseMs + Math.random() * navGapRandomMs)); // 关闭间隔（base+随机，防风控）
  }
}

// 扩展侧关键节点日志 → server WS 透传（collector-server ws/server.ts 的 [ext] log 管道，§9 可观察性）。
// 仅在已握手连接上发送：不为日志新建/重连，断线丢弃（本地 console 仍有 background 自身日志）。
function extLog(msg, level = "info") {
  try {
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "log", level, msg }));
    }
  } catch { /* 半开/竞态断线：日志发送失败不影响主流程 */ }
}

// YouTube 主动采集（fetch-youtube-subtitle action）：后台开 tab 到 watch?v=<id>,
// 等 content-yt 就绪并采集（CAPTION_TRACKS + FETCH_SUBTITLE 兜底/菜单触发）,
// 通过 GET_LOCAL_STATE 轮询判定采集完成（has-subtitle + 所有轨定居,或 no-subtitle）,
// INGEST 由 content-yt 自行走被动链路上报（复用现有链路,编排层不重复上报）。
// 与 B 站 collectViaNavigate 的差异:YouTube 字幕 URL 带签名不能后台拼,必须靠页面运行时;
// 且 content-yt 不需要 NAV_TRIGGER 通知——页面加载即自动采集。
// §9 可观察性：start/content-ready/done(+pot_limited)/error 关键节点经 WS type:'log' 透传
// server（每任务 3-6 条,禁止逐轮询周期刷屏）;captured/tracks 计数由轮询响应汇总上报。
// 超时语义：无进展超时（timeoutMs 是「无进展窗口」而非绝对时长）——长视频轨/正文加载慢但
// 持续出数据不该被一刀切杀掉;总时长由 server 侧命令预算兜底（迟到回执/迟到 INGEST 改判）。
async function collectYoutubeViaNavigate(videoId, timeoutMs = 45000, taskId = null) {
  while (navCollectBusy) await new Promise((r) => setTimeout(r, 500)); // 等锁（同时只 1 个 navigate）
  navCollectBusy = true;
  let reused = false;
  let tabId = null;
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const t0 = Date.now();
  const elapsedS = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  const tag = `${taskId ? `taskId=${taskId} ` : ""}vid=${videoId} `;
  let lastObserved = "no-response"; // 最近一次轮询观察值（超时诊断：content 未注入/未就绪/未定居）
  // 无进展超时：progressKey 把「观察状态 + 轨数 + 已到正文轨数」组成进展指纹，任一前进即重置
  // 窗口起点;44min 长视频（hX7yG1KVYhI 实测连续 5 轮 45s 绝对超时但字幕全部入库）只要持续
  // 出数据就不会被杀。正常视频不应 timeoutMs 无任何进展——未注入/卡死/定居后停滞照旧触发。
  let lastProgressKey = "";
  let lastProgressAt = Date.now();
  try {
    activeYtCollects.add(videoId); // 登记进行中的 YouTube 主动采集（INGEST 处理器据此放行 force）
    // 复用已打开的同视频 tab（reload 刷新页面状态）——但用户正在看的（active）不 reload，
    // 改开后台新 tab；无既有 tab 也后台新建（active:false 不抢焦点）
    const [existing] = await chrome.tabs.query({ url: `${watchUrl}*` });
    if (existing?.id && !existing.active) {
      tabId = existing.id;
      reused = true;
      await chrome.tabs.reload(tabId);
    } else {
      const tab = await chrome.tabs.create({ url: watchUrl, active: false });
      tabId = tab.id;
    }
    extLog(`[yt-navigate] start ${tag}tab=${reused ? `reuse#${tabId}(reload)` : `new#${tabId}`} timeout=${Math.round(timeoutMs / 1000)}s（无进展窗口）`);
    // 轮询 GET_LOCAL_STATE 直到终态。判定依据（content-yt GET_LOCAL_STATE 响应）：
    //   state=no-subtitle           captionTracks 已读且为空 → 成功 0 轨
    //   state=has-subtitle+settled  所有轨定居（body 到齐或已尝试）→ 等 INGEST 宽限后汇总
    //   state=has-subtitle 未定居    body 还在抓（FETCH_SUBTITLE / 菜单触发翻译轨）→ 继续等
    //   not-loaded / null           页面未就绪 → 继续等
    let firstSettledAt = 0; // 首次 settled 的时刻（宽限期起算点）
    let readyLogged = false; // content-yt 首个轮询响应只记一次（防逐周期刷屏）
    for (;;) {
      const state = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "GET_LOCAL_STATE", vid: videoId }, (resp) => {
          if (chrome.runtime.lastError) resolve(null); // content-yt 未注入/未就绪
          else resolve(resp);
        });
      });
      lastObserved = !state
        ? "no-response"
        : state.state === "has-subtitle"
          ? `has-subtitle${state.settled ? "+settled" : ""}`
          : (state.state ?? (state.ok ? "ok" : "!ok"));
      // 无进展超时判定（取代绝对时长）：指纹变化 = 有进展（就绪/定居/轨数/正文数任一前进）→
      // 重置窗口起点;持续 timeoutMs 指纹不变才判超时。文案格式保持稳定（server 侧按前缀
      // 「YouTube 采集超时（」识别此类失败做迟到 INGEST 改判）。
      const progressKey = `${lastObserved}/${state?.subs?.length ?? 0}轨/${(state?.subs ?? []).filter((s) => s.has_body).length}体`;
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > timeoutMs) {
        throw new Error(`YouTube 采集超时（${Math.round(timeoutMs / 1000)}s）`);
      }
      if (!readyLogged && state) {
        readyLogged = true;
        extLog(`[yt-navigate] content-ready ${tag}state=${lastObserved} tracks=${state.subs?.length ?? 0} elapsed=${elapsedS()}`);
      }
      if (state?.ok && state.state === "no-subtitle") {
        // captionTracks 已读且为空（纯音乐/直播/真无字幕）——任务成功但 0 轨
        extLog(`[yt-navigate] done ${tag}state=no_subtitle tracks=0 captured=0 elapsed=${elapsedS()} reused=${reused}`);
        return { videoId, captured: 0, tracks: 0, reason: "no_subtitle", navigated: true, reused };
      }
      if (state?.ok && state.state === "has-subtitle" && state.settled) {
        // settled 后的 INGEST：flushIfReady 已发（或菜单触发的翻译轨 TIMEDTEXT_BODY 还在路上——
        // 宽限 SETTLE_GRACE_MS 等迟到的翻译 body 再 flush,翻译轨是主动采集中文的关键产出）。
        if (!firstSettledAt) firstSettledAt = Date.now();
        if (Date.now() - firstSettledAt < YT_SETTLE_GRACE_MS) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        // 宽限期过完再取一次最新状态（宽限期间迟到的翻译轨已构造进 captionTracks）
        const final = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: "GET_LOCAL_STATE", vid: videoId }, (resp) => resolve(resp));
        });
        await new Promise((r) => setTimeout(r, 1500)); // 等 INGEST 经 WS 落库
        const subs = final?.subs ?? state.subs ?? [];
        const captured = subs.filter((s) => s.has_body).length;
        extLog(`[yt-navigate] done ${tag}state=settled tracks=${subs.length} captured=${captured} elapsed=${elapsedS()} reused=${reused}`);
        if (captured === 0) {
          // pot_limited 关键上下文：轨元数据到手（CAPTION_TRACKS 非空）但全轨 body 空——
          // timedtext 拦截与 FETCH_SUBTITLE 均未命中，此前该终态零日志无从诊断
          extLog(`[yt-navigate] pot_limited ${tag}tracks=${subs.length} captured=0（轨元数据到手但 body 全空：timedtext 拦截与 FETCH_SUBTITLE 均未命中，pot 受限）`, "warn");
        }
        return {
          videoId, captured, tracks: subs.length, navigated: true, reused,
          ...(captured === 0 ? { reason: "pot_limited" } : {}),
        };
      }
      // 未就绪/未定居：500ms 后重试
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    extLog(`[yt-navigate] error ${tag}last=${lastObserved} elapsed=${elapsedS()} err=${String(e?.message ?? e)}`, "warn");
    throw e;
  } finally {
    activeYtCollects.delete(videoId);
    if (tabId != null && !reused) { try { await chrome.tabs.remove(tabId); } catch {} } // 复用的 tab 不关
    navCollectBusy = false;
    await new Promise((r) => setTimeout(r, navGapBaseMs + Math.random() * navGapRandomMs)); // 关闭间隔（防风控,对齐 B 站）
  }
}

// 统一 ingest 上报：WS 可用直发；否则入离线队列（pending-ingests.mjs 逐键存储），hello-ack 后补发。
// fetch-subtitle（主动）与 content→background INGEST（被动）共用，保证 WS 断时不丢。
// 纯扩展模式下短路（不连不存 pending）——由调用前的 INGEST 短路与本函数守卫双重覆盖。
// 半开缓解（最小版）：内存 authenticated 感知不到休眠唤醒/NAT 超时后的死链路（readyState 仍报
// OPEN）——send 前 double-check + 包 try-catch，send 抛错即入队。彻底的半开检测需应用层
// 心跳/ack（server 协议面），此处只保证「已确认 send 失败的不丢」。
const ingestQueue = createPendingQueue(chrome.storage.local);
function sendIngest(payload) {
  if (isStandalone(connectionMode)) return; // 纯扩展：不上报、不存 pending（永不补发）
  if (authenticated && ws?.readyState === WebSocket.OPEN) { // 鉴权通过才直发（未握手/已断线 → 入队，hello-ack 后 flush）
    try {
      ws.send(JSON.stringify({ type: "ingest", payload }));
      return;
    } catch {
      console.warn(`[background] ingest 直发失败转离线队列 source_vid=${payload?.video?.source_vid}`);
    }
  }
  ingestQueue.enqueue(payload).catch((e) => console.warn('[background] ingest 入队失败', String(e?.message ?? e)));
}

// 补发暂存记录（hello-ack 后调用）：逐条发送、成功即删自己的键——与并发入队互不覆盖，
// 中途断线剩余保留、下次 hello-ack 续发（旧版整表清空会吞掉并发写入的 payload 与未发项）。
function flushPendingIngests() {
  return ingestQueue.flush((payload) => {
    // 每条 send 前重新校验：循环跨 await，期间连接可能已断/半开
    if (!authenticated || ws?.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: "ingest", payload }));
      return true;
    } catch {
      return false;
    }
  });
}

loadPersistedState().then(() => loadNavGapConfig()).then(() => loadReconnectConfig()).then(() => {
  // 纯扩展模式：启动不连 server（模式由 storage 持久，SW 回收重启后仍生效）
  if (!isStandalone(connectionMode)) connect();
});
