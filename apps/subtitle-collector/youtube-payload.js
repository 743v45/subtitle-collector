// 组装 YouTube ingest payload（结构对齐 buildIngestPayload，仅 source='youtube' + 字段来源不同）。
// 契约依据：docs/superpowers/specs/2026-07-19-youtube-collector-design.md §5.4。
// 形参 captionTracks / bodies 的形状见 §5.1（inject-yt 抽取）与 §5.4（content-yt 聚合后传入）。
//
// ⚠ R6（track_type 类型）核对结论：
//   collector-server 的 subtitle_tracks.track_type 列是 INTEGER（schema.sql:66），
//   TS 接口 IngestTrack.track_type: number（ingest.ts:25）。B 站语义：1=AI/asr（自动生成）、
//   2=CC/manual（人工），见 bili-fetch.js:59 与 collector-server/src/db/advanced.ts:18、
//   queries.ts:41-42（trackPriority 按 1/2 排序）。因此 YouTube 的 kind（'asr' 字符串 / null）
//   不能直接入库，必须按下表映射为整数：
//     kind === 'asr'  → 1（自动生成，与 B 站 AI 字幕同义）
//     kind === null   → 2（人工字幕，与 B 站 CC 同义）
//   不采用 spec §5.4 注释里「null→0」的字面建议：0 在全代码库无使用、trackPriority 不识别、
//   且会让人工字幕失去 CC 优先级。此处按 spec 明确的「看 B 站语义」指引取 2。

/**
 * YouTube captionTrack.kind → server track_type (INTEGER) 映射。
 *
 * captionTracks[].kind 仅 'asr'（自动生成）或 null（人工），见 spec §5.1。
 * 对齐 B 站 track_type 语义（1=AI/asr、2=CC/manual），使 YouTube 轨可进同一套
 * collector-server / collector-web 排序与过滤逻辑（如 trackPriority 的 zh CC 优先级）。
 *
 * @param {string|null|undefined} kind captionTrack.kind
 * @returns {number} 1=asr(自动生成) / 2=人工
 */
export function kindToTrackType(kind) {
  return kind === 'asr' ? 1 : 2;
}

/**
 * 组装 source='youtube' 的 ingest payload（与 buildIngestPayload 同构）。
 *
 * @param {object} args
 * @param {string} args.videoId 11 位 YouTube videoId（落 video.source_vid）
 * @param {string|null} [args.title] 视频标题
 * @param {string|null} [args.channelId] 频道 ID（落 creator.source_uid；缺失→'unknown'）
 * @param {string|null} [args.channelName] 频道名（落 creator.name）
 * @param {string|null} [args.avatar] 频道头像 URL
 * @param {number|null} [args.duration] 视频时长（秒）
 * @param {number|null} [args.publishedAt] 发布时间（ms 纪元）
 * @param {string|number|null} [args.viewCount] 播放数（落 extra.stat.view）
 * @param {string|number|null} [args.likeCount] 点赞数（落 extra.stat.like）
 * @param {string|null} [args.shortDescription] 视频简介（落 extra.desc）
 * @param {Array<{baseUrl:string, languageCode:string, kind:string|null, name:string}>} [args.captionTracks]
 *        inject-yt 抽取的字幕轨元数据（spec §5.1）
 * @param {Record<string, {body:Array<{from:number,to:number,content:string}>}>} [args.bodies]
 *        以 captionTrack.baseUrl 为 key 的已归一化 cue 数组（FETCH_SUBTITLE 兜底 + TIMEDTEXT_BODY 拦截合并）
 * @returns {{source:'youtube', video:object, tracks:Array<object>}}
 *          与 buildIngestPayload 同构的 ingest payload
 */
export function buildYoutubePayload({
  videoId,
  title,
  channelId,
  channelName,
  avatar,
  duration,
  publishedAt,
  viewCount,
  likeCount,
  shortDescription,
  captionTracks,
  bodies,
}) {
  return {
    source: 'youtube',
    video: {
      source_vid: videoId,
      creator: {
        source_uid: String(channelId ?? 'unknown'),
        name: channelName ?? null,
        avatar: avatar ?? null,
      },
      title,
      extra: {
        // 对齐 B 站 extra 结构（stat.view/like + desc），让 collector-web 列表/筛选/CLI 对 YouTube 一视同仁
        stat: {
          view: viewCount != null ? Number(viewCount) : null,
          like: likeCount != null ? Number(likeCount) : null,
        },
        desc: shortDescription ?? null,
      },
      duration: duration ?? null,
      published_at: publishedAt ?? null,
    },
    tracks: (captionTracks ?? []).map((t) => ({
      lan: t.languageCode,
      lan_doc: t.name,
      track_type: kindToTrackType(t.kind),
      versions: [{
        origin: 'external',
        payload: bodies?.[t.baseUrl] ?? null, // 保留 {body:[...]} 外层，与 B 站 buildIngestPayload 的 subtitleBodies 形状一致（下游 collector-web/CLI/subtitleFormat 零特殊处理）；缺失轨→null
        source_url: t.baseUrl,
      }],
    })),
  };
}
