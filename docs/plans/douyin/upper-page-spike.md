# 抖音博主页 XHR 实测 spike——「博主页数据未就绪 items=0」根因定位

> 2026-08-30 实测,chrome-devtools MCP 匿名 Chrome。**只调研不改码**,结论供修复排期。
> 报障 URL:`https://www.douyin.com/user/MS4wLjABAAAAoHBYbuXbGA5ccklR2MubpS4hJyB96fEURUJu_jUO2A6qJBDy5MOEG5JMvDbFh5`(下称「死 sec_uid」)。
> 对照样本:S1 spike 存档的洛克影视 sec_uid(`MS4wLjABAAAA6fLu…Wiz1G98`,下称「健康 sec_uid」,[_spike-raw/profile-other-response.network-response](_spike-raw/profile-other-response.network-response) 正主)。

## 0. 结论一句话

**该 sec_uid 在抖音侧已不存在(用户不存在/失效)——博主页只渲染「用户不存在」+登录墙,`/aweme/v1/web/aweme/post/` 从头到尾不发(无作品网格可懒加载),profile/other 回 200 + `status_code:2 "UserId不合法"` + `user:{}`;扩展等满 20s 无进展窗口自然 items=0。扩展的拦截模式本身没坏(匹配串/XHR hook/时序全部对账通过)。**

## 1. 登录态判据(实测)

MCP 浏览器为**匿名态**,依据:
- profile/other 请求 Cookie 头:`ttwid`/`s_v_web_id`/`passport_csrf_token`/`passport_auth_mix_state`/`odin_tt` 齐全,但**无 `sessionid`/`sessionid_ss`/`sid_guard`**(登录态 cookie 一概没有);
- `SSR_RENDER_DATA.app.user = {isLogin:false, statusCode:8}`;
- `SSR_RENDER_DATA.app.odin.not_exist_login_cookie = true`;
- 页面弹扫码/验证码登录窗。

## 2. 实测:同一匿名浏览器,死/健康 sec_uid 对比

| 维度 | 死 sec_uid(报障 URL) | 健康 sec_uid(洛克影视) |
|---|---|---|
| 页面标题 | `的抖音 - 抖音`(昵称为空) | `洛克影视的抖音 - 抖音` |
| DOM 主体 | **「用户不存在」** + 登录弹窗,无作品网格 | 资料完整 + 作品网格空 + 少量 `?source=Baiduspider` SEO 降级链接(推荐流,非本人作品,S1 已判「勿用」) |
| profile/other XHR | **+1.4s 发出**(后台标签页同样),200,`content-length:129`:`{"status_code":2,"status_msg":"UserId不合法","user":{}}`,响应头 `bd-tt-error-code:2` | ~+1.5s 发出,200,`status_code:0`,**完整 user 11,682 B**(sec_uid/nickname/follower_count…),**匿名可用 ✓ 与 S1 一致** |
| aweme/post XHR | **零发出**(空闲 + 滚动模拟下 87s 内 0 次;页面无网格,滚动无对象可触发) | ~+2s 自动发出(`max_cursor=0&count=18&from_user_page=1`),**200 + `content-length:0` 空体**(匿名 gating,S1 已档形态 ✓) |
| SSR_RENDER_DATA | `app` 38 键全是环境/AB 配置,**无博主页数据**(只有 `user:{isLogin,statusCode,isSpider}`) | 同左——「博主页有 SSR 首批数据」假设**正面排除**,S1 §3 结论维持 |

死/健康在同浏览器同匿名态下行为分叉 ⇒「post 不发 + UserId不合法」是 **sec_uid 本身失效**,不是匿名 gating、不是风控、不是改版。

## 3. 真实 URL 样例(脱敏:值全抹,query 键名保留)

