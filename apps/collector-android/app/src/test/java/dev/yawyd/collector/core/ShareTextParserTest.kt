/*
 * ShareTextParser 本地预解析测试。
 * 关键夹具：与 server extractVideoUrl（apps/collector-server/src/tasks/tasks.ts）对齐的
 * host 白名单与「只认第一个 URL」语义——server 才是解析权威，这里锁的是确认页预览行为。
 * 抖音组：短链透传（对齐 b23.tv 策略）+ 完整域提 aweme_id 归一（镜像 server parseVideoUrl douyin 分支）。
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
    fun `抖音分享文案混排短链识别为douyin`() {
        // 手机抖音 App 分享的典型形态：口令文案 + v.douyin.com 短链。
        // 短链本地不展开（对齐 b23.tv 策略），原样透传，权威展开在 server。
        val text = "8.88 复制打开抖音，看看【某博主】的作品 https://v.douyin.com/i2kXJhnK/ 复制此链接"
        val p = ShareTextParser.extract(text)
        assertEquals("douyin", p?.platform)
        assertEquals("https://v.douyin.com/i2kXJhnK/", p?.url)
    }

    @Test
    fun `抖音标准视频页链接识别并归一`() {
        // www.douyin.com/video/<19 位 aweme_id>：本地提 ID 回填标准视频页 URL（query 剥掉）
        val p = ShareTextParser.extract("https://www.douyin.com/video/7345678901234567890?previous_page=app")
        assertEquals("douyin", p?.platform)
        assertEquals("https://www.douyin.com/video/7345678901234567890", p?.url)
    }

    @Test
    fun `抖音modal_id旧形态归一为标准视频页`() {
        // 旧分享形态 ?modal_id=<id>：归一到 /video/<id>（modal_id 即 aweme_id 的查询参数形态）
        val p = ShareTextParser.extract("https://www.douyin.com/?modal_id=7345678901234567890")
        assertEquals("douyin", p?.platform)
        assertEquals("https://www.douyin.com/video/7345678901234567890", p?.url)
    }

    @Test
    fun `抖音video路径与modal_id并存时路径ID优先`() {
        // 用户页内点开的形态常两者并存：video/<id> 是主 ID，modal_id 不覆盖（对齐参考项目提取顺序）
        val p = ShareTextParser.extract("https://www.douyin.com/video/7111111111111111111?modal_id=7222222222222222222")
        assertEquals("https://www.douyin.com/video/7111111111111111111", p?.url)
    }

    @Test
    fun `iesdouyin分享跳转链接识别并归一`() {
        // iesdouyin.com 分享跳转域：/share/video/<id>/ 形态，同样本地提 ID 归一
        val p = ShareTextParser.extract("https://www.iesdouyin.com/share/video/7345678901234567890/?region=CN&mid=1")
        assertEquals("douyin", p?.platform)
        assertEquals("https://www.douyin.com/video/7345678901234567890", p?.url)
    }

    @Test
    fun `抖音非视频页不误识别`() {
        // host 在白名单但不是视频页（用户主页/搜索页）：本地不预览（null），提交后由 server 权威判
        assertNull(ShareTextParser.extract("https://www.douyin.com/user/MS4wLjABAAAAaGVudGp6dGdTdw"))
        assertNull(ShareTextParser.extract("https://www.douyin.com/search/%E6%B5%8B%E8%AF%95?type=video"))
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
