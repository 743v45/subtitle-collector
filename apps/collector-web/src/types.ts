export interface VideoListItem {
  id: number; source: string; source_vid: string; title: string;
  creator_name: string | null; duration: number | null;
  track_count: number; first_seen_at: number;
}
export interface VideoInfo {
  title: string; creator_name: string | null; duration: number | null;
  extra?: { pic?: string; aid?: number; cid?: number; [k: string]: unknown };
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
