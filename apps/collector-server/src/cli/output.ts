// CLI 输出层：统一 stdout 结构化数据 + stderr 人类日志 + 语义化退出码。
// 设计见 [设计文档第4章](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
//
// 约定：
// - 成功数据写 stdout（emitResult），失败信息写 stdout(JSON) + stderr(一行人类可读) + 退出码（emitError）。
// - quiet 模式（全局 -q）只抑制 stderr，不影响 stdout 的 JSON 错误体（agent 仍能解析错误）。

export const EXIT_CODES = {
  OK: 0,
  RUNTIME: 1,
  ARGS: 2,
  SERVER_UNREACHABLE: 3,
  DB_UNREADABLE: 4,
  NOT_FOUND: 5,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;

export type Format = 'json' | 'ndjson' | 'csv' | 'table';

// quiet 是全局态：main.ts 在 preAction 钩子里调 setQuiet，emitError 据此决定是否写 stderr。
let quiet = false;
export function setQuiet(v: boolean): void {
  quiet = v;
}

// 从 data 中提取 items 数组：list 类结果形如 {total,page,size,items}。
function extractItems(data: unknown): unknown[] | null {
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: unknown[] }).items;
  }
  return null;
}

// CSV 字段转义：含逗号/引号/换行的字段用双引号包裹，内部引号双写。
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// 取对象数组字段并集（保留首次出现顺序）。
function collectFields(rows: unknown[]): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row as Record<string, unknown>)) {
        if (!seen.has(k)) {
          seen.add(k);
          fields.push(k);
        }
      }
    }
  }
  return fields;
}

// 把一组对象输出为 CSV（首行表头 + 各行），末尾换行。
function emitCsv(rows: unknown[]): void {
  if (rows.length === 0) return;
  const fields = collectFields(rows);
  const lines = [fields.map(csvEscape).join(',')];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    lines.push(fields.map((f) => csvEscape(r[f])).join(','));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// 简单文本对齐表格（不引外部库）：列宽取最大值，列间两空格。
function emitTable(rows: unknown[]): void {
  if (rows.length === 0) {
    process.stdout.write('(no rows)\n');
    return;
  }
  const fields = collectFields(rows);
  const stringify = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const strRows = rows.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const f of fields) out[f] = stringify(r[f]);
    return out;
  });
  const widths: Record<string, number> = {};
  for (const f of fields) {
    widths[f] = f.length;
    for (const r of strRows) if (r[f].length > widths[f]) widths[f] = r[f].length;
  }
  const formatRow = (r: Record<string, string>): string =>
    fields.map((f) => r[f].padEnd(widths[f])).join('  ').trimEnd();
  const lines = [fields.map((f) => f.padEnd(widths[f])).join('  ').trimEnd()];
  for (const r of strRows) lines.push(formatRow(r));
  process.stdout.write(lines.join('\n') + '\n');
}

// 成功数据写 stdout。data 形态决定 list/单条：
// - list 类（含 items 数组）：json 输出整对象；ndjson/csv/table 拆出 items 逐条。
// - 单条对象：ndjson 单行 JSON；csv 表头+单行；table 单行表。
export function emitResult(data: unknown, format: Format): void {
  switch (format) {
    case 'json':
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      break;
    case 'ndjson': {
      const items = extractItems(data);
      if (items) {
        for (const it of items) process.stdout.write(JSON.stringify(it) + '\n');
      } else {
        process.stdout.write(JSON.stringify(data) + '\n');
      }
      break;
    }
    case 'csv': {
      const items = extractItems(data);
      emitCsv(items ?? [data]);
      break;
    }
    case 'table': {
      const items = extractItems(data);
      emitTable(items ?? [data]);
      break;
    }
  }
}

// 失败：stdout 写结构化错误体（agent 解析），stderr 写人类一行（quiet 时抑制），按 code 退出。
// extra 字段并入 stdout JSON（如可附 HTTP status / 命名错误类型）。
export function emitError(
  message: string,
  code: ExitCodeName,
  extra?: Record<string, unknown>,
): never {
  const body = { ok: false, error: message, code, ...extra };
  process.stdout.write(JSON.stringify(body) + '\n');
  if (!quiet) {
    process.stderr.write(`[collector-cli] ${code}: ${message}\n`);
  }
  process.exit(EXIT_CODES[code]);
}
