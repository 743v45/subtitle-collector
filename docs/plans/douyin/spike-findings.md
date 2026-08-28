# S1 spike 实测报告:抖音 web 采集路径(2026-08-29)

> 实测环境:chrome-devtools MCP 匿名 Chrome(无登录 cookie),macOS,直连+系统代理混合。
> 方法:真实打开 douyin.com 页面 → evaluate_script 读全局数据 → DevTools 抓 XHR → curl 直链探测。
> 原始证据:`_spike-raw/`(detail 响应 ×2、profile/other 响应、related 截断样例)。
> 除特别标注「推断」外,以下全部为**实测**结论。

## 0. TL;DR(对各任务的一句话输入)

| 任务 | 结论 |
|---|---|
| S3 扩展采集 | `_ROUTER_DATA` **已不存在**;实际双形态:`/video/<id>` 走 detail XHR(snake_case `aweme_detail`,148 键,与参考项目模型一致);分享落地 `/jingxuan?modal_id=` 走 SSR `SSR_RENDER_DATA.app.videoDetail`(camelCase)。**两条路都要实现** |
| S3 字幕 | 判据字段:`aweme_detail.is_subtitled`(int)+ `cla_info`;匿名实测 3 视频全 0/null(未见智能字幕);**ASR 兜底为主路径的预判被坐实**,登录态形态留给 S3 在真实浏览器验证 |
| S4 直链 | **`https://aweme.snssdk.com/aweme/v1/play/?video_id=<play_addr.uri>&ratio=1080p&line=0` 完全可用**:裸 curl(无 UA 无 cookie)→ 302 → douyinvod CDN → 206 video/mp4(H.264);playwm→play 替换**不需要**(web 端 URL 无 playwm) |
| S2 映射 | `play_count` **web 端恒 0**(两形态都 0)→ stat.view 映射需决策;duration 确认毫秒;博主页作品列表匿名被 gating(空体),扩展登录态无碍 |

## 1. 采集路径实测(核心假设修正)

### 1.1 `_ROUTER_DATA` 不存在,载体是 `SSR_RENDER_DATA`

- `window._ROUTER_DATA`:**未定义**(HTML 里也没有)
- `window.__INITIAL_STATE__`:未定义
- 实际 SSR 数据:`window.SSR_RENDER_DATA`(对象;另有 `EXPOSE_DATA`、`__INLINE_PLAYER_DATA__`(性能埋点,非视频数据))

### 1.2 两种页面形态,数据来源不同(都要支持)

| 形态 | 触发场景 | 详情数据来源 | 数据风格 |
|---|---|---|---|
| `/video/<aweme_id>` | 规范链接、站内导航 | **SPA XHR** `GET /aweme/v1/web/aweme/detail/?aweme_id=...`(匿名成功,status_code=0) | `aweme_detail` **snake_case,148 键**(与 Douyin_TikTok_Download_API 数据模型一致) |
| `/jingxuan?modal_id=<aweme_id>`(或旧 ID 302 落地到此) | 分享短链落地、精选页弹窗 | **SSR** `window.SSR_RENDER_DATA.app.videoDetail` | **camelCase,69 键**(web 专用结构) |

- 实测细节:
  - 打开旧 ID `7340499451280633147` → 302 重定向到 `/jingxuan?modal_id=7668187099408944399`(老视频 ID 会迁移,`modal_id` 查询参数形态真实存在,归一规则需覆盖)
  - `/jingxuan` 形态页面**不发** detail XHR(SSR 已全量);`/video/` 形态 SSR **不含** videoDetail(页面发 3 次 detail XHR,页面自身有多次拉取/重试)
  - detail XHR URL 必带页面签名:`a_bogus` + `msToken` + `verifyFp`/`fp` + `timestamp` + `x-secsdk-web-signature`(全部在 URL 上,请求头无签名)→ **印证 R1 定案:server 侧直构 XHR 不可行,扩展页面上下文是唯一正路**
- **S3 实现含义**:inject-dy.js(MAIN world)双路取数——① 轮询 `SSR_RENDER_DATA.app.videoDetail`;② hook XHR(`XMLHttpRequest`/fetch)捕获 `/aweme/v1/web/aweme/detail/` 响应;两路任一命中即归一,内部统一成 snake_case `aweme_detail` 形态(字段全,camelCase 是子集映射)

### 1.3 可复制取值片段(实测路径)

`/jingxuan?modal_id=` SSR 形态:

