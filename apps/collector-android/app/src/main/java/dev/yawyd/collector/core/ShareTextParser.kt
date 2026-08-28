package dev.yawyd.collector.core

import java.net.URI

data class SharePreview(val url: String, val platform: String)

// 分享文本本地预解析：确认页展示「平台 + 原链接」用。
// 只镜像 server extractVideoUrl 的 host 白名单（tasks.ts），不做短链展开与视频 ID 解析——
// 权威解析在 server（POST /api/collect-tasks 全链：提取→展开→parseVideoUrl），
// 本地预判失败时以 server 的 400 文案为准（可观察性：解析失败在确认页可见）。
object ShareTextParser {
    private val URL_RE = Regex("""https?://[^\s<>"')\]]+""")
    private val BILI_HOSTS = setOf(
        "b23.tv", "bili2233.cn", "bili2233.com",
        "www.bilibili.com", "bilibili.com", "m.bilibili.com",
    )
    private val YT_HOSTS = setOf(
        "youtu.be", "www.youtu.be",
        "www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com",
    )

    // 对齐 server 语义：只认文本里第一个 URL；是白名单视频站 → 返回预览，否则 null（拒）。
    fun extract(text: String): SharePreview? {
        for (m in URL_RE.findAll(text)) {
            val host = runCatching { URI(m.value).host?.lowercase() }.getOrNull() ?: continue
            return when {
                host in BILI_HOSTS -> SharePreview(m.value, "bilibili")
                host in YT_HOSTS -> SharePreview(m.value, "youtube")
                else -> null
            }
        }
        return null
    }
}
