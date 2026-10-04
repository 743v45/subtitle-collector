// 静态文件服务（从 main.ts serveStatic 抽出，2026-10-04）：collector-web 构建产物托管。
// 安全：路径穿越防护（解析后必须在 root 之下）+ 仅 regular file（目录 readFileSync 会 EISDIR
// 同步抛出——此前不在 runHandler 兜底内，直接崩掉整个 server 进程；冒烟实测请求 /assets/
// 目录路径复现，修复为 statSync isFile 判定，目录与不存在一律 404）。
import { statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { ServerResponse } from 'node:http';

export interface StaticFileServer {
  (reqUrl: string | undefined, res: ServerResponse): void;
}

export function createStaticFileServer(rootDir: string, mime: Record<string, string>): StaticFileServer {
  return (reqUrl, res) => {
    const url = new URL(reqUrl ?? '/', 'http://localhost');
    const fp = join(rootDir, url.pathname === '/' ? '/index.html' : url.pathname);
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = fp.startsWith(rootDir) ? statSync(fp) : null;
    } catch {
      stat = null; // 不存在/无权限 → 同 404（可观察性：带路径日志）
    }
    if (!stat?.isFile()) {
      console.warn(`[http:static] 404 url=${url.pathname}`);
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const contentType = mime[extname(fp)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(readFileSync(fp));
  };
}
