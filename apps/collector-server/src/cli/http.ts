// CLI → server 的 HTTP 客户端（基于 Node 22 内置 fetch）。
// 仅覆盖 CLI 需要的端点：探活、客户端列表、切上报、下发命令。
// server 侧路由详见 [http/clients.ts](apps/collector-server/src/http/clients.ts)；POST /api/clients/:id/command 由同事阶段2 在 server 端补齐。

// server 连不上（DNS/TCP/ECONNREFUSED）专用错误类型：调用方捕获后 emitError SERVER_UNREACHABLE。
export class ServerUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUnreachableError';
  }
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
}

// server HTTP 非 2xx 错误：带上响应体便于 CLI 透传给 agent。
export class ServerResponseError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, path: string) {
    super(`server ${path} → ${status}: ${body}`);
    this.name = 'ServerResponseError';
    this.status = status;
    this.body = body;
  }
}

export class ServerClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // 去尾斜杠，避免 new URL 双斜杠
    this.token = token;
  }

  // 探活：GET /ping，2xx 返回 true，连不上或非 2xx 返回 false（不抛）。
  async ping(): Promise<boolean> {
    try {
      const res = await this.raw('GET', '/ping');
      return res.ok;
    } catch {
      return false;
    }
  }

  // 客户端列表：GET /api/clients（可选 sort/desc 查询参数，2026-08-25 全端点排序）→ 取 .clients 数组。
  async listClients(params?: { sort?: string; desc?: boolean }): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (params?.sort !== undefined) qs.set('sort', params.sort);
    if (params?.desc !== undefined) qs.set('desc', params.desc ? 'true' : 'false');
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    const data = await this.requestJson('GET', `/api/clients${suffix}`);
    const clients = (data as { clients?: unknown[] } | null)?.clients;
    return Array.isArray(clients) ? clients : [];
  }

  // 切上报开关：POST /api/clients/:id/reporting { enabled }。
  async setReporting(clientId: string, enabled: boolean): Promise<unknown> {
    return this.requestJson('POST', `/api/clients/${encodeURIComponent(clientId)}/reporting`, { enabled });
  }

  // 切任务派发开关：POST /api/clients/:id/task-dispatch { enabled }。off = 仅上报状态
  //（server 调度器不再给该客户端派采集任务，保持连接上报）。
  async setTaskDispatch(clientId: string, enabled: boolean): Promise<unknown> {
    return this.requestJson('POST', `/api/clients/${encodeURIComponent(clientId)}/task-dispatch`, { enabled });
  }

  // 下发命令：POST /api/clients/:id/command { action, ...params, timeout? }。
  // timeout 透传给 server 端等待扩展回执的超时（毫秒）。
  async sendCommand(
    clientId: string,
    action: string,
    params: Record<string, unknown>,
    timeout?: number,
  ): Promise<unknown> {
    const body: Record<string, unknown> = { action, ...params };
    if (timeout !== undefined) body.timeout = timeout;
    return this.requestJson('POST', `/api/clients/${encodeURIComponent(clientId)}/command`, body);
  }

  // 批量打标：POST /api/tags/apply。vid 是平台视频 ID（B 站 BV 号 / YouTube 11 位 ID），
  // platform 缺省 bilibili（对齐 CLI --source 默认）。scope=档位。
  // system 档（no-subtitle 状态标）由采集链路自动打，CLI apply 同样放行（回填脚本/agent 调度用）。
  async applyTags(
    vids: string[],
    names: string[],
    scope: 'manual' | 'batch' | 'ai' | 'system',
    platform: 'bilibili' | 'youtube' = 'bilibili',
  ): Promise<unknown> {
    return this.requestJson('POST', '/api/tags/apply', {
      items: vids.map((vid) => ({ source: platform, source_vid: vid })),
      names,
      scope,
    });
  }

  // 批量移除：POST /api/tags/remove（scope 省略 = 删该名字全部四档）。
  async removeTags(
    vids: string[],
    names: string[],
    scope?: 'manual' | 'batch' | 'ai' | 'system',
    platform: 'bilibili' | 'youtube' = 'bilibili',
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      items: vids.map((vid) => ({ source: platform, source_vid: vid })),
      names,
    };
    if (scope !== undefined) body.scope = scope;
    return this.requestJson('POST', '/api/tags/remove', body);
  }

  // 批量建采集任务：POST /api/collect-tasks/batch（任务系统调度执行,扩展串行;
  // creator_uid 可选——合集/UP 批量的归属,未入库失败任务也能按 UP 筛）。
  async createCollectTasksBatch(body: {
    vids: string[];
    source: 'bilibili' | 'youtube';
    creator_uid?: string | null;
  }): Promise<unknown> {
    return this.requestJson('POST', '/api/collect-tasks/batch', body);
  }

  // 补翻写回：POST /api/translate/fill。lines 是逐行译文（一行 ↔ 源字幕一行），
  // 行对齐校验与时间轴拷贝在 server 端完成（server 侧 http/translate.ts）。
  async translateFill(source: string, sourceVid: string, fromLan: string, lines: string[]): Promise<unknown> {
    return this.requestJson('POST', '/api/translate/fill', {
      source, source_vid: sourceVid, from_lan: fromLan, lines,
    });
  }

  // ASR 转写写回：POST /api/asr/submit。cues 是段级字幕（from/to 秒 + content），
  // payload 合成与 no-subtitle 摘标在 server 端完成（server 侧 http/asr.ts）。
  async asrSubmit(source: string, vid: string, engine: string, cues: Array<{ from: number; to: number; content: string }>): Promise<unknown> {
    return this.requestJson('POST', '/api/asr/submit', { source, vid, engine, cues });
  }

  // 视频列表：GET /api/videos（查询参数透传 server 侧 filter 解析，如 tags/source/max_duration/sort）。
  // asr backfill 圈定用（生产库在 docker volume，宿主 CLI 直读有 virtiofs 风险，一律走 server HTTP）。
  async listVideos(params: Record<string, string | number | boolean>): Promise<{ total: number; items: Array<Record<string, unknown>> }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const data = await this.requestJson('GET', `/api/videos?${qs.toString()}`);
    const page = data as { total?: number; items?: Array<Record<string, unknown>> } | null;
    return { total: page?.total ?? 0, items: Array.isArray(page?.items) ? page!.items! : [] };
  }

  // 统一请求：fetch + JSON 解析 + 错误归一化。
  // 连不上 → ServerUnreachableError；非 2xx → ServerResponseError；2xx → 解析后的 JSON（无 body 时返回 null）。
  private async requestJson(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    if (!res.ok) {
      throw new ServerResponseError(res.status, text, path);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text; // 非 JSON 成功响应，原样返回
    }
  }

  // 裸 fetch 包装：构造 URL（用 new URL 拼 path，自动处理 base 斜杠）+ Authorization header。
  private async raw(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<Response> {
    const url = new URL(path, this.baseUrl).toString();
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await fetch(url, init);
    } catch (err) {
      throw new ServerUnreachableError(`cannot reach server at ${this.baseUrl}: ${(err as Error).message}`);
    }
  }
}
