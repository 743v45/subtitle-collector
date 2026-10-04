// http/zip.ts 测试：零依赖 zip 打包（deflate + 手写容器）。
// 覆盖：两文件（中文文件名 + 多行内容）本地头逐字段解析 + inflateRawSync 内容抽回 /
// unzip -t 完整性（系统 unzip 交叉验证）/ 空数组与重名防御 / mtime → DOS 时间字段。
// 措辞：字幕（subtitle），非弹幕。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 容器结构/内容回抽/unzip -t/空数组/重名/mtime | 通过 | Phase 2 下载通道 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createZip } from './zip.js';

// 从 zip Buffer 顺序解析本地文件头（30B 定长 + 文件名 [+ extra=0] + 压缩数据），
// 断言关键字段（flags bit 11 / method=8）并 inflateRawSync 抽回原文。
function readLocalEntries(buf: Buffer): Array<{ name: string; content: string; flags: number; method: number }> {
  const out: Array<{ name: string; content: string; flags: number; method: number }> = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const content = inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString('utf8');
    out.push({ name, content, flags, method });
    off = dataStart + compSize;
  }
  return out;
}

test('zip：两文件（中文文件名 + 多行内容）——本地头字段 + inflateRawSync 内容抽回 + unzip -t 完整性', () => {
  const files = [
    { name: 'manifest.json', content: '{"total": 2}\n第二行中文内容\n' },
    { name: 'videos/中文标题-BV1.txt', content: '[00:00] 你好世界\n[00:04] 第二行字幕\n' },
  ];
  const zip = createZip(files);
  // 魔数与 EOCD 尾签（zip 文件头尾特征）
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);

  const entries = readLocalEntries(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.name), ['manifest.json', 'videos/中文标题-BV1.txt']);
  for (const e of entries) {
    assert.equal(e.method, 8, '压缩方法应为 deflate');
    assert.equal((e.flags & 0x0800) !== 0, true, 'UTF-8 文件名 flag（bit 11）应置位');
  }
  assert.equal(entries[0].content, files[0].content);
  assert.equal(entries[1].content, files[1].content);

  // 系统 unzip 交叉验证：unzip -t 逐条 CRC 校验，报错即失败。注意 macOS 自带 unzip 对 UTF-8 文件名
  // 显示为乱码（解码能力老旧），故只锚 ASCII 前后缀；中文名正确性已由上面字节级解析覆盖。
  const dir = mkdtempSync(join(tmpdir(), 'collector-zip-'));
  try {
    const fp = join(dir, 'out.zip');
    writeFileSync(fp, zip);
    const out = execSync(`unzip -t ${JSON.stringify(fp)}`, { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
    assert.match(out, /testing: manifest\.json\s+OK/);
    assert.match(out, /videos\/[^ ]*-BV1\.txt\s+OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zip：mtime 选项 → DOS 时间/日期字段落位', () => {
  const zip = createZip([{ name: 'a.txt', content: 'x' }], { mtime: new Date(2024, 0, 15, 10, 30, 20) });
  const dosDate = zip.readUInt16LE(12); // 本地头 offset 12 = mod date
  const dosTime = zip.readUInt16LE(10); // offset 10 = mod time
  assert.equal((dosDate >> 9) + 1980, 2024);
  assert.equal((dosDate >> 5) & 0x0f, 1);
  assert.equal(dosDate & 0x1f, 15);
  assert.equal(dosTime >> 11, 10);
  assert.equal((dosTime >> 5) & 0x3f, 30);
  // 秒字段 2 秒精度（20/2=10）
  assert.equal(dosTime & 0x1f, 10);
});

test('zip：空数组 / 重名 → 防御性报错（拒绝打空包与歧义包）', () => {
  assert.throws(() => createZip([]), /files 为空/);
  assert.throws(
    () => createZip([{ name: 'a.txt', content: '1' }, { name: 'a.txt', content: '2' }]),
    /文件名重复: a\.txt/,
  );
});
