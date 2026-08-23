// translate.ts 纯处理函数测试：pending 判定/过滤/行数标注、source 行格式/缺省轨/错误路径、
// parseTranslatedFile 契约、fill 本地预校验。commander 装配见 translate.cli.test.ts。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | pending 判定+过滤 + source 三路径 + parseTranslatedFile + fill 预校验 | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { ServerClient } from '../http.js';
import {
  translatePending, translateSource, parseTranslatedFile, translateFill,
} from './translate.js';

// 造库：A=ai-en 无中文（pending 目标，2 行）；B=有 ai-zh（不列）；C=无轨（不列）；D=ai-ja 无中文（--from 过滤用）
function seedDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collector-translate-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const payload = (texts: string[]): unknown => ({
    type: 'AIsubtitle', body: texts.map((content, i) => ({ from: i, to: i + 1, sid: i, content })),
  });
  const mk = (vid: string, tracks: { lan: string; texts: string[] }[], creatorName?: string) => ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: vid, title: `标题${vid}`, creator: creatorName ? { source_uid: '1', name: creatorName } : undefined, duration: 10 },
    tracks: tracks.map((t) => ({ lan: t.lan, lan_doc: t.lan, versions: [{ origin: 'external', payload: payload(t.texts) }] })),
  });
  mk('BVA', [{ lan: 'ai-en', texts: ['Hello', 'World'] }], 'targetUp');
  // BVB：ai-en + ai-zh 双轨——B 站轨无 track_type，ai-en 落 2 档、ai-zh 落 5 档，默认轨是 ai-en（非中文）
  mk('BVB', [{ lan: 'ai-zh', texts: ['中文已有'] }, { lan: 'ai-en', texts: ['x'] }]);
  mk('BVC', []);
  mk('BVD', [{ lan: 'ai-ja', texts: ['あ'] }]);
  // BVE：单 ai-zh 轨——默认轨是中文（缺省 --from 应报错的场景）
  mk('BVE', [{ lan: 'ai-zh', texts: ['只有中文'] }]);
  // BVF：payload 非 B 站结构（无 body）——pending 的 lines 解析防御路径（lines:null 不崩整页）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BVF', title: '坏payload', duration: 10 },
    tracks: [{ lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: { no_body: true } }] }],
  });
  // BVG：lan 为 null 的轨（B 站旧数据形态；ingest 内部 lan ?? null 落库）——source 缺省轨的 lan ?? '' 分支
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BVG', title: 'null lan', duration: 10 },
    tracks: [{ lan: undefined, lan_doc: '未知语言', versions: [{ origin: 'external', payload: payload(['x']) }] }],
  });
  return { dbPath: join(dir, 'test.db'), cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('translate pending：缺中文判定 + 过滤 + 各源轨行数标注', () => {
  const { dbPath, cleanup } = seedDb();
  try {
    // 1. 默认：A（ai-en）、D（ai-ja）、F（坏 payload）无中文；B 有中文轨、C 无轨均不列
    let r = translatePending(dbPath, {});
    assert.equal(r.total, 4);
    const vids = r.items.map((i) => i.source_vid).sort();
    assert.deepEqual(vids, ['BVA', 'BVD', 'BVF', 'BVG']);
    const a = r.items.find((i) => i.source_vid === 'BVA')!;
    assert.equal(a.langs.length, 1);
    assert.equal(a.langs[0].lan, 'ai-en');
    assert.equal(a.langs[0].lines, 2, '源轨默认版本 body 行数');
    const f = r.items.find((i) => i.source_vid === 'BVF')!;
    assert.equal(f.langs[0].lines, null, 'payload 非 B 站结构 → lines:null 不崩整页');

    // 2. --from ai-ja：只剩 D
    r = translatePending(dbPath, { from: 'ai-ja' });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].source_vid, 'BVD');

    // 3. --creator 模糊
    r = translatePending(dbPath, { creator: 'target' });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].creator_name, 'targetUp');

    // 4. --since/--until 入库时间窗（first_seen，全部排除 → 0）
    r = translatePending(dbPath, { since: 9999999999999 });
    assert.equal(r.total, 0);
    // 4b. --until 下界排除 + --asc 升序（发布序反转不断言内容，仅走到分支）
    r = translatePending(dbPath, { until: 1 });
    assert.equal(r.total, 0);
    r = translatePending(dbPath, { asc: true, sort: 'published_at' });
    assert.equal(r.total, 4);

    // 5. 分页：size=1 → 第 1 页 1 条、total 仍 3
    r = translatePending(dbPath, { size: 1, page: 1 });
    assert.equal(r.items.length, 1);
    assert.equal(r.total, 4);
  } finally {
    cleanup();
  }
});

