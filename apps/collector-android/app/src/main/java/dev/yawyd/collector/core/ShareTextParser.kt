package dev.yawyd.collector.core

import java.net.URI

data class SharePreview(val url: String, val platform: String)

// 分享文本本地预解析：确认页展示「平台 + 原链接」用。
// 镜像 server extractVideoUrl（apps/collector-server/src/tasks/tasks.ts）的 host 白名单与「只认第一个 URL」语义；
// 短链一律不展开（v.douyin.com 对齐 b23.tv：原样透传，权威展开在 server）。
// 抖音完整域多走一步本地提 aweme_id（镜像 server parseVideoUrl 的 douyin 分支）：
// video/<id> 与 ?modal_id= 两种形态归一成标准视频页 URL；提不出 ID 的非视频页返回 null 不误识别。
// 权威解析仍在 server（POST /api/collect-tasks 全链：提取→展开→parseVideoUrl），
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
    // 抖音短链域（分享口令文案里的 v.douyin.com/xxx，等同 b23.tv：本地不展开不提 ID）
    private val DY_SHORT_HOSTS = setOf("v.douyin.com")
    // 抖音完整域（web 标准页 www.douyin.com / 分享跳转域 iesdouyin.com，可本地提 aweme_id）
    private val DY_HOSTS = setOf("www.douyin.com", "iesdouyin.com", "www.iesdouyin.com")
    // aweme_id 现为 19 位数字，兼容历史更短位数（对齐参考项目 video/(\d+) 口径）
    private val DY_VIDEO_RE = Regex("""video/(\d+)""")

    // 对齐 server 语义：只认文本里第一个 URL；是白名单视频站 → 返回预览，否则 null（拒）。
    fun extract(text: String): SharePreview? {
        for (m in URL_RE.findAll(text)) {
            val host = runCatching { URI(m.value).host?.lowercase() }.getOrNull() ?: continue
            return when {
                host in BILI_HOSTS -> SharePreview(m.value, "bilibili")
                host in YT_HOSTS -> SharePreview(m.value, "youtube")
                host in DY_SHORT_HOSTS -> SharePreview(m.value, "douyin")
                host in DY_HOSTS -> douyinPreview(m.value)
                else -> null
            }
        }
        return null
    }

    // 完整域提 aweme_id：路径 video/<id>（含 iesdouyin 的 /share/video/<id>）优先，其次旧 ?modal_id= 查询形态；
    // 提出后回填标准视频页 URL（对齐 server「解析出 ID 回填标准 URL」结构）。提不出（用户主页/搜索页等）→ null。
    private fun douyinPreview(url: String): SharePreview? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val modalId = uri.rawQuery
            ?.split('&')
            ?.firstOrNull { it.startsWith("modal_id=") }
            ?.removePrefix("modal_id=")
            ?.takeIf { it.all(Char::isDigit) }
        val id = DY_VIDEO_RE.find(uri.path ?: "")?.groupValues?.get(1) ?: modalId ?: return null
        return SharePreview("https://www.douyin.com/video/$id", "douyin")
    }
}
