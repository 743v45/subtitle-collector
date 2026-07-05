// 对应 GET ${API_BASE}/api/videos/bilibili/<bvid> 的响应结构。
// video.extra 在服务端可能存为 JSON 字符串，前端 parseExtra 兜底解析。
// 字段名以扩展 inject.js readVideoExtra 实际写入为准（来自 __INITIAL_STATE__.videoData.stat）：
// view / danmaku / reply / favorite / coin / share / like。注意收藏键是 `favorite`，不是 `fav`。
export interface CollectedStat {
  // 数据驱动访问（platform adapter 的 statFields.key 动态索引），允许任意 string key
  [key: string]: number | null | undefined;
  view?: number | null;
  like?: number | null;
  coin?: number | null;
  favorite?: number | null;
  share?: number | null;
  // stat.danmaku = 该视频收到的弹幕条数（B 站公开统计字段），非本项目采集的弹幕内容
  danmaku?: number | null;
  reply?: number | null;
}

export interface CollectedExtra {
  tname?: string;
  // B 站 view.desc（视频简介），与 tname/tags 同源（__INITIAL_STATE__.videoData.desc）。
  desc?: string | null;
  pages?: unknown[];
  stat?: CollectedStat;
  tags?: { tag_name: string }[];
}

export interface CollectedVideo {
  // schema.sql 中 updated_at 为 INTEGER（epoch ms），服务端 SELECT v.* 直返数字；兼容字符串。
  updated_at?: number | string | null;
  // 服务端 getVideo SELECT v.* 含 creator_id（creators 表外键）；视频未关联 UP 时为 null。
  creator_id?: number | null;
  // duration（秒）与 published_at（毫秒，ingest-payload.js pubdate*1000）：服务端 SELECT v.* 直返。
  duration?: number | null;
  published_at?: number | null;
  extra?: string | CollectedExtra | null;
}

// UP 主详情：对齐服务端 GET /api/creators/:id 返回的 creator 对象
// （server CreatorDetail，schema creators 表 P2 字段 sign/level/sex/official_*/fans/following）。
export interface CreatorDetail {
  id: number;
  source: string;
  source_uid: string;
  name: string | null;
  avatar: string | null;
  sign: string | null;
  level: number | null;
  sex: string | null;
  official_type: number | null;
  official_title: string | null;
  fans: number | null;
  following: number | null;
  first_seen_at: number;
  updated_at: number;
}

export interface CollectedResponse {
  ok: boolean;
  video?: CollectedVideo;
  tracks?: unknown[];
}

// 对应 GET https://api.bilibili.com/x/web-interface/nav 的响应结构。
export interface BiliNavResponse {
  code: number;
  data?: { isLogin?: boolean; uname?: string; mid?: number };
}

// —— 本地数据源（content.js collected Map，popup 经 chrome.tabs.sendMessage 直取）——

// B 站字幕正文结构（inject 拦到 / background 抓取的 JSON）。
// 主流为 { body: [{from, to, content}, ...] }；非标准字段从宽。
export interface SubtitleCue {
  from?: number;
  to?: number;
  content?: string;
}
export interface SubtitleBody {
  body?: SubtitleCue[];
}

// 单轨元信息（来自 inject buildPlayerMeta 的 subs）。
export interface LocalSub {
  lan?: string;
  lan_doc?: string;
  track_type?: string | null;
  subtitle_url?: string;
  url_missing?: boolean;
  has_body?: boolean; // 该轨正文是否已在 content.js bodies Map 内
}

// content.js 对 GET_LOCAL_STATE 的响应。
export interface LocalStateResponse {
  ok: boolean;
  state: 'not-loaded' | 'no-subtitle' | 'has-subtitle';
  bvid?: string;
  extra?: CollectedExtra;
  subs?: LocalSub[];
  bodies?: Record<string, SubtitleBody>;
}

// 一致性校验：本地 vs server 的差异项（仅轨数；stat 是时点值不校验）。
export interface ConsistencyIssue {
  field: string;
  local: string;
  server: string;
}
