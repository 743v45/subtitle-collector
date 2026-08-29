// dy-navigate.mjs —— 抖音 navigate 采集域（2026-08-29 S8 从 background.js 抽出，台账性重构）。
// 内容：collectDouyinViaNavigate（单视频主动采集）+ expandDouyinUpper（博主全量展开）+
// handleCommand（WS 命令 fetch-douyin-subtitle / expand-douyin-upper 的校验/防重/回执）。
// 行为与协议与抽出前逐字对齐（不改协议）；background 侧依赖（日志/上报/鉴权态）
// 经 env 注入：{ extLog, sendIngest, inFlightCollects, canDispatch(), sendUpper(creator) }。
// 导航互斥锁与关闭间隔节流（防风控）共用 nav-gate.mjs——与 B 站/YouTube navigate 采集互斥。
//
// 编排模式对齐 collectYoutubeViaNavigate（background.js）：后台开 tab 到 /video/<awemeId>，
// 轮询 content-dy GET_DETAIL 等页面取数（inject-dy 双路：detail XHR hook + SSR videoDetail；
// URL 全套签名只有页面上下文能拼，R1 定案唯一正路），拿到 detail 后组装 payload 直发
// sendIngest（不依赖 content 侧被动 INGEST——抖音详情一次到位，无轨定居等待）。
// 与 YouTube 链路差异：字幕正文抓取在拿到 detail 后一次完成（cla_info 轨数有限，无菜单触发），
// 元信息+0 轨也入库（no_subtitle 打标 → ASR 兜底锚点）；图集（aweme_type≠0，R3 范围外）不入库。
// 超时语义同 youtube：无进展窗口（content-dy 就绪即重置；超时文案前缀「抖音 采集超时（」与
// server amend.ts 迟到改判的 LIKE 匹配对齐，勿改措辞）。§9 可观察性：start/content-ready/
// done(+not_video/no_subtitle)/error 关键节点经 WS log 透传。

import { buildDouyinPayload, douyinCreatorFromProfile, isDouyinVideo } from "./douyin-payload.js";
import { extractDouyinCaptionTracks, normalizeDouyinCaption } from "./douyin-format.mjs";
import { navGate } from "./nav-gate.mjs";
import { TASK_DISPATCH_DISABLED_ERROR } from "./task-dispatch.mjs";
import { fmtLength, cmdError } from "./format.mjs";

// 日志 tag（taskId 前缀 + 关键标识，与抽出前各 [dy-*] 日志一致）
function dyTag(taskId, key) {
  return `${taskId ? `taskId=${taskId} ` : ""}${key}`;
}

// 起始时间 → 已耗时秒（日志用）
function elapsedSSince(t0) {
  return () => `${Math.round((Date.now() - t0) / 1000)}s`;
}

// 复用已打开的同视频 tab（reload 刷新页面状态）；用户正看着的不动，改开后台新 tab（对齐 yt 分支）
async function openWatchTab(watchUrl) {
  const [existing] = await chrome.tabs.query({ url: `${watchUrl}*` });
  if (existing?.id && !existing.active) {
    await chrome.tabs.reload(existing.id);
    return { tabId: existing.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url: watchUrl, active: false });
  return { tabId: tab.id, reused: false };
}

// 单轮 GET_DETAIL 轮询：content-dy 未注入/未就绪 → resp=null；observed 为诊断用观察状态
async function pollDetailOnce(tabId, awemeId) {
  const resp = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_DETAIL", awemeId }, (r) => {
      if (chrome.runtime.lastError) resolve(null); // content-dy 未注入/未就绪
      else resolve(r);
    });
  });
  return { resp, observed: !resp ? "no-response" : (resp.state ?? (resp.ok ? "ok" : "!ok")) };
}

