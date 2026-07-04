// apps/subtitle-collector/subtitleFormat.d.ts
// 供 popup TS import 的类型声明（纯类型，无运行时）。
// 不导出 SubtitleBody：popup 用 src/popup/types.ts 自己的 SubtitleBody，避免同名异义 smell。

export type SubtitleFormat = 'text' | 'timestamp' | 'srt';

export const SUBTITLE_FORMATS: readonly SubtitleFormat[];

export interface SubtitleCue {
  from?: number;
  to?: number;
  content?: string;
}

export type SubtitleInput =
  | { body?: SubtitleCue[] }
  | readonly unknown[]
  | null
  | undefined;

export function extractCues(body: SubtitleInput): SubtitleCue[];
export function subtitleToPlainText(body: SubtitleInput): string;
export function subtitleToTimestamped(body: SubtitleInput): string;
export function subtitleToSRT(body: SubtitleInput): string;
export function formatSubtitle(body: SubtitleInput, fmt: SubtitleFormat): string;
