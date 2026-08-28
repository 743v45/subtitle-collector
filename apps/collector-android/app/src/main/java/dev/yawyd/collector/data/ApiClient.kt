package dev.yawyd.collector.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder

// API 错误：status=0 表示未出发（配置缺失等）；message 尽量带 server error 文案
class ApiException(val status: Int, message: String) : Exception(message)

// collector-server HTTP 客户端（移动端唯一数据出口）。
// 认证通路：token 非空时带 Authorization: Bearer（server httpAuthOk 第 3 条路）；
// 原生请求不带 Origin 头 → server Origin 准入直接放行 —— server 侧零改动（2026-08-26 共识）。
// 错误约定：非 2xx 或响应畸形 → ApiException，error 文案对齐 web ensureOk 的带出逻辑。
class ApiClient(private val settings: SettingsRepository) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = HttpClient(OkHttp)

    private suspend fun call(method: HttpMethod, path: String, body: String? = null): HttpResponse {
        val cfg = settings.flow.first()
        if (!cfg.ready) throw ApiException(0, "未配置 server 地址（设置页填写后重试）")
        return client.request(cfg.url.trimEnd('/') + path) {
            this.method = method
            if (cfg.token.isNotBlank()) header(HttpHeaders.Authorization, "Bearer ${cfg.token}")
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }
    }

    // server 错误体 {ok:false,error:...} → 尽量抽出 error；带不出回落裸状态码
    private fun errorText(text: String, status: Int): String {
        val msg = runCatching {
            (json.parseToJsonElement(text) as? JsonObject)
                ?.get("error") as? JsonPrimitive
        }.getOrNull()?.content
        return if (msg.isNullOrBlank()) "HTTP $status" else msg
    }

    private suspend fun <T> unwrap(r: HttpResponse, decode: (String) -> T): T {
        val text = r.bodyAsText()
        if (!r.status.isSuccess()) throw ApiException(r.status.value, errorText(text, r.status.value))
        return try {
            decode(text)
        } catch (e: Exception) {
            // 解码层异常收敛为 ApiException（内层 ApiException 原样透传，见 wrapDecodeError）
            throw wrapDecodeError(e, r.status.value)
        }
    }

    private fun wrapDecodeError(e: Exception, status: Int): ApiException =
        if (e is ApiException) e else ApiException(status, "响应解析失败：${e.message}")

    /** 探活（/ping 是 server 唯一免鉴权路径）；配置缺失/网络不可达一律 false */
    suspend fun ping(): Boolean = try {
        call(HttpMethod.Get, "/ping").status.isSuccess()
    } catch (_: Exception) {
        false
    }

    /** 提交采集：text 为分享原文——server 提取 URL + 展开短链 + 解析视频（解析权威在 server） */
    suspend fun createTask(text: String): CreateTaskResult {
        val body = buildJsonObject { put("text", text) }.toString()
        return unwrap(call(HttpMethod.Post, "/api/collect-tasks", body)) {
            json.decodeFromString(CreateTaskResult.serializer(), it)
        }
    }

    /** 最近任务列表（采集页口径 limit 形态，非分页） */
    suspend fun listTasks(limit: Int): TaskListResult =
        unwrap(call(HttpMethod.Get, "/api/collect-tasks?limit=$limit")) {
            json.decodeFromString(TaskListResult.serializer(), it)
        }

    suspend fun deleteTask(id: Long) {
        unwrap(call(HttpMethod.Delete, "/api/collect-tasks/$id")) { /* 204/200 无消费体 */ }
    }

    /** failed/limited 任务原地重置回 pending 重跑（不建新行） */
    suspend fun retryTasks(ids: List<Long>): RetryResult {
        val body = buildJsonObject {
            put("ids", buildJsonArray { ids.forEach { add(it) } })
        }.toString()
        return unwrap(call(HttpMethod.Post, "/api/collect-tasks/retry", body)) {
            json.decodeFromString(RetryResult.serializer(), it)
        }
    }

    /** 视频库搜索（MVP：关键词 + 平台 + 分页；其余 20 维筛选后续按需加） */
    suspend fun listVideos(q: String?, source: String?, page: Int, size: Int): VideoListResult {
        val params = StringBuilder("?page=").append(page).append("&size=").append(size)
        if (!q.isNullOrBlank()) params.append("&q=").append(enc(q))
        if (!source.isNullOrBlank()) params.append("&source=").append(enc(source))
        return unwrap(call(HttpMethod.Get, "/api/videos$params")) {
            json.decodeFromString(VideoListResult.serializer(), it)
        }
    }

    suspend fun getVideo(source: String, vid: String): VideoDetailData =
        unwrap(call(HttpMethod.Get, "/api/videos/${enc(source)}/${enc(vid)}")) {
            json.decodeFromString(VideoDetailData.serializer(), it)
        }

    /** 字幕版本正文（响应 {ok,version:{payload:{body}}}，这里取嵌套的 version） */
    suspend fun getVersion(id: Long): VersionPayload =
        unwrap(call(HttpMethod.Get, "/api/versions/$id")) {
            json.decodeFromString(VersionResult.serializer(), it).version
        }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
