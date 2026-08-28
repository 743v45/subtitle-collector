# 调研:Douyin_TikTok_Download_API 数据模型(2026-08-29,agent: douyin-api-research)

> 原文来自调研 agent 报告,落盘防上下文压缩丢失。参考项目:`/Users/taevas/Code/opensource/Douyin_TikTok_Download_API`(纯 Python/FastAPI 常驻服务,HEAD 42784ff,最后提交 2025-10-12 ≈10.5 个月前,V4.1.2)。

## 0. 概况与 License

- 纯 Python(FastAPI+httpx+Pydantic+PyWebIO)常驻 REST 服务;支持 douyin/tiktok/bilibili/hybrid 解析
- **License 陷阱**:项目 Apache 2.0,但核心 `abogus.py`(crawlers/douyin/web/abogus.py:1-16)来自 JoeanAmier/TikTokDownloader,声明 **GPL v3**。把 a_bogus 算法移植进本仓库(TS 重写也属衍生)有 GPL 传染风险 → **必须走浏览器扩展页面上下文原生请求避开移植**
- 签名算法是否仍有效需实测(仓库 10.个月未更新)——最大时效风险,同样被扩展页面路径绕开

## 1. API 端点(参考项目,prefix /api/douyin/web)

- `GET /fetch_one_video?aweme_id=`(19 位数字);`/fetch_user_post_videos?sec_user_id=&max_cursor=&count=`(游标分页);`/fetch_user_like_videos`;`/fetch_user_mix_videos?mix_id=`(合集);`/handler_user_profile?sec_user_id=`(用户详情);`/fetch_video_comments`;`/get_aweme_id?url=`(短链→ID);`/get_sec_user_id`;`/generate_a_bogus` 等风控凭证;`/api/hybrid/video_data`(混合单视频解析);`/api/download`
- **搜索/话题 feed 无现成实现**(端点 URL 有,crawler 注释掉,API 层无路由)→ 砍掉

## 2. 单视频数据结构(aweme_detail)

| 关注点 | 字段 | 备注 |
|---|---|---|
| 视频 ID | `aweme_id` | 19 位数字串;`aweme_type`: 0=视频,2/68=图文图集;`modal_id` 是旧 URL 查询参数形态,归一到 aweme_id |
| 标题/文案 | `desc` | 含 #话题原文 |
| 博主 | `author.sec_uid`(`MS4wLjAB...` base64,稳定主键)、`uid`(11 位数字)、`nickname` |
| 统计 | `statistics`:play_count/digg_count(赞)/comment_count/share_count/collect_count(收藏) |
| 时长 | `video.duration` | **毫秒**(B 站秒,入库换算) |
| 发布时间 | `create_time` | unix 秒 |
| 封面 | `video.cover/origin_cover/dynamic_cover` 各 `{url_list:[...]}` |
| 播放地址 | `video.play_addr.{uri,url_list}`;`bit_rate[].play_addr` 多清晰度 | url_list[0] 带水印;uri=长期稳定 video_id |
| 话题 | `text_extra[].{hashtag_name,hashtag_id}` | 对齐 B 站 tags 形态 |
| 合集 | `mix_id`(接口按 mix_id 游标翻页) | 对齐 ugc_season 语义 |
| 音乐 | `music.play_url` 是 BGM 片段 ≠ 完整音轨 |
| 图集 | `images[]`(无水印 url_list/有水印 download_url_list) |

ID 提取(utils.py:406-487):GET 短链跟 302 → 最终 URL 依次匹配 `video/(\d+)` → `[?&]vid=(\d+)` → `note/(\d+)` → `modal_id=(\d+)`;sec_uid 匹配 `user/([^/?]*)` 或 `sec_uid=([^&]*)`。

## 3. Web 接口形态与风控(核心)

