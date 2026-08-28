/*
 * ShareTextParser 本地预解析测试。
 * 关键夹具：与 server extractVideoUrl（apps/collector-server/src/tasks/tasks.ts）对齐的
 * host 白名单与「只认第一个 URL」语义——server 才是解析权威，这里锁的是确认页预览行为。
 */
package dev.yawyd.collector.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShareTextParserTest {

    @Test
    fun `B站分享文案混排短链识别为bilibili`() {
        // 手机 B 站 App 分享出来的典型形态：口令文案 + b23.tv 短链
        val text = "【某技术向视频标题】 快来看！ https://b23.tv/AbCdEfG 分享自哔哩哔哩"
        val p = ShareTextParser.extract(text)
        assertEquals("bilibili", p?.platform)
        assertEquals("https://b23.tv/AbCdEfG", p?.url)
    }

    @Test
    fun `YouTube短链youtu点be识别为youtube`() {
        val p = ShareTextParser.extract("看看这个 https://youtu.be/dQw4w9WgXcQ?si=xyz")
        assertEquals("youtube", p?.platform)
        assertEquals("https://youtu.be/dQw4w9WgXcQ?si=xyz", p?.url)
    }

    @Test
    fun `YouTube标准watch链接识别`() {
        val p = ShareTextParser.extract("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        assertEquals("youtube", p?.platform)
    }

    @Test
    fun `B站视频页链接识别`() {
        val p = ShareTextParser.extract("https://www.bilibili.com/video/BV1xx411c7mD?p=1")
        assertEquals("bilibili", p?.platform)
    }

    @Test
    fun `短链host大写仍识别`() {
        // URI().host 不做小写化（new URL().hostname 会），这里显式 lowercase 对齐 server 语义
        val p = ShareTextParser.extract("https://B23.TV/AbCdEfG")
        assertEquals("bilibili", p?.platform)
    }

    @Test
    fun `第一个URL非视频站直接拒`() {
        // 对齐 server：只认第一个 URL——前面混了非白名单站链接时整条拒（返回 null 走 server 兜底文案）
        val p = ShareTextParser.extract("先看这个 https://example.com/x 然后https://b23.tv/AbCdEfG")
        assertNull(p)
    }

    @Test
    fun `纯文本无URL返回null`() {
        assertNull(ShareTextParser.extract("就是一段普通文字，没有链接"))
    }

    @Test
    fun `空白输入返回null`() {
        assertNull(ShareTextParser.extract(""))
    }
}
