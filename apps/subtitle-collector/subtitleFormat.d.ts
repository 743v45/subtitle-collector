// apps/subtitle-collector/subtitleFormat.d.ts
// 供 popup TS import 的类型声明（纯类型，无运行时）。

export type SubtitleFormat = 'text' | 'timestamp' | 'srt';

export const SUBTITLE_FORMATS: readonly SubtitleFormat[];

export interface SubtitleCue {
  from?: number;
  to?: number;
  content?: string;
}

export type SubtitleBody = { body?: SubtitleCue[] } | unknown;

export function extractCues(body: SubtitleBody): SubtitleCue[];
export function subtitleToPlainText(body: SubtitleBody): string;
export function subtitleToTimestamped(body: SubtitleBody): string;
export function subtitleToSRT(body: SubtitleBody): string;
export function formatSubtitle(body: SubtitleBody, fmt: SubtitleFormat): string;