- 全走 `www.douyin.com/aweme/v1/web/*` 私有 XHR(endpoints.py:25-151:POST_DETAIL=`/aweme/v1/web/aweme/detail/`、USER_POST=`/aweme/v1/web/aweme/post/`、USER_DETAIL=`/aweme/v1/web/user/profile/other/`、MIX_AWEME、POST_COMMENT)。**参考项目完全不走 SSR/RENDER_DATA**(grep 零引用)
- **a_bogus**:2024-06-12 起 X-Bogus 失效,detail/post/like 主链路用 a_bogus;Python 实现是 SM3+**硬编码绑定特定 UA 的 ua_code**(UA 不能改:Chrome/90.0.4430.212);mix/comments/profile 次要接口仍走 X-Bogus
- **msToken**:detail/post 主链路**显式置空再签名**(web_crawler.py:105)——a_bogus 链路不需要真 msToken
- **ttwid**:POST ttwid.bytedance.com 换取,必备;verify_fp/s_v_web_id 本地随机
- **Cookie 强依赖**(建议已登录);chrome-cookie-sniffer/(MIT)扩展参考:webRequest 抓 douyin.com Cookie 头→webhook 推服务端——与本仓库扩展架构同构
- 请求头:固定 UA + Referer https://www.douyin.com/ + zh Accept-Language
- **旁路线索**:①其 API 证明 detail 只需 a_bogus+Cookie(ttwid)+固定 UA(msToken 空)→ **扩展 content script 以页面身份同源 fetch `/aweme/v1/web/*` 绕开签名移植**(页面自身有 webmssdk 环境),或直接 hook 页面 XHR 拿响应;②`iesdouyin.com/web/api/v2/aweme/like/` 登记为无签名备选域名(endpoints.py:64,仅定义未使用,可实测)

## 4. 音频/视频下载

- 无水印:play_addr.url_list[0] 的 `playwm` 替换成 `play`;或直构 `https://aweme.snssdk.com/aweme/v1/play/?video_id={play_addr.uri}&ratio=1080p&line=0`
- 下载带 douyin headers(UA+Referer+Cookie)流式拉取;**抖音直链带 headers 即可**(TikTok 才 403 需服务端)
- **时效**:play_addr 有时效,每次下载重新解析不缓存 → **入库只存 play_addr.uri(video_id,稳定),用时重解析/直构取直链**
- 无独立音轨 URL(music.play_url 是 BGM 片段)→ ASR 兜底下载无水印 mp4 直接喂 fireredasr(其内部 ffmpeg 抽音轨,兼容)

## 5. SQLite 字段映射建议(对齐本仓库 schema)

**videos**:source='douyin';source_vid=aweme_id;title=desc;**duration=video.duration/1000(毫秒→秒)**;published_at=create_time(unix 秒,与 B 站同口径:ingest 是否乘 1000 以现有 IngestRequest 为准);paid 恒 0;creator 关联 sec_uid。

**videos.extra**(键名刻意对齐 B 站 extra,让 web/CLI/advanced.ts 查询表达式直接复用):
```jsonc
{
  "aweme_type": 0, "desc": "...", "create_time": 1710000000,
  "cover": "...", "origin_cover": "...", "dynamic_cover": "...",
  "stat": { "play": "play_count", "like": "digg_count", "reply": "comment_count",
            "share": "share_count", "favorite": "collect_count" },
  "tags": [{ "tag_id": "hashtag_id", "tag_name": "hashtag_name" }],
  "mix": { "id": "mix_id", "title": "mix_desc" },   // 对齐 ugc_season 语义
  "music": { "id": "...", "title": "...", "play_url": "..." },
  "play_uri": "video.play_addr.uri",   // 稳定 video_id,重解析换短时效直链
  "dimension": { "width": "...", "height": "..." },
  "images": ["..."]
}
```
注意:advanced.ts 的 view 排序/筛选用 `$.stat.view`——douyin 若想复用该索引/排序,stat 里 view 键要么与 play 合一(**推荐 stat.view=play_count**,再加 douyin 特有键),要么接受 douyin 视频无 view 排序。**定案:stat 用 view/like/reply/share/favorite 完全对齐 B 站键名**(B 站 stat.view 口径),douyin 的 collect_count 映射 favorite;share/comment 直接用 B 站同名键 share/reply。

**creators**:source_uid=sec_uid;name=nickname;avatar=avatar_thumb.url_list[0];sign=signature;fans=follower_count;following=following_count;level/sex/official_* 空。

**分页模型**:USER_POST 是 max_cursor/has_more 游标式(models.py:90-93)——扩展端翻页循环聚合(对齐 youtube「一次全量」回传形态),server 不感知游标。

## 6. 关键结论(定案输入)

1. 能拿:单视频详情/博主作品游标翻页/profile/合集/评论;**搜索/话题无现成实现(砍)**
2. 最小凭证集:detail 主链路 = Cookie(ttwid)+固定 UA+a_bogus,msToken 可空
3. **推荐架构:扩展页面上下文采集**(对齐 YouTube navigate 模式+MAIN world 数据读取),server 零签名移植——同时绕 GPL 与算法时效两坑;chrome-cookie-sniffer 是 cookie 保鲜参考
4. 换算点:duration 毫秒→秒;create_time 秒;stat 键对齐;mix↔ugc_season;aweme_id↔source_vid;sec_uid↔source_uid
5. 音频:无独立音轨;ASR 下载无水印 mp4(play_uri 直构)直接喂 fireredasr
