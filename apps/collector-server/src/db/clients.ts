import type Database from 'better-sqlite3';

// 客户端注册表读写（2026-08-24 popup 改名）：名字/登录态/版本/时间线的唯一持久层。
// 在线态在 ws/server.ts 内存 connections（重启即失）；本表经 hello upsert / close touch 维护，
// server 重启、客户端离线后名字与「首次/最后见到」时间线不丢。

export interface KnownClient {
  client_id: string;
  name: string | null;
  bili_login: string | null; // B 站登录态 JSON 快照（原始字符串，解析容错在消费侧 listClients）
  ext_version: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

/** hello / login-state 随带的落库元信息（三态语义与 name 一致：undefined=不上报不动，null=清除）。 */
export interface ClientUpsertMeta {
  biliLogin?: string | null;
  extVersion?: string | null;
}

/**
 * upsert 客户端（hello 握手 / client-name-state 改名 / login-state 登录态变化时调用）。
 * 各列三态：string（或对象 JSON）= 覆盖；null = 显式清除；undefined = 未上报（不动 DB 旧值）。
 * name 的 undefined 分支服务于旧扩展 hello 不带 client_name 的兼容，其余列同理（旧扩展不带 bili_login）。
 */
export function upsertClient(
  db: Database.Database,
  clientId: string,
  name: string | null | undefined,
  meta: ClientUpsertMeta = {},
): void {
  const now = Date.now();
  const cols: string[] = ['client_id', 'first_seen_at', 'last_seen_at'];
  const vals: unknown[] = [clientId, now, now];
  const sets: string[] = ['last_seen_at = excluded.last_seen_at'];
  if (name !== undefined) { cols.push('name'); vals.push(name); sets.push('name = excluded.name'); }
  if (meta.biliLogin !== undefined) { cols.push('bili_login'); vals.push(meta.biliLogin); sets.push('bili_login = excluded.bili_login'); }
  if (meta.extVersion !== undefined) { cols.push('ext_version'); vals.push(meta.extVersion); sets.push('ext_version = excluded.ext_version'); }
  db.prepare(
    `INSERT INTO clients (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(client_id) DO UPDATE SET ${sets.join(', ')}`,
  ).run(...vals);
}

/** 连接断开时刷新 last_seen_at（「离线时长」的起算点）。 */
export function touchClientLastSeen(db: Database.Database, clientId: string): void {
  db.prepare('UPDATE clients SET last_seen_at = ? WHERE client_id = ?').run(Date.now(), clientId);
}

/** 全量已知客户端（最近活跃在前）。 */
export function listKnownClients(db: Database.Database): KnownClient[] {
  return db
    .prepare('SELECT client_id, name, bili_login, ext_version, first_seen_at, last_seen_at FROM clients ORDER BY last_seen_at DESC')
    .all() as KnownClient[];
}