// 字幕轨正文抓取（cla_info，仅 detail 接口有；匿名态预期 0 轨）：逐轨 fetch + 归一化
//（host_permissions 免 CORS；cla_info 内层结构未实测——遇真实样本形态不符时此处日志可见
// url 数与抓取结果）；缺失/失败轨不进 bodies（该轨 payload=null，server 侧跳过）。
async function fetchCaptionBodies(captionTracks, extLog, tag) {
  const bodies = {};
  for (const t of captionTracks) {
    if (!t.url) continue;
    try {
      const r = await fetch(t.url, { headers: { Referer: "https://www.douyin.com/" } });
      if (!r.ok) {
        extLog(`[dy-navigate] 字幕体 HTTP ${r.status} ${tag}lan=${t.lan}`, "warn");
        continue;
      }
      const json = await r.json().catch(() => null);
      const normalized = normalizeDouyinCaption(json);
      if (normalized?.body?.length > 0) bodies[t.url] = normalized;
      else extLog(`[dy-navigate] 字幕体归一化后空 cues ${tag}lan=${t.lan}（结构漂移？原始 keys=${json ? Object.keys(json).join(',') : 'null'}）`, "warn");
    } catch (e) {
      extLog(`[dy-navigate] 字幕体抓取异常 ${tag}lan=${t.lan} err=${String(e?.message ?? e)}`, "warn");
    }
  }
  return bodies;
}

// detail 到手判定（has-detail + 带 detail 体）
function hasDetail(resp) {
  return !!(resp?.ok && resp.state === "has-detail" && resp.detail);
}

// 无进展窗口推进（对齐 yt 分支语义）：观察状态变化 = 有进展（重置窗口）；窗口到点抛超时。
// 文案前缀「抖音 采集超时（」与 server amend.ts LIKE 匹配耦合（迟到 INGEST 改判），勿改措辞。
function tickProgressWindow(key, last, timeoutMs, lastObserved) {
  if (key !== last.key) return { key, at: Date.now() };
  if (Date.now() - last.at > timeoutMs) {
    throw new Error(`抖音 采集超时（${Math.round(timeoutMs / 1000)}s，last=${lastObserved}：detail XHR 未拦到/SSR 未就绪/content-dy 未注入）`);
  }
  return last;
}

// detail 到手后的组装+上报+回执：content-ready 日志 → 图集 not_video 不入库；字幕轨全抓后
// buildDouyinPayload → sendIngest（主动采集语义，绕过上报开关）；必要字段缺失告警（对齐
// content-yt flushIfReady 2026-08-25：上报不完整必须可观察，不阻塞）。
async function finishDouyinCollect(resp, awemeId, reused, env, tag, elapsedS) {
  const detail = resp.detail;
  env.extLog(`[dy-navigate] content-ready ${tag}origin=${resp.origin ?? "?"} aweme_type=${detail.aweme_type} is_subtitled=${detail.is_subtitled} cla_info=${detail.cla_info ? 'yes' : 'null'} elapsed=${elapsedS()}`);
  // 回执 awemeId 用页面实际 ID 优先：旧 ID 会被抖音 302 迁移到新 ID（任务行持旧 ID、
  // payload 按实际 ID 入库），回执拿旧 ID 会让 server 侧 no-subtitle 打标/关联落空（2026-08-29 首采实测）
  const actualId = detail.aweme_id ?? awemeId;
  if (String(actualId) !== String(awemeId)) {
    env.extLog(`[dy-navigate] id-migrated ${tag}task=${awemeId} actual=${actualId}（302 迁移,回执/打标按实际 ID）`);
  }
  // 图集（aweme_type≠0，R3 定案范围外）：不入库，回执 reason=not_video（server 侧映射 failed；
  // 批量链路在列表阶段已过滤）
  if (!isDouyinVideo(detail)) {
    env.extLog(`[dy-navigate] done ${tag}state=not_video（aweme_type=${detail.aweme_type} 图集不入库）`);
    return { awemeId: actualId, captured: 0, tracks: 0, ingested: false, reason: "not_video", navigated: true, reused };
  }
  const captionTracks = extractDouyinCaptionTracks(detail);
  const bodies = await fetchCaptionBodies(captionTracks, env.extLog, tag);
  const validTracks = captionTracks.filter((t) => t.url && bodies[t.url] != null);
  const payload = buildDouyinPayload(detail, validTracks, bodies);
  const missing = [];
  if (payload.video.duration == null) missing.push("duration");
  if (payload.video.published_at == null) missing.push("published_at");
  if (missing.length > 0) {
    console.warn(`[dy-navigate] INGEST 必要字段缺失 ${tag}missing=${missing.join(",")}（detail 数据源不完整，视为上报质量问题）`);
  }
  env.sendIngest(payload);
  env.extLog(`[dy-navigate] done ${tag}state=${validTracks.length > 0 ? "has-subtitle" : "no_subtitle"} tracks=${validTracks.length}/${captionTracks.length} elapsed=${elapsedS()} reused=${reused}`);
  return {
    awemeId: actualId, captured: validTracks.length, tracks: validTracks.length, ingested: true, navigated: true, reused,
    ...(validTracks.length === 0 ? { reason: "no_subtitle" } : {}),
  };
}

