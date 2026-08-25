-- UP 主分类：一套共享值域（agent 自动打标 / human 人工打标都从这同一套里选），
-- 槽位是关系属性——creators.category_agent_id / category_human_id 两列分别引用（同 tags 的实体/关系分离哲学）。
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE(name)
);
CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order);

-- 四层 + 通用 change_log
CREATE TABLE IF NOT EXISTS creators (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_uid    TEXT NOT NULL,
  name          TEXT,
  avatar        TEXT,
  sign          TEXT,
  level         INTEGER,
  sex           TEXT,
  official_type INTEGER,
  official_title TEXT,
  fans          INTEGER,
  following     INTEGER,
  category_agent_id INTEGER REFERENCES categories(id),
  category_human_id INTEGER REFERENCES categories(id),
  blocked      INTEGER NOT NULL DEFAULT 0, -- 屏蔽标记（2026-08-24）：采集照常入库，仅 CLI 消费链路默认过滤、web 展示标识
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_uid)
);

-- videos.extra (TEXT/JSON) 结构：
--   被动采集（content.js）由扩展从页面 __INITIAL_STATE__.videoData 采集；
--   主动采集（background.js fetch-subtitle）从 /x/web-interface/view 接口采集，字段集同源。
--   { aid, cid, pic, desc, ctime, tid, tname, copyright, state, publocation,
--     tags:[{tag_id,tag_name}], dimension:{width,height,rotate},
--     pages:[{cid,page,part,duration}], rights:{...}, honor:{...}, ugc_season:{id,title}|null,
--     stat:{view,danmaku,reply,favorite,coin,share,like,now_rank,his_rank},
--     paid:boolean（扩展综合 is_upower_exclusive/is_ugc_pay_preview/elec_high_level/rights 算好的付费标志） }
-- change_log 策略：ingest 比较前先剔除 extra.stat，统计数字波动不记 change_log；
--                  其余结构字段（分区/标签/版权/pages/paid 等）变化照常记 change_log。
-- paid 独立列：从 extra.paid 提取（0/1）冗余落库，便于直接 WHERE 过滤；extra.paid 仍存原值作详情/来源。
CREATE TABLE IF NOT EXISTS videos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_vid    TEXT NOT NULL,
  creator_id    INTEGER REFERENCES creators(id),
  title         TEXT NOT NULL,
  extra         TEXT,
  duration      INTEGER,
  published_at  INTEGER,
  paid          INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_vid)
);
CREATE INDEX IF NOT EXISTS idx_videos_first_seen ON videos(first_seen_at DESC);
-- 表达式索引：tid 等值 / stat.view 范围过滤走索引，免 json_extract 全表扫。
-- 索引表达式必须与 db/advanced.ts 的查询表达式逐字一致（SQLite 按表达式匹配）：
-- view 查询带 CAST 包裹，索引也带 CAST。tname 是 LIKE '%…%' 前导通配模糊匹配，
-- 索引无法服务，不建（advanced.test.ts 的 EXPLAIN QUERY PLAN 断言守着这两条走索引）。
CREATE INDEX IF NOT EXISTS idx_videos_extra_tid ON videos(json_extract(extra, '$.tid'));
CREATE INDEX IF NOT EXISTS idx_videos_extra_view ON videos(CAST(json_extract(extra, '$.stat.view') AS INTEGER));

-- track_type 语义：1=AI/ASR 自动轨，2=人工 CC 轨，3=翻译轨（YouTube tlang 机翻）。
-- 3 是 v10 迁移引入：存量 YouTube 翻译轨原落 2 与人工 CC 同型（默认轨优先级会把机翻中文顶成
-- 默认正文），迁移判据=track_type=2 且关联 video source='youtube' 且版本 source_url 含 'tlang='。
CREATE TABLE IF NOT EXISTS subtitle_tracks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id    INTEGER NOT NULL REFERENCES videos(id),
  lan         TEXT,
  lan_doc     TEXT,
  track_type  INTEGER,
  UNIQUE(video_id, lan, track_type)
);
CREATE INDEX IF NOT EXISTS idx_tracks_video ON subtitle_tracks(video_id);

CREATE TABLE IF NOT EXISTS subtitle_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id      INTEGER NOT NULL REFERENCES subtitle_tracks(id),
  origin        TEXT NOT NULL,
  payload       TEXT NOT NULL,
  body_size     INTEGER,
  body_hash     TEXT,       -- 字幕体 SHA-256（幂等去重键；存量行为 NULL 不参与去重）
  source_url    TEXT,       -- 原样保留供来源追溯；带会话签名，不参与去重判定
  asr_engine    TEXT,
  captured_at   INTEGER NOT NULL
  -- 去重在应用层处理（见 db/ingest.ts version 写入分支）：
  --   origin IN ('external','asr')：按 (track_id, origin, coalesce(asr_engine,''), body_hash) 先 SELECT，命中则跳过
  --     （source_url 是 YouTube timedtext / B 站 AI 字幕的带签名临时 URL，跨会话必不同，参与判定会让重采插重复行）；
  --   origin = 'manual'：始终 INSERT 新行（人工导入不去重，保留历史快照）。
  -- 不在 DDL 上设 UNIQUE，否则 manual 多次导入会撞约束报错。
);
CREATE INDEX IF NOT EXISTS idx_versions_track ON subtitle_versions(track_id);
CREATE INDEX IF NOT EXISTS idx_versions_dedup ON subtitle_versions(track_id, origin, asr_engine, body_hash);