**post 列表**(健康页自动发出;host 见 §4):
```
GET https://www-hj.douyin.com/aweme/v1/web/aweme/post/
  ?device_platform=webapp&aid=6383&channel=channel_pc_web
  &sec_user_id=<SEC_UID>&max_cursor=0&locate_query=false
  &show_live_replay_strategy=1&need_time_list=1&time_list_query=0
  &whale_cut_token=&cut_version=1&count=18&publish_video_strategy_type=2
  &from_user_page=1&update_version_code=170400&pc_client_type=1&pc_libra_divert=Mac
  &support_h265=1&support_dash=1&cpu_core_num=10
  &version_code=290100&version_name=29.1.0      ← 注意:post 自带 29.1.0 版本号,别处皆 17.4.0
  &cookie_enabled=true&screen_width=2560&screen_height=1440
  &browser_language=zh-CN&browser_platform=MacIntel&browser_name=Chrome
  &browser_version=151.0.0.0&browser_online=true&engine_name=Blink
  &engine_version=151.0.0.0&os_name=Mac+OS&os_version=10.15.7&device_memory=16
  &platform=PC&downlink=1.7&effective_type=4g&round_trip_time=200
  &webid=<WEBID>&uifid=<UIFID>&verifyFp=<FP>&fp=<FP>
  &msToken=<MSTOKEN>&a_bogus=<A_BOGUS>&timestamp=<TS>&x-secsdk-web-signature=<SIG>
→ 匿名:200, content-length:0(空体 gating)
```

**profile 资料**:
```
GET https://www-hj.douyin.com/aweme/v1/web/user/profile/other/     ← 健康页
  ?device_platform=webapp&aid=6383&channel=channel_pc_web
  &publish_video_strategy_type=2&source=channel_pc_web&sec_user_id=<SEC_UID>
  &personal_center_strategy=1&profile_other_record_enable=1&land_to=1
  &update_version_code=170400&…(同上环境串)…&webid&uifid&verifyFp&fp&msToken&a_bogus
GET https://www.douyin.com/aweme/v1/web/user/profile/other/?…      ← 死 sec_uid 页走 www 裸域 host
→ 健康:200,status_code:0,完整 user;死:200,status_code:2 "UserId不合法",user:{}
```

签名参数齐备(msToken/a_bogus/x-secsdk-web-signature/timestamp),印证 R1「server 侧不可直构,页面上下文 hook 唯一正路」。

## 4. 与扩展拦截模式逐项对账(实测 ✓/✗)