// 抖音主动采集（fetch-douyin-subtitle action 的执行体）
async function collectDouyinViaNavigate(awemeId, timeoutMs = 45000, taskId = null, env) {
  await navGate.acquire(); // 等锁（同时只 1 个 navigate，与 B 站/YouTube 互斥）
  let reused = false;
  let tabId = null;
  const watchUrl = `https://www.douyin.com/video/${awemeId}`;
  const t0 = Date.now();
  const elapsedS = elapsedSSince(t0);
  const tag = dyTag(taskId, `aweme=${awemeId} `);
  let lastObserved = "no-response"; // 最近一次轮询观察（超时诊断：content-dy 未注入/未取到 detail）
  let lastProgress = { key: "", at: Date.now() };
  try {
    ({ tabId, reused } = await openWatchTab(watchUrl));
    env.extLog(`[dy-navigate] start ${tag}tab=${reused ? `reuse#${tabId}(reload)` : `new#${tabId}`} timeout=${Math.round(timeoutMs / 1000)}s（无进展窗口）`);
    for (;;) {
      const { resp, observed } = await pollDetailOnce(tabId, awemeId);
      lastObserved = observed;
      lastProgress = tickProgressWindow(lastObserved, lastProgress, timeoutMs, lastObserved);
      if (hasDetail(resp)) return await finishDouyinCollect(resp, awemeId, reused, env, tag, elapsedS);
      // 未就绪：500ms 后重试
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    env.extLog(`[dy-navigate] error ${tag}last=${lastObserved} elapsed=${elapsedS()} err=${String(e?.message ?? e)}`, "warn");
    throw e;
  } finally {
    if (tabId != null && !reused) { try { await chrome.tabs.remove(tabId); } catch {} } // 复用的 tab 不关
    navGate.release();
    await navGate.gap(); // 关闭间隔（防风控,对齐 yt/B 站）
  }
}

// ── 博主批量（expand-douyin-upper）──
// 后台开博主页 tab，content-dy 聚合 inject-dy 拦的 post 游标页（翻页由 content-dy 滚动触发）
// + profile 资料；无进展窗口兜底滚动失灵（保部分结果），页间节流在页面侧天然存在（SPA 懒加载
// 间隔）。回执对齐 list-yt-channel-videos 形态。
const DY_UPPER_PROGRESS_MS = 20000;
// 无进展窗口：页面加载（bundle 数秒）+ 首页 post；之后每页 items 增长即重置。窗口到点保部分结果收尾。
const upperProgressOf = (s) => `${s?.state ?? "?"}/${s?.items?.length ?? 0}/${s?.profile ? 1 : 0}`;

// DY_UPPER_START 启动通知（content-dy 就绪前重试，对齐 collectViaNavigate notify 模式；
// 其内部缓冲会重放先到的首页）
function notifyUpperStart(tabId, secUid) {
  return new Promise((resolve) => {
    const send = (retries = 0) => {
      chrome.tabs.sendMessage(tabId, { type: "DY_UPPER_START", secUid }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          if (retries < 30) setTimeout(() => send(retries + 1), 500);
          else resolve();
          return;
        }
        resolve();
      });
    };
    send();
  });
}

