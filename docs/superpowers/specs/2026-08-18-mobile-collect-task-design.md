# 手机发起字幕采集任务 — 设计文档

- 日期:2026-08-18
- 状态:已实现(本文档为实现后补记,内容与代码一致)
- 相关提交:feat(server/web/ext): 手机发起采集任务(任务表 + 调度器 + fetch-youtube-subtitle action + 采集页)

## 1. 背景与目标

用户希望在手机上发起字幕采集任务,由桌面侧处理:

- 手机与电脑**同局域网**,手机浏览器直接访问 collector-server(静态托管 collector-web)。
- 平台:**B 站 + YouTube 都要**,且**都走桌面扩展**执行采集(server 驱动,不依赖用户恰好打开页面)。
- 任务输入:**单个视频 URL**(手机粘贴分享文本),批量(UP 主/频道)留待后续。
- 反馈:**提交后看到完整状态**(排队/采集中/成功/失败),任务持久化、重启不丢。
- 扩展:**单台**,不做多扩展路由。

## 2. 架构总览

```
手机(浏览器,collector-web「采集」页)
   │  POST /api/collect-tasks { text }          ← 粘贴分享文本
   │  GET  /api/collect-tasks[/:id]             ← 2s 轮询
   ▼
collector-server(单进程)
   ├─ collect_tasks 表(SQLite,新增)
   ├─ 任务调度器(进程内,事件驱动 + 15s 兜底轮询)
   │    pending ──派发──▶ dispatched ──result ok──▶ succeeded
   │                        └─result err/超时──▶ failed
   ▼  WS requestCommand(60s 超时)
桌面扩展 background.js
   ├─ B 站:fetch-subtitle(既有,零改动)
   └─ YouTube:fetch-youtube-subtitle(新增编排层)
        后台开/复用 tab → 等 content-yt 采集 → GET_LOCAL_STATE 轮询判定完成 → 汇总回执
   ▼  采集本身复用被动链路
content-yt.js / inject-yt.js → INGEST → server ingestVideo 入库(既有,零改动)
```

## 3. Server 侧

### 3.1 collect_tasks 表([schema.sql](../../../apps/collector-server/src/db/schema.sql))

```sql
CREATE TABLE IF NOT EXISTS collect_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('bilibili','youtube')),
  source_vid TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','succeeded','failed')),
  client_id TEXT, error TEXT, result TEXT,
  created_at INTEGER NOT NULL, finished_at INTEGER
);
```

- `result` 存扩展回执 data 的 JSON 字符串(captured/tracks/reason…)。
- **重启恢复**:启动时 `resetDispatched` 把 dispatched → pending(没等到回执就不确认,重新派发)。终态不动。

### 3.2 URL 解析([tasks.ts](../../../apps/collector-server/src/tasks/tasks.ts))

1. `extractVideoUrl(text)`:正则抽第一个 URL,只认 b23.tv/bili2233/bilibili.com/youtu.be/youtube.com 等域,非视频站直接拒;
2. `expandShortLink(url, fetcher)`:b23.tv / youtu.be 短链跟随重定向取 `Response.url`(展开失败按原 URL 走,后续解析报 400);
3. `parseVideoUrl(url)`:B 站 `/video/BV…` 或 `?bvid=`(av 号暂不支持);YouTube `watch?v=` / `shorts/` / `youtu.be/<id>` / music.youtube.com(videoId 11 位校验)。

### 3.3 HTTP API([tasks.ts](../../../apps/collector-server/src/http/tasks.ts))

| 方法 | 路由 | 行为 |
|---|---|---|
| POST | `/api/collect-tasks` | body `{text}` → 提取/展开/解析 → 建 pending 任务 + kick 调度器。解析失败 400(中文可读错误) |
| GET | `/api/collect-tasks?limit=` | 最近任务列表(id 倒序,limit 夹 1..100) |
| GET | `/api/collect-tasks/:id` | 单任务(手机轮询) |

鉴权沿用现有 `/api/*` 的 Host + Origin 校验([main.ts httpOriginAllowed](../../../apps/collector-server/src/main.ts))。

### 3.4 调度器(attachTaskScheduler,进程内 ~100 行,无新依赖)

- **事件驱动**:建任务后 kick(`kickTaskScheduler`)、扩展 hello 上线后 kick(`notifyClientOnline`,ws/server.ts 握手成功处调用);
- **兜底轮询**:每 15s 扫 pending;
- **派发**:扫 pending(按 id 升序),选一台空闲扩展(inFlight Map:client 同时只跑 1 任务,防风控),`requestCommand(clientId, action, params, 60s)`;
  - bilibili → `fetch-subtitle` `{bvid}`(既有 action)
  - youtube → `fetch-youtube-subtitle` `{videoId}`(新 action)
- **回执处理**:result.ok → succeeded + result JSON;result.err / timeout / offline → failed + 中文 error。派完一个立即链式派下一个。
- 不做:重试、优先级、多扩展路由(YAGNI,单台起步)。

## 4. 扩展侧(subtitle-collector)

### 4.1 新 action:`fetch-youtube-subtitle`(background.js)