| 扩展侧 | 真实形态 | 判定 |
|---|---|---|
| [inject-dy.js:32](../../../apps/subtitle-collector/inject-dy.js#L32) `isPostUrl` 子串 `/aweme/v1/web/aweme/post/` | 真实 URL(含 `www-hj.douyin.com` 灰度 host)含该子串 | ✓ 匹配串没问题;**host 是 `www.douyin.com` 或 `www-hj.douyin.com`(按页灰度),子串匹配天然兼容** |
| [inject-dy.js:35](../../../apps/subtitle-collector/inject-dy.js#L35) `isProfileUrl` 子串 | 同上 | ✓ |
| XHR/fetch 双 hook | `initiatorType: xmlhttprequest`(performance API 实证) | ✓ XHR 路被 hook 覆盖 |
| 首页 post 依赖页面自动发(content-dy 只管滚动翻页) | 健康页 +2s 自动发 `max_cursor=0`;死页永不发 | ✓ 设计假设成立(死页非滚动失灵) |
| 滚动触发翻页 | 健康页网格存在才有懒加载;死页无网格 | ✓(与本 case 无关:post 根本没发) |
| SSR 轮询只取 `videoDetail`([inject-dy.js:120-137](../../../apps/subtitle-collector/inject-dy.js#L120-L137)) | 博主页 SSR 无任何博主/作品数据 | ✓ 不取是对的,无需补 SSR 数据源 |
| 首批 XHR 时序 vs 20s 窗口([dy-navigate.mjs:167](../../../apps/subtitle-collector/dy-navigate.mjs#L167)) | profile +1.4s、post +2s(**后台 `active:false` 标签页同样实测**) | ✓ 窗口 20s 足够,无需调 |
| 「进展」= key 变化([dy-navigate.mjs:169](../../../apps/subtitle-collector/dy-navigate.mjs#L169)) | 死页 profile `{}` 也会让 key `running/0/0→running/0/1`(算一次进展,重置窗口) | ⚠ 见 §6 修法 2 |

## 5. 根因链(实测 + 代码路径推演)

1. 死 sec_uid 页:profile/other +1.4s 回 `user:{}`;**post 永不发** ⇒ items 恒 0。
2. 扩展侧:[inject-dy.js:83](../../../apps/subtitle-collector/inject-dy.js#L83) `if (json.user && typeof json.user === "object")` 对 `{}` **判真** ⇒ PROFILE_OTHER(user:{}) 照发;[content-dy.js:122](../../../apps/subtitle-collector/content-dy.js#L122) `upper.profile = {}`(truthy)。
3. 20s 无进展窗口到点 → 收尾。**0.1.27 的 M2 防线([dy-navigate.mjs:271](../../../apps/subtitle-collector/dy-navigate.mjs#L271))用 truthiness 判 profile,`{}` 穿透** ⇒ 回 `ok + total:0 + channel_name:null`(`douyinCreatorFromProfile({})` 返回 null,[douyin-payload.js:229-239](../../../apps/subtitle-collector/douyin-payload.js#L229-L239))——伪装成功,正是 M2 想拦没拦住的形态;若当次连 profile 响应都没送达(如验证码中间页/更慢引导),则 profile 恒 null → 报 M2 文案「博主页数据未就绪(可能页面改版或未注入)」——**文案指向改版/未注入,实际是博主不存在**,误导排查。
4. 无论走哪条收尾,**零数据的第一因都是:抖音侧该账号不存在,页面根本没有数据可发**。

## 6. 最小修法清单(按优先级)

1. **识别「博主不存在」终态(核心)**:[inject-dy.js](../../../apps/subtitle-collector/inject-dy.js) `postProfileMessage` 对 `status_code !== 0`(如 2「UserId不合法」)或 `user` 缺 `sec_uid` 的响应,发独立错误消息(如 `PROFILE_OTHER_ERROR`,`status_msg` 透传);content-dy 置 `upper.error = '博主不存在(sec_uid 失效/注销):' + status_msg` ⇒ 秒级失败,不耗 20s、不进伪装成功路径。判据字段建议双保险:`status_code` + `user.sec_uid` 存在性。
2. **M2 防线堵 `{}` 穿透**:[dy-navigate.mjs:271](../../../apps/subtitle-collector/dy-navigate.mjs#L271) 的判定从 `!state?.profile` 改为 `douyinCreatorFromProfile(state?.profile) == null`(与回执组装同一口径),items=0 且 creator 组不出 ⇒ error。
3. **profile 空 body/解析失败不再静默**:[inject-dy.js:101-107](../../../apps/subtitle-collector/inject-dy.js#L101-L107) 对 profile URL 的空体/JSON 失败目前只 `console.warn` 后丢弃(与 post 的 `POST_LIST_EMPTY` 不对称),归入错误路径可让 M2 文案不再误报「未注入」。
4. **窗口无需调**:20s 足够(首批 1.4~2s 到);死页快速失败靠 1/2,不靠拉长等待。
5. **登录态无需动**:本 case 与登录无关(profile 匿名可用实证);健康博主+匿名 → post 空体 → 「需登录」错误路径已按设计工作。
6. (登记,无需动作)post 请求自带 `version_code=290100/version_name=29.1.0`(其余接口 17.4.0)、灰度 host `www-hj.douyin.com`——现有子串匹配均天然兼容;若未来加 host/版本白名单需回头查这两处。

## 7. 遗留/推断标注

- 「死 sec_uid 为何失效」(注销/封禁/录入截断)未深究——`UserId不合法` 即终态,对采集链路等价。
- 登录态浏览器 + 健康 sec_uid 的 post 有数据形态(S3 推断)本次无法验证(匿名环境),不影响本结论。
- 扩展实跑回执到底走「ok+total:0」还是「M2 error」取决于当次 profile `{}` 是否送达(§5 两条分支);本次未重放扩展本体(约束:轻量防风控),页面侧证据已足以定根因。

## 8. 原始证据(响应体全文,现场摘录)

死 sec_uid profile/other(129 B,前后台标签页各复现一次,逐字相同):
```json
{"extra":null,"log_pb":{"impr_id":"2026…"},"status_code":2,"status_msg":"UserId不合法","user":{}}
```
健康 sec_uid profile/other(11,682 B,节选):`{"status_code":0,"user":{"sec_uid":"MS4wLjABAAAA6fLu…","nickname":"洛克影视",…}}`
健康 sec_uid aweme/post:`200`,响应头 `content-length:0`(空体)。
时序(performance API,后台标签页):profile/other fetchStart +1.4s / query/user +1.5s;aweme/post 0 次(87s 观察窗)。
