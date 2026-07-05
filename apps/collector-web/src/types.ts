// ── 视频元数据（extra 是服务端 JSON 字符串，由 api.ts 在入口处 JSON.parse 成对象）──
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
  view?: number | null; pic?: string | null;
}
export interface VideoInfo {
  title: string; creator_name: string | null; duration: number | null;
  extra?: VideoExtra;
  published_at?: number | null;
  status?: string;
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
export interface VideoDetail { video: VideoInfo; tracks: TrackInfo[]; }

export interface ClientInfo {
  client_id: string;
  ext_version: string | null;
  reporting_enabled: boolean;
  connected: true;
}

// ── 视频多维筛选（对应 server advanced.ts VideoFilter + ListFilter）──
export interface VideoFilter {
  q?: string;
  tid?: number;
  tname?: string;
  tag?: string;
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
  first_seen_min: number | null; first_seen_max: number | null;
}
export interface KeyValue { key: string; count: number; }
export type StatsGroupBy = 'creator' | 'tname' | 'lang' | 'track-type';

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
