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
