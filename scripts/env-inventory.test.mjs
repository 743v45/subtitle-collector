// 覆盖 env-inventory.mjs 的纯函数层：crontab 行定位/命令段解析/node 绝对路径判定、.env 解析与
// 单变量判定（占位符/空）、异地 .db 目录扫描与时新性、git 工作区判净。
// 盘点脚本是「外置配置仍正确」的守门员，判定逻辑必须被测试保护（CLAUDE.md 测试质量政策）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBackupExportLine,
  parseCronCommand,
  isAbsoluteNodePath,
  assessCronEntry,
  parseEnvFile,
  assessEnvValue,
  scanDbs,
  pickNewest,
  ageDays,
  isPorcelainClean,
} from './env-inventory.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ── crontab 行定位 ──

test('findBackupExportLine:多行里命中含 backup-export 的行', () => {
  const lines = [
    '33 1,7,13,19 * * * "/Users/taevas/.acme.sh"/acme.sh --cron --home "/Users/taevas/.acme.sh" > /dev/null',
    '23 10 * * * /opt/homebrew/bin/node /Users/taevas/Code/yawyd/subtitle-collector/scripts/backup-export.mjs "/x" --keep 1 >> /x/offsite.log 2>&1',
    '*/15 7-23 * * * /bin/bash /Users/taevas/Local/glm-keepalive/keepalive.sh >> /x/cron.log 2>&1',
  ];
  assert.equal(findBackupExportLine(lines), lines[1]);
});

test('findBackupExportLine:无 backup-export 行 → null（fail 信号）', () => {
  assert.equal(findBackupExportLine(['*/15 7-23 * * * /bin/bash /x/keepalive.sh']), null);
  assert.equal(findBackupExportLine([]), null);
});

// ── crontab 命令段解析 ──

test('parseCronCommand:/opt/homebrew/bin/node 形态 → node 与脚本各就各位', () => {
  const line = '23 10 * * * /opt/homebrew/bin/node /Users/taevas/Code/yawyd/subtitle-collector/scripts/backup-export.mjs "/Users/taevas/Library/CloudStorage/x" --keep 1 >> /x/offsite.log 2>&1';
  assert.deepEqual(parseCronCommand(line), {
    node: '/opt/homebrew/bin/node',
    script: '/Users/taevas/Code/yawyd/subtitle-collector/scripts/backup-export.mjs',
  });
});

test('parseCronCommand:重定向/参数在脚本之后,不影响解析(取 token 即可)', () => {
  const line = '23 10 * * * /usr/local/bin/node /repo/scripts/backup-export.mjs /dest --keep 1 >> /x.log 2>&1';
  const parsed = parseCronCommand(line);
  assert.equal(parsed.node, '/usr/local/bin/node');
  assert.equal(parsed.script, '/repo/scripts/backup-export.mjs');
});

test('parseCronCommand:裸 node(线上事故形态)也解析得出,交给 isAbsoluteNodePath 判否', () => {
  const parsed = parseCronCommand('23 10 * * * node /repo/scripts/backup-export.mjs /dest --keep 1');
  assert.equal(parsed.node, 'node');
  assert.equal(parsed.script, '/repo/scripts/backup-export.mjs');
});

test('parseCronCommand:无脚本 token / 脚本占 schedule 位 → null', () => {
  assert.equal(parseCronCommand('23 10 * * * /bin/echo hello'), null);
  assert.equal(parseCronCommand('backup-export.mjs /dest'), null);
});

// ── node 绝对路径判定 ──

test('isAbsoluteNodePath:/opt/homebrew/bin/node 与 nvm 路径命中', () => {
  assert.equal(isAbsoluteNodePath('/opt/homebrew/bin/node'), true);
  assert.equal(isAbsoluteNodePath('/Users/taevas/.nvm/versions/node/v24.18.0/bin/node'), true);
});

test('isAbsoluteNodePath:裸 node / 相对路径 / 非 bin 前缀 / 相近后缀都不命中', () => {
  assert.equal(isAbsoluteNodePath('node'), false);
  assert.equal(isAbsoluteNodePath('./bin/node'), false);
  assert.equal(isAbsoluteNodePath('/usr/local/node'), false);
  assert.equal(isAbsoluteNodePath('/opt/homebrew/bin/nodex'), false);
  assert.equal(isAbsoluteNodePath('/opt/homebrew/bin/node.exe'), false);
});

// ── crontab 检查全判定 ──

test('assessCronEntry:合规行(node 绝对路径+脚本存在)→ ok', () => {
  const verdict = assessCronEntry(
    '23 10 * * * /opt/homebrew/bin/node /repo/scripts/backup-export.mjs /dest --keep 1',
    () => true,
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.node, '/opt/homebrew/bin/node');
});

test('assessCronEntry:裸 node → fail,reason 点明 cron PATH 无 nvm 的静默死根因', () => {
  const verdict = assessCronEntry('23 10 * * * node /repo/scripts/backup-export.mjs /dest', () => true);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /裸 node/);
});

test('assessCronEntry:node 合法但行内脚本路径不存在 → fail', () => {
  const verdict = assessCronEntry('23 10 * * * /opt/homebrew/bin/node /gone/scripts/backup-export.mjs', () => false);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /脚本路径不存在/);
});