// 轮询 GET_UPPER_STATE 至 done / error / 无进展窗口到点（滚动翻页停滞：保已拉部分收尾，
// 错误标注供上层展示）
async function waitUpperDone(tabId, extLog, tag) {
  let state = null;
  let lastProgressKey = "";
  let lastProgressAt = Date.now();
  for (;;) {
    state = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "GET_UPPER_STATE" }, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    });
    const key = upperProgressOf(state);
    if (key !== lastProgressKey) {
      lastProgressKey = key;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > DY_UPPER_PROGRESS_MS) {
      // 滚动翻页停滞（SPA 未响应滚动/页面结构变化）：保已拉部分收尾，错误标注供上层展示
      extLog(`[dy-upper] 无进展窗口到点 ${tag}items=${state?.items?.length ?? 0}（滚动翻页停滞，保部分结果）`, "warn");
      break;
    }
    if (!state?.ok) { await new Promise((r) => setTimeout(r, 800)); continue; } // content-dy 未就绪
    if (state.state === 'error') throw new Error(String(state.error ?? '博主列表拉取失败'));
    if (state.state === 'done') break;
    await new Promise((r) => setTimeout(r, 800));
  }
  return state;
}

// 单条 post item → 回执条目（对齐 UpperVideoItem / yt items 形态；图集由调用方过滤）
function upperReceiptItemOf(it) {
  return {
    bvid: it.aweme_id,
    title: it.desc ?? '',
    created: it.create_time ?? null,
    play: it.play_count ?? null, // douyin web 端恒 0（S1 实测），照存
    length: typeof it.duration_ms === 'number' && it.duration_ms >= 0 ? fmtLength(it.duration_ms / 1000) : null,
    pic: it.cover_url ?? null,
  };
}

// 聚合结果 → 回执：图集过滤（R3：aweme_type≠0 不进批量列表）+ 条目组装 + creators 顺带入库
//（对齐 B 站 get-upper-info / yt expandYtChannelVideos 的最小行语义，env.sendUpper 内含
// 鉴权/连接态守卫）
function douyinUpperReceipt(state, secUid, extLog, tag, elapsedS, env) {
  const raw = state?.items ?? [];
  const items = [];
  let droppedAlbums = 0;
  for (const it of raw) {
    if (it.aweme_type !== 0) { droppedAlbums++; continue; }
    items.push(upperReceiptItemOf(it));
  }
  const creator = douyinCreatorFromProfile(state?.profile);
  if (creator) env.sendUpper(creator);
  extLog(`[dy-upper] done ${tag}items=${items.length}/${raw.length}（图集过滤 ${droppedAlbums}）${creator ? ` creator=${creator.name}` : '（profile 未到手）'} elapsed=${elapsedS()}`);
  return {
    channel_id: secUid,
    channel_name: creator?.name ?? null,
    total: items.length,
    items,
  };
}

// 抖音博主作品列表展开（expand-douyin-upper action 的执行体）
async function expandDouyinUpper(secUid, taskId = null, env) {
  await navGate.acquire(); // 等锁（与 navigate 采集互斥，防风控叠加）
  let tabId = null;
  const t0 = Date.now();
  const elapsedS = elapsedSSince(t0);
  const tag = dyTag(taskId, `secUid=…${String(secUid).slice(-8)} `);
  try {
    const tab = await chrome.tabs.create({ url: `https://www.douyin.com/user/${secUid}`, active: false });
    tabId = tab.id;
    env.extLog(`[dy-upper] start ${tag}tab=new#${tabId} timeout=${Math.round(DY_UPPER_PROGRESS_MS / 1000)}s（无进展窗口）`);
    await notifyUpperStart(tabId, secUid);
    const state = await waitUpperDone(tabId, env.extLog, tag);
    // 零数据防线（2026-08-30 审查 M2 + spike ②）：content-dy 完全未注入（GET_UPPER_STATE 无响应
    // → state=null）或注入但页面零消息（改版/滚动全失灵）时，无进展窗口收尾后连有效 profile 都没
    // 拿到——此时回「ok+total:0」是伪装成功（上层当 0 作品建空批次）；必须回 error。判据与回执
    // 组装同口径（douyinCreatorFromProfile）：profile={}（sec_uid 注销页 user:{} 形态，2026-08-30
    // spike 实测）组不出 creator，不再以 truthiness 穿透。区分：组得出 creator 才证明页面活着
    //（items 0 → content-dy POST_LIST_EMPTY 的「需登录」错误路径 / PROFILE_OTHER_ERROR 的
    //「博主不存在」错误路径 / 真 0 作品 done 空列表成功）；保部分结果语义不变——items>0 时即便
    // profile 缺失仍回执成功（丢数据比缺博主名更糟）。
    if (douyinCreatorFromProfile(state?.profile) == null && !(state?.items?.length > 0)) {
      throw new Error(`博主页数据未就绪（博主不存在/页面改版/未注入）items=${state?.items?.length ?? 0}`);
    }
    return douyinUpperReceipt(state, secUid, env.extLog, tag, elapsedS, env);
  } catch (e) {
    env.extLog(`[dy-upper] error ${tag}elapsed=${elapsedS()} err=${String(e?.message ?? e)}`, "warn");
    throw e;
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
    navGate.release();
    await navGate.gap(); // 关闭间隔（防风控）
  }
}