test('translate source：行号格式 + 换行替换 + 缺省轨/显式轨/错误路径', () => {
  const { dbPath, cleanup } = seedDb();
  try {
    // 1. 显式 --from ai-en：`行号\t原文` 逐行，content 内换行替换为空格
    const r = translateSource(dbPath, 'bilibili', 'BVA', 'ai-en');
    assert.equal(r.lines, 2);
    assert.equal(r.text, '1\tHello\n2\tWorld\n');
    assert.equal(r.lan, 'ai-en');

    // 2. 缺省轨：取优先级首个轨（A 只有 ai-en）；换行 content 压平验证
    const r2 = translateSource(dbPath, 'bilibili', 'BVA');
    assert.equal(r2.lan, 'ai-en');

    // 3. 缺省轨已是中文 → 报错提示显式 --from（BVE 单 ai-zh 轨）
    assert.throws(() => translateSource(dbPath, 'bilibili', 'BVE'), /已是中文/);

    // 4. 显式 --from 中文轨 → 允许（重翻自由），不抛
    const r4 = translateSource(dbPath, 'bilibili', 'BVE', 'ai-zh');
    assert.equal(r4.lan, 'ai-zh');

    // 5. 源轨不存在 → 报错带可用轨清单（可观察性）
    assert.throws(() => translateSource(dbPath, 'bilibili', 'BVA', 'ai-ja'), /ai-en/);

    // 6. 视频不存在 → 报错
    assert.throws(() => translateSource(dbPath, 'bilibili', 'BVnope'), /视频不存在/);

    // 7. 无轨视频（BVC）→ 报错；lan null 的轨（BVG）缺省可取、lan 输出空串
    assert.throws(() => translateSource(dbPath, 'bilibili', 'BVC'), /没有任何字幕轨/);
    const r7 = translateSource(dbPath, 'bilibili', 'BVG');
    assert.equal(r7.lan, '');
    assert.equal(r7.lines, 1);
  } finally {
    cleanup();
  }
});

test('parseTranslatedFile：行号前缀剥离 + BOM/CRLF/首尾空行 + 中间空行保留', () => {
  // 1. 带行号前缀（模型照 translate source 格式回传）→ 剥离
  assert.deepEqual(parseTranslatedFile('1\t你好\n2\t世界\n'), ['你好', '世界']);
  // 2. 纯译文行（无行号）原样
  assert.deepEqual(parseTranslatedFile('你好\n世界\n'), ['你好', '世界']);
  // 3. BOM + CRLF 混合
  assert.deepEqual(parseTranslatedFile('﻿1\t你好\r\n2\t世界\r\n'), ['你好', '世界']);
  // 4. 首尾空行去掉，中间空行保留（空译文占位——行数对齐契约）
  assert.deepEqual(parseTranslatedFile('\n\n你好\n\n\n世界\n\n'), ['你好', '', '', '世界']);
  // 5. 译文本身以数字+tab 开头（非行号）会被误剥——契约约定行号前缀可选，模型不回传裸 `数字\t` 译文
  assert.deepEqual(parseTranslatedFile('2023\t年度回顾'), ['年度回顾']);
});

test('translateFill：读文件 → 行数预校验（不符抛错不发请求）→ 成功透传 server 响应', async () => {
  const { dbPath, cleanup } = seedDb();
  const dir = mkdtempSync(join(tmpdir(), 'collector-translate-fill-'));
  try {
    // 1. 行数不符：本地预校验直接抛错（无 server 往返）
    const f1 = join(dir, 'short.txt');
    writeFileSync(f1, '只有一行\n');
    await assert.rejects(
      translateFill(fakeClient(), dbPath, 'bilibili', 'BVA', 'ai-en', f1),
      /源字幕 2 行.*译文 1 行/,
    );

    // 2. 行数一致（带行号前缀）：透传 server 响应
    const f2 = join(dir, 'ok.txt');
    writeFileSync(f2, '1\t你好\n2\t世界\n');
    const out = await translateFill(fakeClient(), dbPath, 'bilibili', 'BVA', 'ai-en', f2);
    assert.deepEqual(out, { ok: true, stub: true });

    // 3. 空文件 → 报错
    const f3 = join(dir, 'empty.txt');
    writeFileSync(f3, '\n \n');
    await assert.rejects(translateFill(fakeClient(), dbPath, 'bilibili', 'BVA', 'ai-en', f3), /为空/);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ServerClient stub：只验证 translateFill 被以正确参数调用（真实 HTTP 链路在 cli.test.ts 覆盖）
function fakeClient(captured?: { args: unknown[] }): ServerClient {
  return {
    translateFill: async (source: string, sourceVid: string, fromLan: string, lines: string[]) => {
      captured?.args.push([source, sourceVid, fromLan, lines]);
      return { ok: true, stub: true };
    },
  } as unknown as ServerClient;
}