```js
// MAIN world 注入脚本可直接读(hydrate 完成后)
const vd = window.SSR_RENDER_DATA?.app?.videoDetail;
// vd.awemeId === '7668187099408944399'
// vd.desc / vd.caption        —— 文案(含 #话题原文)
// vd.awemeType                —— 0=视频
// vd.createTime               —— unix 秒(1785388945)
// vd.video.duration           —— 毫秒(507467 = 507.4s,与 <video>.duration=507.434 一致)
// vd.video.uri                —— 'v0d00fg10000d9ld257og65s7fo674bg'(稳定 video_id)
// vd.video.playAddr           —— [{src: 'https://v11-weba.douyinvod.com/...'}, {src: '...v26-web...'}]
// vd.video.playApi            —— 'https://www.douyin.com/aweme/v1/play/?...&video_id=<uri>&sign=...'
// vd.video.bitRateList        —— 31 档(含 uri/playAddr/playApi/isH265/gearName/fps…)
// vd.stats                    —— {playCount:0, diggCount, commentCount, shareCount, collectCount, …}
// vd.authorInfo               —— {uid, secUid, nickname, avatarUri, followerCount, totalFavorited, avatarThumb}
// vd.textExtra                —— [{hashtagId, hashtagName, start, end, type:1, …}]
// vd.mixInfo                  —— {mixId, mixName, desc, currentEpisode, totalEpisode, …}
// vd.music / vd.chapterInfo   —— BGM 元数据 / AI 章节(≠字幕)
```

`/video/<id>` XHR 形态(`/aweme/v1/web/aweme/detail/` 响应):

```jsonc
{
  "status_code": 0,
  "aweme_detail": {           // 148 键,snake_case
    "aweme_id": "7678956479035512448",
    "desc": "...", "caption": "...(同 desc)",
    "aweme_type": 0, "is_subtitled": 0, "cla_info": null,
    "create_time": 1787896381,
    "duration": 47948,        // 注:顶层 duration 毫秒;video.duration 也是毫秒
    "author": { "sec_uid": "MS4wLjAB...", "uid": "...", "nickname": "...",
                "signature": "...", "follower_count": "13226", "total_favorited": "48667", ... },
    "statistics": { "play_count": 0, "digg_count": 28, "comment_count": 4,
                    "share_count": 8, "collect_count": 16, ... },
    "video": {
      "duration": 47948, "has_watermark": true, "format": "mp4",
      "play_addr": { "uri": "v0300fg10000da8i3knog65s9j5g544g",
                     "url_list": ["https://v26-web.douyinvod.com/..."], ... },
      "bit_rate": [ { "gear_name": "normal_720_0", "bit_rate": 1078761,
                      "play_addr": {...同构...} }, ... 4 档 ],
      "download_addr": {...}, "origin_cover"/"dynamic_cover"/"cover": {url_list},
      ... },
    "text_extra": [ { "hashtag_id": "...", "hashtag_name": "...", ... } ],
    "mix_info": null, "chapter_list": [...], ...
  }
}
```

(完整样例见 `_spike-raw/detail-response*.network-response`)

### 1.4 关键字段陷阱(给 S2/S5)

1. **`play_count` 恒 0**:SSR `stats.playCount=0`、XHR `statistics.play_count=0`(不同类型/时长视频均如此)。web 端不回播放数 → R5 定案的 `stat.view=play_count` 在 douyin 上是 0。**建议**:照存 0(结构对齐优先),web 展示/排序对 douyin 视频把「播放」列显示为 `—`(S5 决策);不为此改 schema。
2. **duration 毫秒**:507467ms ↔ `<video>.duration`=507.434s 实测互证;入库 /1000。
3. **`has_watermark: true`** 出现在 XHR 形态(SSR camelCase 无此键),但 play_addr.url_list 域名是 `v26-web.douyinvod.com`(无 playwm 字样)。水印是否实际烙印在画面上未验证(需抽帧)——S4 下载后抽查即可,不阻塞。
4. **camelCase↔snake_case 双形态**:S3 统一归一到 snake_case(字段更全、与参考项目/S2 映射表一致);SSR 形态做一层字段名映射。
5. `mixInfo.mixId/mixName` ↔ `mix_info.mix_id/mix_desc`;合集含 `currentEpisode/totalEpisode`(B 站无此维,可进 extra)。
6. `sec_uid` 在 authorInfo(XHR author)与 SSR authorInfo 一致;`follower_count` XHR 是**字符串**('13226'),SSR 是数字——归一时注意。

## 2. 智能字幕验证

- **判据字段已定位**(detail XHR 响应):`aweme_detail.is_subtitled`(0/1)+ `aweme_detail.cla_info`(null 或对象)。related 列表接口**不含**这两字段(只有 detail 有)。
- **匿名实测 3 个不同类型视频全部无字幕**:

