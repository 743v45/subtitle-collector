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
  method: 'GET' | 'POST';
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

  // 客户端列表：GET /api/clients → 取 .clients 数组。
  async listClients(): Promise<unknown[]> {
    const data = await this.requestJson('GET', '/api/clients');
    const clients = (data as { clients?: unknown[] } | null)?.clients;
    return Array.isArray(clients) ? clients : [];
  }

  // 切上报开关：POST /api/clients/:id/reporting { enabled }。
  async setReporting(clientId: string, enabled: boolean): Promise<unknown> {
    return this.requestJson('POST', `/api/clients/${encodeURIComponent(clientId)}/reporting`, { enabled });
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

  // 统一请求：fetch + JSON 解析 + 错误归一化。
  // 连不上 → ServerUnreachableError；非 2xx → ServerResponseError；2xx → 解析后的 JSON（无 body 时返回 null）。
  private async requestJson(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
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
  private async raw(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Response> {
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
