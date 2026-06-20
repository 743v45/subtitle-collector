import type { VideoListItem, VideoDetail } from './types';
import type { SubtitleLine } from '@/components/SubtitleView';

const BASE = '';

async function ensureOk<T>(r: Response, parse: (json: any) => T): Promise<T> {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (json.ok === false) throw new Error(json.error ?? 'API error');
  return parse(json);
}

export async function listVideos(q = '', page = 1, size = 20): Promise<{ total: number; items: VideoListItem[] }> {
  const r = await fetch(`${BASE}/api/videos?q=${encodeURIComponent(q)}&page=${page}&size=${size}`);
  return ensureOk(r, (j) => ({ total: j.total, items: j.items }));
}

export async function getVideo(source: string, sourceVid: string): Promise<VideoDetail> {
  const r = await fetch(`${BASE}/api/videos/${source}/${encodeURIComponent(sourceVid)}`);
  return ensureOk(r, (j) => ({ video: j.video, tracks: j.tracks }));
}

export async function getVersion(versionId: number): Promise<{ version: { id: number; origin: string; payload: { body: SubtitleLine[] }; captured_at: number } }> {
  const r = await fetch(`${BASE}/api/versions/${versionId}`);
  return ensureOk(r, (j) => j);
}
