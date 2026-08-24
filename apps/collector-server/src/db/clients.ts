import type Database from 'better-sqlite3';

// 客户端注册表读写（2026-08-24 popup 改名）：名字/时间线的唯一持久层。
// 在线态在 ws/server.ts 内存 connections（重启即失）；本表经 hello upsert / close touch 维护，
// server 重启、客户端离线后名字与「首次/最后见到」时间线不丢。

export interface KnownClient {
  client_id: string;
  name: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

/**
 * upsert 客户端（hello 握手 / client-name-state 改名时调用）。
 * name 三态：
 *   string     = 设名/改名（覆盖）；
 *   null       = 显式清除（新版扩展 hello 总是带 client_name 字段，null 即抹名）；
 *   undefined  = 未上报（旧扩展 hello 不带该字段——只刷 last_seen_at，DB 旧名保留不抹）。
 */
export function upsertClient(db: Database.Database, clientId: string, name: string | null | undefined): void {
  const now = Date.now();
  if (name === undefined) {
    db.prepare(
      `INSERT INTO clients (client_id, name, first_seen_at, last_seen_at) VALUES (?, NULL, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(clientId, now, now);
    return;
  }
  db.prepare(
    `INSERT INTO clients (client_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`,
  ).run(clientId, name, now, now);
}

/** 连接断开时刷新 last_seen_at（「离线时长」的起算点）。 */
export function touchClientLastSeen(db: Database.Database, clientId: string): void {
  db.prepare('UPDATE clients SET last_seen_at = ? WHERE client_id = ?').run(Date.now(), clientId);
}

/** 全量已知客户端（最近活跃在前）。 */
export function listKnownClients(db: Database.Database): KnownClient[] {
  return db
    .prepare('SELECT client_id, name, first_seen_at, last_seen_at FROM clients ORDER BY last_seen_at DESC')
    .all() as KnownClient[];
}
