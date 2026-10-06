// ── 下载工具（CLI 全功能 web 化 Phase 2：导出/原料包下载共用）──
// downloadUrl：fetch → Blob → <a download> 触发浏览器保存，返回文件名 + 数量头 + 响应头。
// 错误统一抛 Error（尽量带出 server JSON 的 error 文案，对齐 api-core ensureOk 风格）。
// 纯函数 parseContentDisposition / readCountHeader 可独立复用与单测。

import { apiFetch } from '../apiCore';

// Content-Disposition → 文件名（RFC 5987 filename*=UTF-8''xx 优先，回落普通 filename=；
// 都解析不出 → null，调用方用 fallback 文件名）。value 可带引号，统一剥掉。
export function parseContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, '')) || null;
    } catch {
      // 非法百分号编码（decodeURIComponent 抛）→ 回落普通 filename 分支
    }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/);
  return plain ? plain[1]!.trim() || null : null;
}

// X-Export-Count 风格的数字响应头 → number（缺头/非数字 → undefined）
export function readCountHeader(header: string | null): number | undefined {
  if (header == null || header.trim() === '') return undefined;
  const n = Number(header);
  return Number.isFinite(n) ? n : undefined;
}

export interface DownloadResult {
  filename: string;    // 实际落盘文件名（Content-Disposition 优先，fallback 兜底）
  count?: number;      // X-Export-Count（导出条数；头缺失则缺省）
  headers: Headers;    // 完整响应头（X-Bundle-* 等多头场景由调用方直读）
}

// 下载 url 指向的文件：!ok 读 JSON 错误并抛；成功触发浏览器保存并返回结果。
export async function downloadUrl(url: string, fallbackFilename: string): Promise<DownloadResult> {
  const r = await apiFetch(url);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j?.error) detail += `：${j.error}`;
    } catch {
      // 非 JSON 错误体：只带状态码
    }
    throw new Error(detail);
  }
  const blob = await r.blob();
  const filename = parseContentDisposition(r.headers.get('content-disposition')) ?? fallbackFilename;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(objUrl);
  return { filename, count: readCountHeader(r.headers.get('x-export-count')), headers: r.headers };
}
