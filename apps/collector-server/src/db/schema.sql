-- UP 主分类（agent 自动分类 / human 人工分类，两套隔离）。
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK(scope IN ('agent','human')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE(name, scope)
);
CREATE INDEX IF NOT EXISTS idx_categories_scope ON categories(scope, sort_order);

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
CREATE TABLE IF NOT EXISTS video_tags (
  video_id    INTEGER NOT NULL REFERENCES videos(id),
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  source      TEXT NOT NULL CHECK(source IN ('manual','batch','ai')),
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
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','succeeded','failed')),
  client_id   TEXT,
  creator_client_id TEXT, -- 创建者客户端（popup 提交自带；CLI/旧任务 null），sticky 派发用
  error       TEXT,
  result      TEXT,
  batch_id    TEXT, -- 展示侧聚合标签：批量提交的同批任务共享同一 UUID；单条任务 NULL。无批次实体，UI 按此分组
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON collect_tasks(status, created_at);