// WS 命令处理（background ws.onmessage 的 fetch-douyin-subtitle / expand-douyin-upper 两分支
// 整体下沉；send = (resultObj) => ws.send(JSON.stringify(resultObj))）。
// fetch 分支：仅上报状态防御（同 fetch-youtube-subtitle：拒绝后任务落 failed，error 文案指向
// 开关而非重试）+ awemeId 数字校验 + 同视频 in-flight 防重；无进展窗口随命令下发
//（settings.collect_timeout_ms.douyin，对齐 youtube；缺省/旧 server 回落 45s）。
// expand 分支：secUid 校验；post 匿名 200 空体（S1 实测 gating）→ 回执 error「需登录」，
// 不误判「0 作品」；content-dy 未注入/页面零消息/profile 无效 → 回执 error「博主页数据未就绪」
//（2026-08-30 审查 M2 + spike ②，不再以 ok+total:0 伪装成功；sec_uid 注销的「博主不存在」由
// content-dy PROFILE_OTHER_ERROR 错误态秒级透传，不走此兜底）。
async function handleCommand(msg, send, env) {
  if (msg.action === "fetch-douyin-subtitle") {
    if (!env.canDispatch()) {
      send({ type: "result", id: msg.id, ok: false, error: TASK_DISPATCH_DISABLED_ERROR });
      return;
    }
    if (typeof msg.awemeId !== 'string' || !/^\d+$/.test(msg.awemeId)) {
      send({ type: "result", id: msg.id, ok: false, error: "awemeId（数字 ID）required" });
      return;
    }
    const dyKey = `douyin:${msg.awemeId}`;
    if (env.inFlightCollects.has(dyKey)) {
      send({ type: "result", id: msg.id, ok: false, error: "duplicate in-flight: 同视频采集正在执行" });
      return;
    }
    env.inFlightCollects.add(dyKey);
    try {
      const windowMs = Number.isInteger(msg.timeout_ms) && msg.timeout_ms >= 15000 ? msg.timeout_ms : 45000;
      const data = await collectDouyinViaNavigate(msg.awemeId, windowMs, msg.id, env);
      send({ type: "result", id: msg.id, ok: true, data });
    } catch (err) {
      send({ type: "result", id: msg.id, ok: false, error: cmdError(err) });
    } finally {
      env.inFlightCollects.delete(dyKey);
    }
    return;
  }
  try {
    if (typeof msg.secUid !== 'string' || !msg.secUid) throw new Error('secUid required');
    const data = await expandDouyinUpper(msg.secUid, msg.id, env);
    send({ type: "result", id: msg.id, ok: true, data });
  } catch (err) {
    send({ type: "result", id: msg.id, ok: false, error: cmdError(err) });
  }
}

/**
 * 创建抖音命令域。background 启动时调用一次，env 为闭包桥（读实时状态）：
 * @param {object} env
 *   - extLog(msg, level)：WS 日志透传
 *   - sendIngest(payload)：统一 ingest 上报（WS 直发/离线队列）
 *   - inFlightCollects：Set——同视频采集互斥（跨平台共用，键 `douyin:<awemeId>`）
 *   - canDispatch()：任务派发开关实时读数（false=仅上报状态）
 *   - sendUpper(creator)：ingest-upper 直发（内含 authenticated/ws 连接态守卫）
 */
export function createDouyinCommands(env) {
  return { handleCommand: (msg, send) => handleCommand(msg, send, env) };
}
