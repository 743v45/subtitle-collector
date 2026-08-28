package dev.yawyd.collector.data

import kotlinx.serialization.Serializable

// ── API 契约快照（与 collector-server HTTP 接口一一对应，字段名 snake_case 对齐 server）──
// server 是 TS 手写路由、无 schema，本文件即移动端契约；全部字段给默认值 + ApiClient
// 配 ignoreUnknownKeys，server 增列/缺列均不崩。时间戳一律毫秒（server Date.now() 口径）。

// 采集任务行（collect_tasks 表 + LEFT JOIN videos/creators 的展示冗余列）
@Serializable
data class CollectTask(
    val id: Long = 0,
    val source: String = "",
    val source_vid: String = "",
    val url: String = "",
    val status: String = "pending", // pending|dispatched|succeeded|failed|limited（limited=字幕受限终态，可重试）
    val client_id: String? = null,
    val batch_id: String? = null,
    val error: String? = null,
    val result: String? = null, // 扩展回执 JSON 字符串
    val title: String? = null, // 库内标题（未入库 null）
    val creator_name: String? = null,
    val creator_source_uid: String? = null,
    val created_at: Long = 0,
    val finished_at: Long? = null,
) {
    /** 终态（succeeded/failed/limited）；pending/dispatched 为在途 */
    fun isDone(): Boolean = status == "succeeded" || status == "failed" || status == "limited"
}

@Serializable
data class TaskListResult(val total: Int = 0, val items: List<CollectTask> = emptyList())

// POST /api/collect-tasks 响应（ok 之外的顶层字段）；created=false = 同视频已有在途任务
@Serializable
data class CreateTaskResult(val task: CollectTask = CollectTask(), val created: Boolean = false)

@Serializable
data class RetryResult(val retried: Int = 0, val tasks: List<CollectTask> = emptyList())

@Serializable
data class VideoListItem(
    val id: Long = 0,
    val source: String = "",
    val source_vid: String = "",
    val title: String = "",
    val creator_name: String? = null,
    val duration: Long? = null, // 秒
    val published_at: Long? = null, // 毫秒
    val track_count: Int = 0,
    val first_seen_at: Long = 0,
    val view: Long? = null,
    val pic: String? = null, // 封面 URL（extra.pic 归一 https:）
)

@Serializable
data class VideoListResult(val total: Int = 0, val items: List<VideoListItem> = emptyList())

@Serializable
data class VideoInfo(
    val title: String = "",
    val creator_name: String? = null,
    val duration: Long? = null,
    val published_at: Long? = null,
    val source: String? = null,
    val source_vid: String? = null,
    val extra: String? = null, // server 侧 TEXT（JSON 字符串），按需二次解析
)

@Serializable
data class VersionInfo(
    val id: Long = 0,
    val origin: String = "",
    val captured_at: Long = 0,
    val body_size: Long? = null,
    val is_default: Boolean = false,
)

@Serializable
data class TrackInfo(
    val id: Long = 0,
    val lan: String? = null,
    val lan_doc: String? = null,
    val is_default: Boolean = false,
    val versions: List<VersionInfo> = emptyList(),
)

// GET /api/videos/:source/:vid 响应（ok 之外的顶层字段）
@Serializable
data class VideoDetailData(
    val video: VideoInfo = VideoInfo(),
    val tracks: List<TrackInfo> = emptyList(),
)

// 字幕正文一行（契约同 web SubtitleView 的 SubtitleLine：from/to 秒、content 文本）
@Serializable
data class SubtitleLine(val from: Double = 0.0, val to: Double = 0.0, val content: String = "")

@Serializable
data class SubtitlePayload(val body: List<SubtitleLine> = emptyList())

@Serializable
data class VersionPayload(
    val id: Long = 0,
    val origin: String = "",
    val captured_at: Long = 0,
    val payload: SubtitlePayload = SubtitlePayload(),
)

// GET /api/versions/:id 响应外层（version 字段嵌套一层）
@Serializable
data class VersionResult(val version: VersionPayload = VersionPayload())
