/*
 * API 契约模型解码测试。
 * 关键夹具：从 collector-server 实际响应形态手抄的 JSON 样例（server 无 schema，
 * 本文件锁字段名/嵌套层级不漂移）；全部模型字段带默认值 + ignoreUnknownKeys，
 * 样例里故意混入未知字段与缺失字段验证容错。
 */
package dev.yawyd.collector.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `任务行JSON解码含未知字段与冗余展示列`() {
        // collect_tasks 行含 web 类型之外的列（creator_uid 等），移动端模型须容忍
        val raw = """
            {"id":42,"source":"bilibili","source_vid":"BV1xx411c7mD",
             "url":"https://www.bilibili.com/video/BV1xx411c7mD","status":"dispatched",
             "client_id":"client-a","batch_id":null,"error":null,"result":null,
             "title":"某技术向视频","creator_name":"某UP","creator_source_uid":"12345",
             "created_at":1756100000000,"finished_at":null,
             "creator_uid":"12345","creator_client_id":null}
        """.trimIndent()
        val t = json.decodeFromString(CollectTask.serializer(), raw)
        assertEquals(42L, t.id)
        assertEquals("dispatched", t.status)
        assertEquals("某技术向视频", t.title)
        assertEquals(1756100000000L, t.created_at)
        assertNull(t.finished_at)
    }

    @Test
    fun `缺字段的任务行回落默认值不崩`() {
        // 老版本 server/极端行缺 title/creator_name 等：默认值兜底
        val raw = """{"id":1,"source":"youtube","source_vid":"dQw4w9WgXcQ","url":"u","status":"pending","created_at":1}"""
        val t = json.decodeFromString(CollectTask.serializer(), raw)
        assertNull(t.title)
        assertNull(t.error)
        assertFalse(t.isDone())
    }

    @Test
    fun `创建任务响应解出created标志`() {
        // 同视频已有在途任务时 server 返回 created:false + 既有任务
        val raw = """{"ok":true,"created":false,"task":{"id":7,"source":"bilibili",
                     "source_vid":"BV1xx411c7mD","url":"u","status":"pending","created_at":2}}"""
        val r = json.decodeFromString(CreateTaskResult.serializer(), raw)
        assertFalse(r.created)
        assertEquals(7L, r.task.id)
    }

    @Test
    fun `视频列表行解码`() {
        val r = json.decodeFromString(
            VideoListResult.serializer(),
            """{"ok":true,"total":1,"items":[{"id":3,"source":"bilibili","source_vid":"BV1xx411c7mD",
               "title":"标题A","creator_name":"UP甲","duration":754,"published_at":1756000000000,
               "track_count":2,"first_seen_at":1756100000000,"view":12345,"pic":"https://i0.hdslb.com/bfs/x.jpg",
               "tid":122,"tname":"野生技术协会","unknown_extra":true}]}""",
        )
        assertEquals(1, r.total)
        assertEquals("标题A", r.items[0].title)
        assertEquals(2, r.items[0].track_count)
        assertEquals("https://i0.hdslb.com/bfs/x.jpg", r.items[0].pic)
    }

    @Test
    fun `视频详情解出轨道与版本`() {
        val d = json.decodeFromString(
            VideoDetailData.serializer(),
            """{"ok":true,"video":{"title":"标题B","creator_name":"UP乙","duration":100,"source":"youtube"},
               "tracks":[{"id":9,"lan":"zh-Hans","lan_doc":"中文（简体）","is_default":true,
                          "versions":[{"id":101,"origin":"ai","captured_at":1756050000000,"body_size":9000,"is_default":true},
                                      {"id":102,"origin":"manual","captured_at":1756060000000}]}]}""",
        )
        assertEquals("标题B", d.video.title)
        assertEquals(1, d.tracks.size)
        assertEquals("中文（简体）", d.tracks[0].lan_doc)
        assertEquals(2, d.tracks[0].versions.size)
        assertTrue(d.tracks[0].versions[0].is_default)
        assertFalse(d.tracks[0].versions[1].is_default)
    }

    @Test
    fun `字幕版本正文解嵌套payload与行字段`() {
        // GET /api/versions/:id 响应是 {ok,version:{payload:{body}}} 三层嵌套；
        // 行字段契约 = web SubtitleView 的 SubtitleLine：from/to/content
        val r = json.decodeFromString(
            VersionResult.serializer(),
            """{"ok":true,"version":{"id":101,"origin":"ai","captured_at":1756050000000,
               "payload":{"body":[{"from":0.0,"to":2.5,"content":"大家好"},{"from":2.5,"to":5.0,"content":"今天讲"}]}}}""",
        )
        val body = r.version.payload.body
        assertEquals(2, body.size)
        assertEquals(2.5, body[0].to, 1e-9)
        assertEquals("大家好", body[0].content)
    }
}
