import type { TagSource } from './lib/tagSources';

// ── 视频元数据（extra 是服务端 JSON 字符串，由 api.ts 在入口处 JSON.parse 成对象）──
export type { TagSource };
// 标签明细：name + 四档来源（列表按优先级 winner 去重；详情全档不去重）
export interface TagDetail { name: string; source: TagSource; }
export interface VideoTag { tag_id?: number; tag_name: string; }
export interface VideoStat {
  view?: number; danmaku?: number; reply?: number; favorite?: number;
  coin?: number; share?: number; like?: number; now_rank?: number; his_rank?: number;
}
export interface VideoExtra {
  aid?: number; cid?: number; pic?: string; desc?: string; ctime?: number;
  tid?: number; tname?: string; copyright?: number; state?: number; publocation?: string;
  tags?: VideoTag[];
  dimension?: { width?: number; height?: number; rotate?: number };
  pages?: Array<{ cid?: number; page?: number; part?: string; duration?: number }>;
  rights?: Record<string, unknown>;
  honor?: Record<string, unknown>;
  ugc_season?: { id?: number; title?: string } | null;
  stat?: VideoStat;
  [k: string]: unknown;
}

export interface VideoListItem {
  id: number; source: string; source_vid: string; title: string;
  creator_name: string | null; creator_source_uid?: string | null;
  duration: number | null; published_at?: number | null;
  track_count: number; first_seen_at: number;
  tid?: number | null; tname?: string | null; tags?: string[];
  tag_details?: TagDetail[];
  view?: number | null;
  pic?: string | null;   // 封面 URL（列表富化：extra.pic，ingest 已归一 https:；无封面 null → 前端回落占位）
}
export interface VideoInfo {
  title: string; creator_name: string | null; duration: number | null;
  creator_source_uid?: string | null; // UP uid（getVideo LEFT JOIN creators；详情页作者外链跳空间）
  extra?: VideoExtra;
  published_at?: number | null;
  source?: string;
  source_vid?: string;
}
export interface VersionInfo {
  id: number; origin: string; source_url: string | null;
  asr_engine: string | null; captured_at: number; body_size: number | null;
  is_default?: boolean;
}
export interface TrackInfo {
  id: number; lan: string | null; lan_doc: string | null; track_type: number | null;
  is_default?: boolean; versions: VersionInfo[];
}
export interface VideoDetail { video: VideoInfo; tracks: TrackInfo[]; tag_details?: TagDetail[]; }

// change_log（最近采集/变更流水，对应 server getChanges）
export interface ChangeRow {
  id: number;
  entity: string;       // 'creator' | 'video'
  entity_id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: number;
}

export interface ClientInfo {
  client_id: string;
  client_name: string | null; // popup 改名（id 不变；null=未命名或已清除）
  ext_version: string | null;
  reporting_enabled: boolean | null; // 在线=实际开关；离线 null（远端切换须在线）
  task_dispatch_enabled: boolean | null;
  connected: boolean;              // false = 离线（DB 注册表留存，含历史客户端）
  connected_at: number | null;     // 本次连接建立时刻（离线 null；「在线时长」起算点）
  first_seen_at: number;           // server 首次见到该 client_id
  last_seen_at: number;            // 最近连接建立/断开时刻（「离线时长」起算点）
}

// ── 采集任务（手机/网页提交 → server 派发扩展执行）──
// limited = 执行成功但字幕受限（YouTube pot，0 轨入库，元信息已入库）——终态，可重试重采
export type CollectTaskStatus = 'pending' | 'dispatched' | 'succeeded' | 'failed' | 'limited';
export interface CollectTask {
  id: number;
  source: 'bilibili' | 'youtube';
  source_vid: string;
  url: string;
  status: CollectTaskStatus;
  client_id: string | null;
  batch_id?: string | null; // 展示侧聚合标签：批量提交同批共享；单条/旧任务 null
  error: string | null;
  result: string | null; // JSON 字符串（扩展回执 data：captured/tracks/reason…）
  title: string | null;  // 库内视频标题（server LEFT JOIN videos；任务卡直接展示,未入库 null）
  creator_name?: string | null; // 库内 UP 名（server LEFT JOIN creators；历史页按 UP 筛选后回显,未入库 null）
  creator_source_uid?: string | null; // UP uid（入库取 creators、未入库回落任务行 creator_uid；任务卡跳空间）
  created_at: number;
  finished_at: number | null;
}

// ── UP 全部视频条目（/api/upper-videos/expand；arc/search 原样字段 + server 已采标注）──
export interface UpperVideoItem {
  bvid: string;
  title: string;
  created: number | null; // unix 秒
  play: number | null;
  length: string | null;  // "MM:SS" / "HH:MM:SS"
  pic: string | null;     // 封面 URL（server 已归一 https:）
  collected: boolean;
}

// ── 视频多维筛选（对应 server advanced.ts VideoFilter + ListFilter）──
export interface VideoFilter {
  q?: string;
  source?: string; // 平台过滤（bilibili/youtube）
  tid?: number;
  tname?: string;
  tag?: string;
  tags?: string[];       // 精确标签过滤（AND，逗号 join 传 server）
  tag_source?: string[]; // 标签档位过滤（manual/batch/bili/season/ai，逗号 join 传 server）
  subtitle_q?: string; // 字幕正文关键词
  lang?: string;
  has_subtitle?: boolean;
  since?: number;       // 毫秒时间戳
  until?: number;
  min_duration?: number; // 秒
  max_duration?: number;
  min_view?: number;     // 播放量范围（绝对值）
  max_view?: number;
  creator_id?: number;   // UP 详情页按 creator 精确过滤
  date_field?: 'first_seen' | 'published_at'; // since/until 比对列，默认 first_seen
  sort?: 'first_seen' | 'published_at' | 'title' | 'duration' | 'view';
  desc?: boolean;
  page?: number;
  size?: number;
}

// ── 统计看板 ──
export interface StatsOverview {
  videos: number; tracks: number; versions: number; creators: number;
  languages: number; categories: number;
  today_videos: number; // 当日本地 00:00 起入库视频数（采集页摘要行）
  first_seen_min: number | null; first_seen_max: number | null;
}
export interface KeyValue { key: string; count: number; }
export type StatsGroupBy = 'creator' | 'tname' | 'lang' | 'track-type' | 'tag';

// ── UP 主详情（对应 server getCreator / getCreatorBySourceUid）──
export interface CreatorDetail {
  id: number; source: string; source_uid: string;
  name: string | null; avatar: string | null; sign: string | null;
  level: number | null; sex: string | null;
  official_type: number | null; official_title: string | null;
  fans: number | null; following: number | null;
  category_agent_id: number | null; category_agent_name: string | null;
  category_human_id: number | null; category_human_name: string | null;
  first_seen_at: number; updated_at: number;
}