| 视频 | 时长 | is_subtitled | cla_info | 播放器 texttrack |
|---|---|---|---|---|
| 影视解说《扫毒风暴》(jingxuan SSR) | 507s | (SSR 无此键) | 无 | `textTrack: []`,字幕按钮隐藏 |
| 英语口播教学 | 47s | 0 | null | 空,按钮隐藏 |
| 英语听力材料 | 391s | 0 | null | 空,按钮隐藏 |

- 播放器是 **xgplayer**,字幕插件 `texttrack`(`window.player.getPlugin('textTrack')`,`subTitles/optionsList` 空串 + 按钮隐藏 = 无轨道);AB 配置 `backendAbTest.subtitles = {enable:1, language_list:[zh-Hans-CN, en-US], ...}`(功能全站开启,`subtitleDefaultOpen:0` 默认关)。
- **结论(实测)**:匿名态拿不到智能字幕数据;「页面有字幕数据就拿,预期主路径是 ASR 兜底」的 R1 预判成立。登录态/特定视频是否有 cla_info 数据、其具体结构(caption_formats[].url 形态)**推断**为 TikTok 同源生态结构(`cla_info.caption_formats[]` → 字幕 JSON URL),标注推断,S3 在用户真实登录浏览器里碰到 `is_subtitled=1` 样本时补验。
- 页面网络请求中无任何 caption/subtitle/webvtt XHR(无字幕时);播放器走 DASH(`media-video-hvc1` + `media-audio-und-mp4a` 分离流,blob: MSE)。**弹幕**(措辞注意:弹幕≠字幕)另有 `danmaku/get_v2` 接口按 `start_time/end_time` 分段拉取,与本项目无关,仅备案。

## 3. 博主页(`/user/<sec_uid>`)

- **SSR 不含博主信息与作品列表**(app 键全是环境数据);博主资料由 XHR `GET /aweme/v1/web/user/profile/other/?sec_user_id=...` 提供(匿名成功,`status_code:0`,snake_case:`sec_uid/nickname/signature/follower_count/following_count/total_favorited/aweme_count/ip_location`——完整样例见 `_spike-raw/profile-other-response.network-response`)。
- **作品列表 XHR**:`GET /aweme/v1/web/aweme/post/?...&sec_user_id=<sec_uid>&max_cursor=0&count=18&locate_query=false&show_live_replay_strategy=1&need_time_list=1&time_list_query=0&whale_cut_token=&cut_version=1&publish_video_strategy_type=2&from_user_page=1&...&msToken=...&a_bogus=...&timestamp=...&x-secsdk-web-signature=...`
  - 游标参数确认:`max_cursor`(0 起)+ `count`(18/页);翻页游标在响应里(max_cursor/has_more,与调研一致)
  - **匿名实测两次(首开+reload)均 200 + `content-length: 0` 空体**——post 列表被 gating 在登录后(风控静默失败模式:200 空体,非 4xx)
  - 匿名下页面形态:博主资料完整(SSR 渲染)+ 登录弹窗 + 作品网格空;DOM 里另有 `?source=Baiduspider` 的 SEO 降级链接(少量 /video/ URL,不可靠,勿用)
- **S3 含义**:博主批量(expandUpperVideos douyin 分支)在扩展里 hook post XHR 响应即可(用户登录态);匿名环境(如无痕)会拿到空体,扩展要能识别「200 空体=未登录/风控」并给回执 reason,不要当成「该博主 0 作品」。
- 搜索页 `/search/...`:匿名直接跳**验证码中间页**(未尝试绕过,按约束记录现状)——印证 R3 砍掉搜索采集无误。

## 4. 直链下载实测(S4 输入)

实测对象:两个视频的 `play_addr.uri`(v0d00fg10000d9ld257og65s7fo674bg / v0300fg10000da8i3knog65s9j5g544g),curl range 0-1023 探测:

