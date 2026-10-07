import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

export function migrate(db: Database.Database): void {
  // WAL：DB 持久属性，server 启动设一次后，CLI 只读连接（readonly: true）即可与 server 写并发不抢锁（设计文档 §2）
  db.pragma('journal_mode = WAL');
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  db.exec(sql);
}

// ── 版本化迁移账本（PRAGMA user_version）──
// schema.sql（建新库，CREATE TABLE IF NOT EXISTS）与下面按版本追加的 ALTER（补旧库）双轨并存。
// 账本规则：
//   - 迁移前读 user_version；每个步骤全部语句执行完成后写该步骤版本，重复启动按版本跳过；
//   - 旧库首次带账本启动时 user_version=0，会重放全部 ALTER——列已存在报
//     "duplicate column name"，容忍跳过（双保险），跑完即记为最新版本；
//     DROP COLUMN 反向同理：新 schema（列已删）建的库重放时报 "no such column"，同样容忍；
//   - 版本号只增不改：已发布步骤的语句永不修改，新变更追加新步骤；
//   - 库的 user_version 超出本代码已知最大版本 = 被更新版本代码写过 → 拒绝运行（防降级写坏数据）。
interface MigrationStep {
  /** 完成本步骤后写入的 user_version；从 1 严格递增 */
  version: number;
  /** 变更说明 */
  note: string;
  /** 依序执行的 SQL；其中 ALTER 须容忍幂等性报错（ADD COLUMN 撞 duplicate column name、DROP COLUMN 撞 no such column，见账本规则） */
  statements: string[];
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    note: 'collect_tasks 补 creator_client_id（popup 提交任务的 sticky 派发用）',
    statements: [
      'ALTER TABLE collect_tasks ADD COLUMN creator_client_id TEXT',
    ],
  },
  {
    version: 2,
    note: 'creators 补 P2 详情列（sign/level/sex/official_*/fans/following）与分类列',
    statements: [
      'ALTER TABLE creators ADD COLUMN sign TEXT',
      'ALTER TABLE creators ADD COLUMN level INTEGER',
      'ALTER TABLE creators ADD COLUMN sex TEXT',
      'ALTER TABLE creators ADD COLUMN official_type INTEGER',
      'ALTER TABLE creators ADD COLUMN official_title TEXT',
      'ALTER TABLE creators ADD COLUMN fans INTEGER',
      'ALTER TABLE creators ADD COLUMN following INTEGER',
      'ALTER TABLE creators ADD COLUMN category_agent_id INTEGER',
      'ALTER TABLE creators ADD COLUMN category_human_id INTEGER',
    ],
  },
  {
    version: 3,
    note: 'videos 补 paid 列（extra.paid 的冗余独立列，便于 WHERE 过滤）',
    statements: [
      'ALTER TABLE videos ADD COLUMN paid INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    version: 4,
    note: 'paid 回填：加列后存量行默认 0，extra.paid=true 的旧行直接纠正、不等重采',
    statements: [
      "UPDATE videos SET paid = 1 WHERE json_extract(extra, '$.paid') = 1",
    ],
  },
  {
    version: 5,
    note: 'subtitle_versions 补 body_hash（幂等去重键取代带签名的 source_url；存量行 NULL 不参与去重）',
    statements: [
      'ALTER TABLE subtitle_versions ADD COLUMN body_hash TEXT',
    ],
  },
  {
    version: 6,
    note: 'videos 补 tid / stat.view 表达式索引（筛选取代 json_extract 全表扫；表达式须与 advanced.ts 查询逐字一致）',
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_videos_extra_tid ON videos(json_extract(extra, '$.tid'))",
      "CREATE INDEX IF NOT EXISTS idx_videos_extra_view ON videos(CAST(json_extract(extra, '$.stat.view') AS INTEGER))",
    ],
  },
  {
    version: 7,
    note: 'videos 删 status 单值死列（schema 默认 online，ingest 唯一写入值也是 online，全库无 offline 检测/读取路径）',
    statements: [
      'ALTER TABLE videos DROP COLUMN status',
    ],
  },
  {
    version: 8,
    note: 'collect_tasks 补 batch_id（展示侧聚合标签：同批任务打同一 UUID，单条任务 NULL；无批次实体/状态，全从子任务派生）',
    statements: [
      'ALTER TABLE collect_tasks ADD COLUMN batch_id TEXT',
    ],
  },
  {
    version: 9,
    note: 'collect_tasks 状态机加 limited 终态（执行成功但字幕受限 0 轨入库，区别于 succeeded）。SQLite 无法 ALTER CHECK，单事务表重建；事务保证中断重放幂等（回滚后旧表结构原样）',
    statements: [
      // 单条多语句：整体原子（exec 逐条自动提交无法跨语句，事务包裹后中断即回滚，重放从头跑不残留中间态）
      `BEGIN IMMEDIATE;
       CREATE TABLE collect_tasks_v9 (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         source      TEXT NOT NULL CHECK(source IN ('bilibili','youtube')),
         source_vid  TEXT NOT NULL,
         url         TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','succeeded','failed','limited')),
         client_id   TEXT,
         creator_client_id TEXT,
         error       TEXT,
         result      TEXT,
         batch_id    TEXT,
         created_at  INTEGER NOT NULL,
         finished_at INTEGER
       );
       INSERT INTO collect_tasks_v9 (id, source, source_vid, url, status, client_id, creator_client_id, error, result, batch_id, created_at, finished_at)
         SELECT id, source, source_vid, url, status, client_id, creator_client_id, error, result, batch_id, created_at, finished_at FROM collect_tasks;
       DROP TABLE collect_tasks;
       ALTER TABLE collect_tasks_v9 RENAME TO collect_tasks;
       CREATE INDEX idx_tasks_status ON collect_tasks(status, created_at);
       COMMIT;`,
    ],
  },
  {
    version: 10,
    note: 'YouTube 翻译轨 track_type 2→3（区分人工 CC 与 tlang 机翻；判据=track_type=2 且关联 video source=youtube 且版本 source_url 含 tlang=）。同 (video_id, lan) 已存在 type=3 轨时跳过该行——新旧扩展过渡期可能对同轨双写，防 UNIQUE(video_id, lan, track_type) 冲突；被跳过的旧 type=2 行留待重采自然去留。UPDATE 单语句自带原子性，重放幂等（type 已是 3 不再命中）',
    statements: [
      `UPDATE subtitle_tracks SET track_type = 3
       WHERE track_type = 2
         AND EXISTS (SELECT 1 FROM videos v WHERE v.id = subtitle_tracks.video_id AND v.source = 'youtube')
         AND EXISTS (SELECT 1 FROM subtitle_versions sv WHERE sv.track_id = subtitle_tracks.id AND sv.source_url LIKE '%tlang=%')
         AND NOT EXISTS (SELECT 1 FROM subtitle_tracks t3
                         WHERE t3.video_id = subtitle_tracks.video_id
                           AND t3.lan IS subtitle_tracks.lan
                           AND t3.track_type = 3)`,
    ],
  },
  {
    version: 11,
    note: 'collect_tasks 补 creator_uid 冗余列（历史页按 UP 筛未入库任务：批量提交/重采/ingest 时落 UP 归属）+ 存量回填（已入库视频的任务行按 videos→creators 补 uid，重放幂等：有值行不再命中）',
    statements: [
      'ALTER TABLE collect_tasks ADD COLUMN creator_uid TEXT',
      `UPDATE collect_tasks
       SET creator_uid = (SELECT c.source_uid FROM videos v JOIN creators c ON c.id = v.creator_id
                          WHERE v.source = collect_tasks.source AND v.source_vid = collect_tasks.source_vid)
       WHERE creator_uid IS NULL`,
    ],
  },
  {
    version: 12,
    note: 'video_tags.source CHECK 放行 system 档（2026-08-23 no-subtitle 系统状态标；此前 INSERT OR IGNORE 会静默吞 CHECK 违反→打标 inserted=0）。SQLite 无法 ALTER CHECK，学 v9 单事务表重建；中断回滚重放幂等',
    statements: [
      `BEGIN IMMEDIATE;
       CREATE TABLE video_tags_v12 (
         video_id    INTEGER NOT NULL REFERENCES videos(id),
         tag_id      INTEGER NOT NULL REFERENCES tags(id),
         source      TEXT NOT NULL CHECK(source IN ('manual','batch','ai','system')),
         created_at  INTEGER NOT NULL,
         UNIQUE(video_id, tag_id, source)
       );
       INSERT INTO video_tags_v12 (video_id, tag_id, source, created_at)
         SELECT video_id, tag_id, source, created_at FROM video_tags;
       DROP TABLE video_tags;
       ALTER TABLE video_tags_v12 RENAME TO video_tags;
       CREATE INDEX idx_video_tags_video ON video_tags(video_id);
       CREATE INDEX idx_video_tags_tag ON video_tags(tag_id, source);
       COMMIT;`,
    ],
  },
  {
    version: 13,
    note: '建 clients 客户端注册表（popup 改名持久化：id 不变 name 可变可清除；GET /api/clients 合并 DB 持久层与内存在线态，含在线/离线时长）。CREATE IF NOT EXISTS 自身幂等',
    statements: [
      `CREATE TABLE IF NOT EXISTS clients (
         client_id     TEXT PRIMARY KEY,
         name          TEXT,
         first_seen_at INTEGER NOT NULL,
         last_seen_at  INTEGER NOT NULL
       )`,
    ],
  },
  {
    version: 14,
    note: 'clients 补 bili_login（B 站登录态 JSON 快照 {is_login,mid,uname,vip}：未登录时充电视频 AI 字幕接口返回空，2026-08-24 批量 1190 个 no_subtitle 根因，server 侧可见登录态/账号）+ ext_version（离线客户端可见版本）。ADD COLUMN 撞 duplicate column name 容忍（双写 schema.sql）',
    statements: [
      'ALTER TABLE clients ADD COLUMN bili_login TEXT',
      'ALTER TABLE clients ADD COLUMN ext_version TEXT',
    ],
  },
  {
    version: 15,
    note: 'creators 补 blocked 屏蔽标记列（2026-08-24）：采集入库不受影响，仅 CLI 消费链路（videos list/export/stats/sub search）默认过滤、web 全处标识展示。ADD COLUMN 撞 duplicate column name 容忍（双写 schema.sql）',
    statements: [
      'ALTER TABLE creators ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    // 值域合一（2026-08-25）：categories 去 scope 列——一套共享值域，agent/human 是 creators 两列的
    // 打标关系属性（同 tags 的实体/关系分离哲学）。单事务表重建学 v9/v12，外加 FK 前后包裹：
    // better-sqlite3 默认 foreign_keys=1，FK ON 下 DROP 被 creators 引用的表报 FOREIGN KEY constraint failed；
    // PRAGMA foreign_keys 事务内是 no-op，OFF/ON 必须在 BEGIN 之前 / COMMIT 之后各自独立执行。
    // ⚠ 语句一律不引用 scope 列（scope-free）：新库（schema.sql 建的无 scope 表，user_version=0 全量重放
    // ——全新部署/抢救重建路径）上若中途抛 no such column 被容忍规则吞掉，会留下打开的事务 + FK 永久
    // 关闭（user_version 写进未提交事务，后续写入随进程退出丢）。v9/v12 没踩此坑正因 SQL 不引用被删列。
    // 事务串抛非容忍错误时 OFF 后的 ON 不会执行，但 runMigrations rethrow 使启动失败，可接受。
    version: 16,
    note: 'categories 去 scope 表重建：值域合一（agent/human 共用一套分类，UNIQUE(name)；同名行小 id 保留，creators 双列按名重定向到保留行）。scope-free 写法保证新库重放完整执行不残留脏事务',
    statements: [
      'PRAGMA foreign_keys = OFF',
      `BEGIN IMMEDIATE;
       CREATE TABLE categories_v16 (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         name        TEXT NOT NULL,
         sort_order  INTEGER NOT NULL DEFAULT 0,
         created_at  INTEGER NOT NULL,
         UNIQUE(name)
       );
       INSERT OR IGNORE INTO categories_v16 (id, name, sort_order, created_at)
         SELECT id, name, sort_order, created_at FROM categories ORDER BY id;
       UPDATE creators SET
         category_agent_id = (SELECT v.id FROM categories_v16 v JOIN categories o ON o.name = v.name WHERE o.id = creators.category_agent_id),
         category_human_id = (SELECT v.id FROM categories_v16 v JOIN categories o ON o.name = v.name WHERE o.id = creators.category_human_id);
       DROP TABLE categories;
       ALTER TABLE categories_v16 RENAME TO categories;
       CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order);
       COMMIT;`,
      'PRAGMA foreign_keys = ON',
    ],
  },
  {
    version: 17,
    note: 'clients 补 yt_login（YouTube 登录态 JSON 快照 {is_login}：2026-08-25 镜像 v14 bili_login——未登录时年龄限制视频播不了、pot 受限加重，批量 no_subtitle/pot_limited 判因依据）。ADD COLUMN 撞 duplicate column name 容忍（双写 schema.sql）',
    statements: [
      'ALTER TABLE clients ADD COLUMN yt_login TEXT',
    ],
  },
  {
    version: 18,
    note: 'collect_tasks.source CHECK 放行 douyin（2026-08-29 抖音平台接入，S2）。SQLite 无法 ALTER CHECK，学 v9/v12 单事务表重建；中断回滚重放幂等（回滚后旧表结构原样）。SQL 不引用被删列（v16 Hazard A 注），新库（schema.sql 已带 douyin CHECK）全量重放安全',
    statements: [
      `BEGIN IMMEDIATE;
       CREATE TABLE collect_tasks_v18 (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         source      TEXT NOT NULL CHECK(source IN ('bilibili','youtube','douyin')),
         source_vid  TEXT NOT NULL,
         url         TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','succeeded','failed','limited')),
         client_id   TEXT,
         creator_client_id TEXT,
         error       TEXT,
         result      TEXT,
         batch_id    TEXT,
         creator_uid TEXT,
         created_at  INTEGER NOT NULL,
         finished_at INTEGER
       );
       INSERT INTO collect_tasks_v18 (id, source, source_vid, url, status, client_id, creator_client_id, error, result, batch_id, creator_uid, created_at, finished_at)
         SELECT id, source, source_vid, url, status, client_id, creator_client_id, error, result, batch_id, creator_uid, created_at, finished_at FROM collect_tasks;
       DROP TABLE collect_tasks;
       ALTER TABLE collect_tasks_v18 RENAME TO collect_tasks;
       CREATE INDEX idx_tasks_status ON collect_tasks(status, created_at);
       COMMIT;`,
    ],
  },
  {
    // ASR 轨按引擎命名（2026-08-29 多引擎版本比对）：写入侧已改为 lan=asr-zh-<engine>（http/asr.ts
    // 单一事实源），存量 lan='asr-zh' 轨按其 asr 版本的 asr_engine 改名对齐——取该轨最新一条
    // （MAX(id)）有非空 engine 的 asr 版本；无任何 engine 信息回落 'asr-zh-unknown'。
    // subtitle_tracks 无 CHECK，纯 UPDATE 无需表重建；单事务包裹整体原子，WHERE lan='asr-zh'
    // 保证重放幂等（改名后不再命中）。多引擎混写同一存量轨的旧数据：版本行自带 asr_engine 不丢出处，
    // 其余引擎日后重转会按新命名落各自新轨。
    version: 19,
    note: 'ASR 轨按引擎改名：lan=asr-zh → asr-zh-<asr_engine>（JOIN subtitle_versions origin=asr 取最新非空 engine；无 engine 回落 unknown），lan_doc 同步中文（ASR·<engine>）。单事务 UPDATE，重放幂等',
    statements: [
      `BEGIN IMMEDIATE;
       UPDATE subtitle_tracks AS t
       SET lan = 'asr-zh-' || e.engine,
           lan_doc = '中文（ASR·' || e.engine || '）'
       FROM (
         SELECT sv.track_id, sv.asr_engine AS engine
         FROM subtitle_versions sv
         WHERE sv.id IN (
           SELECT MAX(id) FROM subtitle_versions
           WHERE origin = 'asr' AND asr_engine IS NOT NULL AND asr_engine != ''
           GROUP BY track_id
         )
       ) AS e
       WHERE t.lan = 'asr-zh' AND e.track_id = t.id;
       UPDATE subtitle_tracks
       SET lan = 'asr-zh-unknown', lan_doc = '中文（ASR·unknown）'
       WHERE lan = 'asr-zh';
       COMMIT;`,
    ],
  },
  {
    // 双写纪律（PLAN §3.2）：statements 与 schema.sql 的 comments DDL 逐字一致（含缩进/注释性空白，
    // 不按 TS 嵌套重排缩进）——db/comments.test.ts 有 sqlite_master.sql 逐字比对测试守漂移。
    version: 20,
    note: 'comments 表新建(2026-10-03 评论采集解冻):B 站视频评论完整分析树,两层(根+楼中楼平铺),UNIQUE(rpid_str) 幂等 upsert,missing_since 单列删除确认语义。双写 schema.sql;新库全量重放安全(CREATE IF NOT EXISTS)',
    statements: [
      `CREATE TABLE IF NOT EXISTS comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rpid_str       TEXT NOT NULL,
  video_id       INTEGER NOT NULL REFERENCES videos(id),
  root_rpid      TEXT NOT NULL DEFAULT '0',
  parent_rpid    TEXT NOT NULL DEFAULT '0',
  dialog_rpid    TEXT NOT NULL DEFAULT '0',
  is_root        INTEGER NOT NULL DEFAULT 1,  -- root_rpid='0' 冗余派生列(根列表索引前缀/统计免 CASE)
  mid_str        TEXT,
  uname          TEXT,                        -- member 快照冗余列(渲染免拆 JSON)
  member         TEXT,                        -- member 对象 JSON 快照(重采整体替换)
  message        TEXT,                        -- content.message 原文(检索列)
  content        TEXT,                        -- content 对象 JSON(emote/jump_url/pictures/@)
  like_count     INTEGER NOT NULL DEFAULT 0,  -- 点赞数(避 SQL 关键字 LIKE;重采更新)
  rcount         INTEGER NOT NULL DEFAULT 0,  -- 当前可见楼中楼数(根评论;对账分母 fallback,实时分母=page.count §4.5)
  reply_total    INTEGER NOT NULL DEFAULT 0,  -- B 站 count 字段:历史楼中楼总数(含已删,可>rcount)
  ctime_s        INTEGER,                     -- 发布时间,B 站原值 unix 秒!(列名显式 _s 后缀,防当毫秒与 *_at 混算)
  ip_location    TEXT,                        -- reply_control.location 解析(需登录态 cookie)
  state          INTEGER NOT NULL DEFAULT 0,  -- 0 正常 / 17 阿瓦隆隐藏(仅自己可见)
  invisible      INTEGER NOT NULL DEFAULT 0,
  folded         INTEGER NOT NULL DEFAULT 0,  -- folder.is_folded(该评论自身被折叠;has_folded=「有折叠子回复」不并入)
  up_like        INTEGER NOT NULL DEFAULT 0,  -- up_action.like(UP 觉得很赞)
  up_reply       INTEGER NOT NULL DEFAULT 0,  -- up_action.reply(UP 已回复)
  is_up          INTEGER NOT NULL DEFAULT 0,  -- 评论者==UP 主(String(upper_mid)==mid_str,服务端算)
  pin_kind       TEXT,                        -- 置顶:'admin'|'upper'|'vote';NULL 非置顶(每轮先清后打)
  first_seen_at  INTEGER NOT NULL,            -- 首采时刻(毫秒;upsert 保留)
  last_seen_at   INTEGER NOT NULL,            -- 最近一次在响应中见到(毫秒;missing 判定基准)
  first_page     INTEGER,                     -- 首采时主列表页序(仅根评论;诊断用)
  first_sort     TEXT,                        -- 首采排序 'hot'|'time'|'floor'(诊断)
  batch_id       TEXT,                        -- 首采批次 uuid(crypto.randomUUID(),node:crypto 零新增依赖;同轮所有行同值;重采不动)
  missing_since  INTEGER                      -- 首次缺席完整全量轮的扫描起始时刻(毫秒;仅根评论参与、仅完整轮置值);NULL=在库正常
)`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_rpid ON comments(rpid_str)',
      'CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, is_root, like_count DESC)',
      'CREATE INDEX IF NOT EXISTS idx_comments_root ON comments(root_rpid)',
      'CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_rpid)',
    ],
  },
  {
    // 通用任务台账（CLI 全功能 web 化 Phase 4）：asr-backfill / collect-find 两类长任务的
    // server 进程内串行队列，web 免经 CLI。jobs 行即台账（params/progress/result/error），
    // 物理不删（DELETE 语义 = cancel）；状态机 pending→running→done|failed，可取消→cancelled；
    // 重启恢复把 pending/running 置 cancelled（批任务不自动重跑）。IF NOT EXISTS 重放安全。
    // 编号 v21：初开发为 v20 与 main 先合入的 comments 迁移撞号（版本账本短路会永不建表），合并前让位。
    version: 21,
    note: 'jobs 通用任务台账（asr-backfill | collect-find；status: pending|running|done|failed|cancelled）+ status/created_at 两索引。新建表/索引用 IF NOT EXISTS（重放安全）+ 双写 schema.sql。v20 编号让位 comments 迁移，本迁移由 v20 改号 v21（2026-10-07 合并前修）',
    statements: [
      `CREATE TABLE IF NOT EXISTS jobs (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         type          TEXT NOT NULL,
         params_json   TEXT NOT NULL,
         status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
         progress_json TEXT,
         result_json   TEXT,
         error         TEXT,
         created_at    INTEGER NOT NULL,
         updated_at    INTEGER NOT NULL,
         started_at    INTEGER,
         finished_at   INTEGER
       );
       CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
       CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);`,
    ],
  },
  {
    // 双写纪律（PLAN §3.2）：statements 与 schema.sql 的 danmaku DDL 逐字一致（含缩进/注释性空白，
    // 不按 TS 嵌套重排缩进）——db/danmaku.test.ts 有 sqlite_master.sql 逐字比对测试守漂移。
    // 相对 PLAN §3.1 的偏差：末列 batch_id 为补入（§3.1 DDL 原文漏列，§3.3 upsert 语义要求
    // INSERT 带值且重采保留首采 batch_id，学 v20 comments.batch_id），schema.sql 已同步。
    version: 22,
    note: 'danmaku 表新建(2026-10-07 弹幕采集解冻):B 站视频弹幕池时间轴快照,seg.so protobuf 分段采集,UNIQUE(id_str) 幂等 upsert,无水位/missing 机制(全量重拉成本低)。双写 schema.sql;新库全量重放安全(CREATE IF NOT EXISTS)',
    statements: [
      `CREATE TABLE IF NOT EXISTS danmaku (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  id_str         TEXT NOT NULL,               -- field12 字符串唯一键
  video_id       INTEGER NOT NULL REFERENCES videos(id),
  cid            INTEGER NOT NULL,            -- 分 P 的 cid(oid)
  page           INTEGER NOT NULL DEFAULT 1,  -- 分 P 页码(extra.pages[].page;单 P = 1)
  progress_ms    INTEGER,                     -- 显示时间毫秒;高级弹幕可 -1(无时间点,原值保留)
  mode           INTEGER,                     -- 1-3 滚动 4 底 5 顶 6 逆向 7 高级 8 代码 9 BAS
  fontsize       INTEGER,
  color          INTEGER,                     -- 十进制 RGB(16777215=白色)
  mid_hash       TEXT,                        -- 发送者 CRC32 hex(匿名)
  content        TEXT,                        -- 弹幕正文(检索列)
  ctime_s        INTEGER,                     -- 发送时间,B 站原值 unix 秒!(显式 _s 后缀)
  weight         INTEGER,                     -- 智能屏蔽权重 0-10(低权重被云屏蔽)
  pool           INTEGER,                     -- 0 普通 1 字幕 2 特殊
  action         TEXT,                        -- UP 醒目等动作标记(实测样本未见,缺省 NULL)
  first_seen_at  INTEGER NOT NULL,            -- 首采时刻(毫秒;upsert 保留)
  last_seen_at   INTEGER NOT NULL,            -- 最近一次在响应中见到(毫秒;重采刷新)
  batch_id       TEXT                         -- 首采批次 uuid(crypto.randomUUID(),node:crypto 零新增依赖;同轮所有行同值;重采不动;§3.1 原文漏列,按 §3.3 语义补)
)`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_danmaku_id ON danmaku(id_str)',
      'CREATE INDEX IF NOT EXISTS idx_danmaku_video ON danmaku(video_id, cid, progress_ms)',
    ],
  },
];

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
  if (current > latest) {
    throw new Error(`DB user_version=${current} 超出本代码支持的最大版本 ${latest}（库由更新版本的 collector-server 写入，拒绝降级运行）`);
  }
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue; // 版本账本短路：已应用步骤跳过
    for (const stmt of step.statements) {
      try {
        db.exec(stmt);
      } catch (err) {
        const msg = (err as Error).message;
        // 容忍三类幂等性/部分库报错（双保险，见账本规则）：
        //   duplicate column name —— ADD COLUMN 在列已存在的库上重放；
        //   no such column        —— DROP COLUMN 在新 schema（列本就不存在）建的库上重放；
        //   no such table         —— UPDATE/SELECT 类步骤（如 v10 翻译轨订正）在缺表的部分
        //                             schema 库上重放（正规库必建全表，仅防御手工/损坏库）。
        if (!msg.includes('duplicate column name') && !msg.includes('no such column') && !msg.includes('no such table')) throw err;
      }
    }
    db.pragma(`user_version = ${step.version}`);
  }
}