CREATE TABLE IF NOT EXISTS change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changelog_entity ON change_log(entity, entity_id);

-- 视频标签（四档来源）：manual=server 侧手动 / batch=采集批量 / ai=看字幕二次标记，
-- 第四档 bili（B 站视频自带）不落表——实时读 videos.extra 的 tags JSON（重采整体替换 extra，
-- 手工标签塞 extra 会被冲掉，故三档独立表；bili 档只读）。
-- tags.name 全局 UNIQUE：标签是跨档复用的实体，档位是「关系」属性（video_tags.source）非标签属性。
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(name)
);

-- 同一视频同标签名可多档并存（展示按 settings.tag_priority 取优先档）。
-- system 档（2026-08-23）：系统自动状态标（如 no-subtitle），采集链路自动打/摘。
CREATE TABLE IF NOT EXISTS video_tags (
  video_id    INTEGER NOT NULL REFERENCES videos(id),
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  source      TEXT NOT NULL CHECK(source IN ('manual','batch','ai','system')),
  created_at  INTEGER NOT NULL,
  UNIQUE(video_id, tag_id, source)
);
CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id);
CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id, source);

-- server 侧 KV 设置（当前只存标签展示优先级 tag_priority；为将来通用设置留口）。
-- DB 而非 JSON 文件：远端部署重新发布不丢配置。
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL          -- JSON 字符串
);

-- 采集任务（手机/网页提交 → server 派发给桌面扩展执行）。
-- status 状态机：pending → dispatched → succeeded | failed
--   pending     已入库待派发（无扩展在线时停留在此态，扩展上线后由调度器派发）
--   dispatched  已 WS 下发 requestCommand，等扩展 result 回执
--   succeeded   扩展回执 ok（captured=0 表示视频无字幕轨，仍是任务成功）
--   failed      扩展回执 err / 超时 / 扩展掉线（error 字段存可读原因）
-- server 重启恢复：启动时把 dispatched 重置回 pending（没等到回执就不确认，重新派发）。
CREATE TABLE IF NOT EXISTS collect_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL CHECK(source IN ('bilibili','youtube')),
  source_vid  TEXT NOT NULL,
  url         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','succeeded','failed','limited')),
  client_id   TEXT,
  creator_client_id TEXT, -- 创建者客户端（popup 提交自带；CLI/旧任务 null），sticky 派发用
  error       TEXT,
  result      TEXT,
  batch_id    TEXT, -- 展示侧聚合标签：批量提交的同批任务共享同一 UUID；单条任务 NULL。无批次实体，UI 按此分组
  creator_uid TEXT, -- UP 归属冗余列（2026-08-22 历史页按 UP 筛未入库任务）：批量提交时调用方已知 / 建任务时查库回填 / ingest 后回填。列值 = creators.source_uid
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON collect_tasks(status, created_at);

-- 客户端注册表（popup 可命名；client_id 8 位短 id 由扩展生成且不变，name 可改可清除）。
-- 持久层：在线态在 ws/server.ts 内存 connections（重启即失），本表保名字与时间线不丢。
-- GET /api/clients 合并两源出全量：connected_at 起「在线时长」，last_seen_at 起「离线时长」。
CREATE TABLE IF NOT EXISTS clients (
  client_id     TEXT PRIMARY KEY,
  name          TEXT,
  bili_login    TEXT,     -- B 站登录态快照 JSON {is_login,mid,uname,vip}（hello/login-state 上报；NULL=旧版扩展未上报过。未登录时充电视频 AI 字幕接口返回空——2026-08-24 批量 1190 no_subtitle 根因）
  yt_login      TEXT,     -- YouTube 登录态快照 JSON {is_login}（2026-08-25 镜像 bili_login；未登录时年龄限制视频播不了、pot 受限加重——批量 no_subtitle/pot_limited 判因依据）
  ext_version   TEXT,     -- 扩展版本（hello 上报；离线客户端经此列可见版本）
  first_seen_at INTEGER NOT NULL, -- server 首次见到该 client_id（hello upsert 插入时）
  last_seen_at  INTEGER NOT NULL  -- 最近一次连接建立/断开时刻（hello upsert / close touch）
);
