// CLI 输出层单测：emitResult 四格式（json/ndjson/csv/table）+ emitError（stdout JSON 体 + stderr 人类行 + 语义化退出码 + quiet 抑制）。
// stdout/stderr 用临时替换收集（同步窗口内），process.exit stub 成记录后抛哨兵（防真退出进程）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | emitResult 全格式（含 CSV 转义/表格对齐）+ emitError/quiet + 退出码表 | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitResult, emitError, setQuiet, EXIT_CODES, type Format } from './output.js';

// 收集 fn 执行期间的 stdout/stderr 写入（同步替换，finally 恢复，避免吃掉 reporter 输出）。
function capture(fn: () => void): { out: string; err: string } {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { out, err };
}

// stub process.exit：记录调用码并抛哨兵中断（emitError 声明 never，靠这里真停不退出进程）。
const EXIT_SENTINEL = Symbol('cli-exit');
function stubExit(fn: () => void): { codes: number[] } {
  const orig = process.exit;
  const codes: number[] = [];
  process.exit = ((code?: number) => { codes.push(code ?? 0); throw EXIT_SENTINEL; }) as typeof process.exit;
  try {
    fn();
  } catch (e) {
    if (e !== EXIT_SENTINEL) throw e;
  } finally {
    process.exit = orig;
  }
  return { codes };
}

// 组合 helper：先 capture 再 stubExit——emitError 写完 stdout/stderr 后 process.exit 抛哨兵，
// 哨兵必须在 capture 的同步窗口内被 stubExit 吞掉，capture 的捕获对象才能正常返回。
function captureExit(fn: () => void): { out: string; err: string; codes: number[] } {
  const ret = { codes: [] as number[] };
  const cap = capture(() => { ret.codes = stubExit(fn).codes; });
  return { out: cap.out, err: cap.err, codes: ret.codes };
}

const emit = (data: unknown, format: Format): string => capture(() => emitResult(data, format)).out;

// ── emitResult: json ──

test('emitResult json：pretty JSON + 换行', () => {
  assert.equal(emit({ ok: true, items: [1] }, 'json'), JSON.stringify({ ok: true, items: [1] }, null, 2) + '\n');
});

// ── emitResult: ndjson ──

test('emitResult ndjson：list 类（含 items）逐条一行', () => {
  const out = emit({ total: 2, page: 1, size: 20, items: [{ id: 1 }, { id: 2 }] }, 'ndjson');
  assert.equal(out, '{"id":1}\n{"id":2}\n');
});

test('emitResult ndjson：非 list 单对象 → 单行', () => {
  assert.equal(emit({ ok: true }, 'ndjson'), '{"ok":true}\n');
});

test('emitResult ndjson：items 空数组 → 零行输出', () => {
  assert.equal(emit({ total: 0, items: [] }, 'ndjson'), '');
});

// ── emitResult: csv ──

test('emitResult csv：转义（逗号/引号/换行双引号包裹）、null/undefined 空串、对象 JSON 化、字段并集补空', () => {
  const out = emit(
    {
      items: [
        { a: 'x,y', b: 'he"llo', c: null },
        { a: 'line\nbreak', d: { k: 1 } },
      ],
    },
    'csv',
  );
  // 字段并集 [a,b,c,d]；含 , " \n 的字段双引号包裹、内部引号双写
  assert.equal(out, 'a,b,c,d\n"x,y","he""llo",,\n"line\nbreak",,,"{""k"":1}"\n');
});

test('emitResult csv：非 list 单对象 → 表头 + 单行（字段保序）', () => {
  assert.equal(emit({ b: 2, a: 1 }, 'csv'), 'b,a\n2,1\n');
});

test('emitResult csv：空 items → 不输出（无表头）', () => {
  assert.equal(emit({ items: [] }, 'csv'), '');
});

// ── emitResult: table ──

test('emitResult table：列宽对齐（最大值 + 两空格分隔 + 行尾 trim）', () => {
  const out = emit({ items: [{ id: 1, name: '甲' }, { id: 2222, name: '乙乙' }] }, 'table');
  assert.equal(out, 'id    name\n1     甲\n2222  乙乙\n');
});

test('emitResult table：空 items → (no rows)', () => {
  assert.equal(emit({ items: [] }, 'table'), '(no rows)\n');
});

test('emitResult table：非 list 单对象 → 单行表', () => {
  assert.equal(emit({ key: 'k', count: 3 }, 'table'), 'key  count\nk    3\n');
});

// ── emitError ──

test('emitError：stdout JSON 体（含 extra 并入）+ stderr 一行 + 语义化退出码', () => {
  const { out, err, codes } = captureExit(() => emitError('boom', 'RUNTIME', { status: 503 }));
  assert.deepEqual(codes, [EXIT_CODES.RUNTIME]);
  assert.deepEqual(JSON.parse(out), { ok: false, error: 'boom', code: 'RUNTIME', status: 503 });
  assert.equal(err, '[collector-cli] RUNTIME: boom\n');
});

test('emitError：quiet 只抑制 stderr，stdout JSON 错误体仍在（agent 仍可解析）', () => {
  setQuiet(true);
  try {
    const { out, err, codes } = captureExit(() => emitError('nope', 'NOT_FOUND'));
    assert.deepEqual(codes, [EXIT_CODES.NOT_FOUND]);
    assert.deepEqual(JSON.parse(out), { ok: false, error: 'nope', code: 'NOT_FOUND' });
    assert.equal(err, '');
  } finally {
    setQuiet(false);
  }
});

test('EXIT_CODES：语义化退出码不漂移（外部脚本按码分支）', () => {
  assert.deepEqual(EXIT_CODES, {
    OK: 0, RUNTIME: 1, ARGS: 2, SERVER_UNREACHABLE: 3, DB_UNREADABLE: 4, NOT_FOUND: 5, EXT_UPDATE: 6,
  });
});
