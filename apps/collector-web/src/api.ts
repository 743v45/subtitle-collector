import type { VideoListItem, VideoDetail } from './types';

const BASE = '';

export async function listVideos(q = '', page = 1, size = 20): Promise<{ total: number; items: VideoListItem[] }> {
  const r = await fetch(`${BASE}/api/videos?q=${encodeURIComponent(q)}&page=${page}&size=${size}`);
  return r.json();
}

export async function getVideo(source: string, sourceVid: string): Promise<VideoDetail> {
  const r = await fetch(`${BASE}/api/videos/${source}/${encodeURIComponent(sourceVid)}`);
  return r.json();
}

export async function getVersion(versionId: number): Promise<{ version: { id: number; origin: string; payload: any; captured_at: number } }> {
  const r = await fetch(`${BASE}/api/versions/${versionId}`);
  return r.json();
}