| # | 链路 | 实测结果 | 需要的头 |
|---|---|---|---|
| 1 | **直构** `https://aweme.snssdk.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0` | **302 → douyinvod CDN → 206 `video/mp4`**(ftyp isom/avc1=H.264);两视频均通 | **零依赖**:无 UA、无 cookie、无 Referer 裸 curl 即通(建议仍带 Chrome UA + Referer 礼貌头) |
| 2 | `video.playApi`(SSR 内嵌,`www.douyin.com/aweme/v1/play/?...&video_id=&sign=&biz_sign=`) | 302 → CDN,裸 curl 通(URL 里的 sign/biz_sign 未被强校验) | 同上 |
| 3 | `video.playAddr[0].src`(SSR 内嵌 douyinvod 直 URL) | 直接 206 `video/mp4` | 零依赖;但 URL 带过期参数(`/1787958000` 形态),短时效,须现解析现用 |
| 4 | playwm→play 替换 | **不需要**:web 端 url_list 无 playwm 域(旧 APP 时代逻辑);R2 设计里的「playwm→play 降级」可直接砍掉,降级链改为 `uri 直构 → playApi/playAddr 现取(经扩展重解析)` | — |
| 5 | ratio/line 参数 | `ratio=540p` 重定向到**不同转码对象**(档位生效,非同文件);`line=0/1` 都通(双线路) | — |

**S4 结论:主链 = 库里存的 `extra.play_uri` 直构 #1 链**(server 侧裸 fetch 即可,零 cookie 零签名);失败降级 = 扩展在线时重开视频页拿新 playApi/playAddr(#2/#3)。mp4(H.264+AAC)直接 multipart 喂 fireredasr ✅。

## 5. 匿名 vs 登录差异汇总

| 能力 | 匿名(实测) | 扩展用户态(推断,依据) |
|---|---|---|
| 视频详情(SSR/detail XHR) | ✅ 完整 | ✅(同链路+登录 cookie,只会更松) |
| profile/other(博主资料) | ✅ | ✅ |
| post 作品列表 XHR | ❌ 200 空体(两次复现) | ✅ 可用(抖音 web 自身已登录用户即走此接口) |
| 搜索页 | ❌ 验证码中间页 | 未验证(与本项目无关) |
| 直链下载(全部链路) | ✅ 零依赖 | ✅ |

风控观察:全程约 7 次导航无验证码无封禁;失败模式均为**静默**(200 空体/重定向),不会给错误码——S3 的日志设计必须把「空响应」当一等错误路径(对齐 CLAUDE.md §9 可观察性:记录 content-length、命中字段计数)。

## 6. 对各任务的实施建议与风险

**S3(扩展端)**
- 双路取数(SSR videoDetail + detail XHR hook),归一到 snake_case;两路都有才稳(SSR 版本会漂移,XHR 形态是抖音自家 SPA 依赖的接口,更稳)
- URL 归一:`/video/<id>`、`/jingxuan?modal_id=<id>`、`?modal_id=`、旧 ID 302 落地,最终都取 19 位 aweme_id;v.douyin.com 短链 302 直跳最终 URL(lux extractor 先例,推断同调研)
- 字幕:`is_subtitled===1 && cla_info` 才走字幕分支,否则 no-subtitle 标签 → ASR 轨
- 博主页 post 空体识别与回执;版本号 bump

**S2(server)**
- stat:play_count=0 照存(view=0),web 端展示 `—`;dur/1000;create_time 秒;creators.source_uid=sec_uid(follower_count 字符串→数字)
- extra.play_uri 存 `video.play_addr.uri`(两形态都有)✅ R5 不变

**S4(ASR)**
- 主链直构,已验证;下载器带 UA+Referer 礼貌头;输出抽查水印与音轨(fireredasr 兼容 mp4)

**S5(web)**
- douyin 播放数列显示策略(0→`—`);「标签档位=B站」文案改「平台自带」(R5 既定)

**风险登记**
1. SSR 字段名(`SSR_RENDER_DATA.app.videoDetail`)随前端版本漂移 → 双路冗余 + 取数失败日志带特征计数
2. 直构链无文档承诺,aweme.snssdk.com 是 APP 时代接口,若哪天下线 → 降级链(#2/#3 经扩展重解析)兜底,S4 两级降级必做
3. cla_info 登录态形态未验证(推断 TikTok 同源)→ S3 遇到真实样本时补验
4. has_watermark=true 但 web URL 无 playwm:水印疑云未解,S4 抽帧即可,不影响架构

## 7. 原始证据索引(_spike-raw/,已脱敏说明)

- `detail-response.network-response`:`/video/7678956479035512448` 的 detail XHR 响应(aweme_detail 148 键完整样例)
- `detail-response-2.network-response`:`/video/7662377226566542464` 的 detail XHR 响应(含 is_subtitled=0)
- `profile-other-response.network-response`:洛克影视 profile/other 响应(creators 映射样例)
- `related-response.network-response`:related 接口截断样例(原 10 项留 3 项,注意 related **无** is_subtitled 字段)
- SSR videoDetail 完整结构未落盘(69 键摘录见 §1.3;需要时重开 jingxuan 页 dump)