`collectYoutubeViaNavigate(videoId)` 编排层(~70 行),不重写采集:

1. `navCollectBusy` 锁(与 B 站 collectViaNavigate 共用,全局同时只 1 个 navigate);
2. 复用已打开的同视频 tab(reload),无则后台新建(`active:false` 不抢焦点);
3. `activeYtCollects` 集合登记进行中的 videoId —— 该视频的 content-yt 被动 INGEST 视为主动采集,**绕过上报开关**(对齐 B 站 `fromNavigate` force 语义);
4. 轮询 `GET_LOCAL_STATE { vid }` 判定完成:
   - `no-subtitle` → 成功 0 轨(reason: no_subtitle);
   - `has-subtitle` + `settled`(新字段:所有轨有 body 或已尝试 FETCH,与 flushIfReady 同条件)→ 进入 8s 宽限(`YT_SETTLE_GRACE_MS`,等菜单触发的翻译轨迟到 body)→ 再取一次最新状态 → 等 1.5s INGEST 落库 → 汇总回执(captured = has_body 轨数);
   - `not-loaded`/null → 500ms 重试;总超时 45s 抛错;
5. finally:新建的 tab 关闭(复用的不关)、释放锁、防风控间隔(base+随机,对齐 B 站)。

INGEST 入库走 content-yt 既有链路(归一化 youtube-format.mjs → buildYoutubePayload → INGEST → server ingestVideo),编排层不重复上报。

### 4.2 content-yt.js 改动(1 处)

`GET_LOCAL_STATE` 响应加 `settled: boolean` 字段,供主动采集轮询判定「body 到齐」(此前 has-subtitle 只代表有轨,不代表抓完)。

### 4.3 B 站侧

零改动(`fetch-subtitle` 既有且够用)。

## 5. Web 侧(collector-web)

### 5.1 「采集」页(CollectPage.tsx,新 tab,默认首页)

- 大输入框(手机粘贴分享文本)+ 大提交按钮(h-12),Enter 提交;
- 任务卡片列表:状态徽章(排队中/采集中/已完成/失败)+ 平台/vid + 时间 + 结果摘要(「采到 N 轨字幕」/「视频无字幕轨」/error 原因);
- 2s 轮询刷新(listCollectTasks(30)),有进行中任务时显示提示。

### 5.2 API(api.ts + types.ts)

`createCollectTask(text)` / `listCollectTasks(limit)` / `getCollectTask(id)` + `CollectTask` 类型。

### 5.3 移动端基础适配

index.html 补 `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`(此前缺失,手机会按桌面宽度渲染)。PWA 不做(超出本期)。

## 6. 部署(手机访问)

同局域网访问需要(参考 [.env.example](../../../apps/collector-server/.env.example) C2 说明):

```
COLLECTOR_HOST=0.0.0.0
COLLECTOR_ALLOWED_HOSTS=<电脑局域网 IP,如 192.168.1.5>
```

手机浏览器访问 `http://<电脑IP>:21527/`。「采集」页是默认 tab。

## 7. 测试

- **server**(`node --test --import tsx`,248 通过):
  - [tasks.test.ts](../../../apps/collector-server/src/tasks/tasks.test.ts):extractVideoUrl(分享文案/裸 URL/非视频站)、expandShortLink(重定向/非短链/失败回退)、parseVideoUrl(BV/bvid/watch/shorts/youtu.be/music/不可识别)、CRUD、resetDispatched;
  - [http/tasks.test.ts](../../../apps/collector-server/src/http/tasks.test.ts):POST 建任务→扩展回执→succeeded 全链路(模拟 WS 扩展)、YouTube action 派发、无扩展停留 pending、400、列表/单查、failed error 透传;
  - 冒烟:真实启动 dist,POST 分享文本 → pending → 400 非法输入。
- **扩展**:vite build + 既有 104 测试通过(background/content-yt 改动不破坏既有行为)。
- **web**:vite build 通过(产物已落 collector-server/public)。

### 测试轮次记录表

| 轮次 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 1 | `pnpm test`(collector-server) | 247/248 | expandShortLink 测试 mock 缺陷(Response 构造器 url 只读)|
| 2 | 修 mock 后重跑 | 248/248 | |
| 3 | `pnpm build`(server tsc) | 通过 | |
| 4 | `pnpm build`(web vite) | 通过 | |
| 5 | `pnpm build` + `pnpm test`(subtitle-collector) | 104/104 + 构建通过 | |
| 6 | dist 冒烟(任务 API) | 符合预期 | pending/列表/400 |

## 8. 边界与已知取舍

- av 号、YouTube 直播/首播链接不支持(第一阶段只支持 BV + videoId);
- YouTube 采到 0 轨(pot 受限)是**任务成功**(reason: pot_limited),与「失败」语义分开;
- 任务无重试:失败(超时/风控)重新提交即可,server 不自动重试;
- 短链展开用 server 侧 fetch(b23.tv/youtu.be 对无 cookie 的重定向友好);
- 多扩展路由、批量任务、PWA、鉴权加强(token)均为后续可选。
