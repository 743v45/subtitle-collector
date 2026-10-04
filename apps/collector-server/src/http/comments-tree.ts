// GET /api/videos/:source/:vid/comments —— 单视频评论树（web 详情页用，P2-5 web 评论展示）。
// 树形组装与 CLI comments tree 共享 db/comments-tree.ts shapeTree（同 §6.3 语义：根赞降序由
// treeByVideo 保证、楼层 depth 拍平、「回复 @」指向、回复对象已删除、孤儿组不丢弃）。
// 路由自持（正则匹配在 handler 内，未命中返回 false 交还调用方继续分发），queries.ts 一行分发。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getVideo } from '../db/queries.js';
import { treeByVideo } from '../db/comments.js';
import { shapeTree } from '../db/comments-tree.js';
import { json } from './http-util.js';

const COMMENTS_ROUTE = /^\/api\/videos\/([^/]+)\/([^/]+)\/comments$/;

/**
 * 评论树子路由：命中并处理 → true（调用方终止分发）；未命中/方法不符 → false。
 * limit 只截根数，缺省/0=不限，对齐 CLI tree --limit 语义；非负整数校验，非法 → 400。
 */
export async function handleCommentsTreeHttp(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  url: URL,
  pathname: string,
): Promise<boolean> {
  const m = pathname.match(COMMENTS_ROUTE);
  if (!m || req.method !== 'GET') return false;
  const source = m[1];
  const sourceVid = decodeURIComponent(m[2]);
  const video = getVideo(db, source, sourceVid);
  if (!video) {
    console.error(`[http] comments tree: video not found source=${source} vid=${sourceVid}`);
    json(res, 404, { ok: false, error: 'video not found' });
    return true;
  }
  const limitRaw = url.searchParams.get('limit');
  if (limitRaw != null && !/^\d+$/.test(limitRaw)) {
    console.error(`[http] comments tree: bad limit=${limitRaw} source=${source} vid=${sourceVid}`);
    json(res, 400, { ok: false, error: `limit must be a non-negative integer, got: ${limitRaw}` });
    return true;
  }
  const limit = limitRaw != null ? Number(limitRaw) : 0;
  const shaped = shapeTree(treeByVideo(db, video.video.id as number), { limit: limit || undefined });
  json(res, 200, {
    ok: true,
    source,
    source_vid: sourceVid,
    counts: shaped.counts,
    roots: shaped.roots,
    orphans: shaped.orphans,
    truncated: shaped.truncated,
    limit,
  });
  return true;
}
