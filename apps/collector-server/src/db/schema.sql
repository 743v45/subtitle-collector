-- 四层 + 通用 change_log
CREATE TABLE IF NOT EXISTS creators (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_uid    TEXT NOT NULL,
  name          TEXT,
  avatar        TEXT,
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
--     stat:{view,danmaku,reply,favorite,coin,share,like,now_rank,his_rank} }
-- change_log 策略：ingest 比较前先剔除 extra.stat，统计数字波动不记 change_log；
--                  其余结构字段（分区/标签/版权/pages 等）变化照常记 change_log。
CREATE TABLE IF NOT EXISTS videos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_vid    TEXT NOT NULL,
  creator_id    INTEGER REFERENCES creators(id),
  title         TEXT NOT NULL,
  extra         TEXT,
  duration      INTEGER,
  status        TEXT DEFAULT 'online',
  published_at  INTEGER,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_vid)
);
CREATE INDEX IF NOT EXISTS idx_videos_first_seen ON videos(first_seen_at DESC);

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
  source_url    TEXT,
  asr_engine    TEXT,
  captured_at   INTEGER NOT NULL
  -- 去重在应用层处理（见 db/ingest.ts version 写入分支）：
  --   origin IN ('external','asr')：按 (track_id, origin, coalesce(asr_engine,''), coalesce(source_url,'')) 先 SELECT，命中则跳过；
  --   origin = 'manual'：始终 INSERT 新行（人工导入不去重，保留历史快照）。
  -- 不在 DDL 上设 UNIQUE，否则 manual 多次导入会撞约束报错。
);
CREATE INDEX IF NOT EXISTS idx_versions_track ON subtitle_versions(track_id);
CREATE INDEX IF NOT EXISTS idx_versions_dedup ON subtitle_versions(track_id, origin, asr_engine, source_url);

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