test('assessCronEntry:形态不对(解析不出)→ fail', () => {
  assert.equal(assessCronEntry('23 10 * * * /bin/echo hi', () => true).ok, false);
});

// ── .env 解析与单变量判定 ──

test('parseEnvFile:KEY=VALUE 逐行解析,跳过空行/注释/无 = 行,值可含 =', () => {
  const env = parseEnvFile([
    '# 注释',
    '',
    'COLLECTOR_TOKEN=abc123',
    'COLLECTOR_ALLOWED_HOSTS=192.168.1.5,10.0.0.2',
    'BROKEN_LINE_NO_EQUALS',
    'URL=http://x/?token=a=b',
  ].join('\n'));
  assert.equal(env.COLLECTOR_TOKEN, 'abc123');
  assert.equal(env.COLLECTOR_ALLOWED_HOSTS, '192.168.1.5,10.0.0.2');
  assert.equal(env.URL, 'http://x/?token=a=b');
  assert.equal('BROKEN_LINE_NO_EQUALS' in env, false);
});

test('parseEnvFile:值剥一层成对引号(单/双),内部空格保留', () => {
  const env = parseEnvFile('A="x y"\nB=\'z\'\nC="unclosed');
  assert.equal(env.A, 'x y');
  assert.equal(env.B, 'z');
  assert.equal(env.C, '"unclosed');
});

test('assessEnvValue:token 三态——缺失空/占位符 fail,真值 ok(reason 不回显值)', () => {
  assert.equal(assessEnvValue(undefined, { placeholder: 'change-me-collector-token' }).ok, false);
  assert.equal(assessEnvValue('', { placeholder: 'change-me-collector-token' }).ok, false);
  const ph = assessEnvValue('change-me-collector-token', { placeholder: 'change-me-collector-token' });
  assert.equal(ph.ok, false);
  assert.match(ph.reason, /占位符/);
  assert.equal(assessEnvValue('a1b2c3', { placeholder: 'change-me-collector-token' }).ok, true);
});

test('assessEnvValue:webhook 只查非空(不给 placeholder)', () => {
  assert.equal(assessEnvValue('https://open.feishu.cn/x').ok, true);
  assert.equal(assessEnvValue('').ok, false);
  assert.equal(assessEnvValue(undefined).ok, false);
});

// ── 异地目录扫描与时新性 ──

/** 建临时目录,写假 .db 并回拨 mtime(utimesSync 模拟老副本,扫描只 stat 不开库)。 */
function makeTempDirWithFiles(specs) {
  const dir = mkdtempSync(join(tmpdir(), 'envinv-test-'));
  const now = Date.now();
  for (const [name, ageMs] of specs) {
    const p = join(dir, name);
    writeFileSync(p, 'fake');
    if (ageMs !== undefined) {
      const t = new Date(now - ageMs);
      utimesSync(p, t, t);
    }
  }
  return dir;
}

test('scanDbs:只收 .db,按新→旧排序;目录不存在 → null(fail 信号)', () => {
  const dir = makeTempDirWithFiles([['old.db', 5 * DAY], ['new.db', DAY], ['note.txt']]);
  try {
    const entries = scanDbs(dir);
    assert.deepEqual(entries.map((e) => e.name), ['new.db', 'old.db']);
    assert.equal(entries[0].path, join(dir, 'new.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(scanDbs(join(tmpdir(), `envinv-missing-${Date.now()}`)), null);
});

test('scanDbs:目录存在但无 .db → 空数组,pickNewest 返回 null', () => {
  const dir = makeTempDirWithFiles([['readme.md']]);
  try {
    assert.deepEqual(scanDbs(dir), []);
    assert.equal(pickNewest(scanDbs(dir)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ageDays:2 天前 mtime → 2.0 天;与 48h 阈值联判(新鲜/超龄两态)', () => {
  const now = Date.now();
  assert.equal(ageDays(now - 2 * DAY, now), 2);
  // 端到端:新鲜副本(47.5h)过 48h 阈值,49h 超龄
  const dir = makeTempDirWithFiles([['fresh.db', 2 * DAY - 0.5 * HOUR]]);
  try {
    const fresh = pickNewest(scanDbs(dir));
    assert.equal(ageDays(fresh.mtimeMs, Date.now()) * DAY < 48 * HOUR, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(ageDays(now - 49 * HOUR, now) * DAY >= 48 * HOUR, true);
});

test('pickNewest:多条目选 mtime 最新者', () => {
  const newest = pickNewest([
    { name: 'a.db', mtimeMs: 100, path: '/x/a.db' },
    { name: 'c.db', mtimeMs: 300, path: '/x/c.db' },
  ]);
  assert.equal(newest.name, 'c.db');
});

// ── git 工作区判净 ──

test('isPorcelainClean:空输出与纯空白判净,有变更行判脏', () => {
  assert.equal(isPorcelainClean(''), true);
  assert.equal(isPorcelainClean('\n'), true);
  assert.equal(isPorcelainClean('?? docs/plans/acceptance-log.md\n'), false);
  assert.equal(isPorcelainClean(' M a.md\n?? b.md\n'), false);
});
