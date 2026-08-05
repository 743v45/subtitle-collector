#!/usr/bin/env node
// 采 YouTube 视频字幕(英文 + 中文翻译)。stdin 读 videoId 列表(youtube-collect-videos.mjs 产出)。
// 走 yt-dlp(android_vr/ios client 绕部分限制;本 IP 被 bot 限流时需 --cookies 或换 IP)。
// 用法: node scripts/youtube-collect-videos.mjs | node scripts/youtube-collect-subs.mjs [输出目录] [--cookies 文件]
//   额外参数透传 yt-dlp(如 --cookies-from-browser chrome,但 mac 非交互 keychain 解密会失败 → 用 cookies.txt)
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = process.argv[2] || 'youtube-subs';
const SLEEP_MS = 1200; // 每视频间隔(防风控)
const EXTRA = process.argv.slice(3); // 透传 yt-dlp(如 --cookies /path/cookies.txt)
const LANGS = 'en,zh-Hans';

mkdirSync(OUT_DIR, { recursive: true });
const lines = require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean);
const videoIds = [...new Set(lines.map((l) => l.split('\t')[0]).filter((v) => /^[A-Za-z0-9_-]{11}$/.test(v)))];
process.stderr.write(`采字幕(yt-dlp): ${videoIds.length} 视频 → ${OUT_DIR}/  透传: ${EXTRA.join(' ') || '(无)'}\n`);

const manifest = join(OUT_DIR, 'manifest.tsv');
let ok = 0, fail = 0;
for (const vid of videoIds) {
  // 已有英文字幕则跳过(断点续跑)
  const enSrt = join(OUT_DIR, `${vid}.en.srt`);
  if (existsSync(enSrt)) { process.stderr.write(`[${vid}] 跳过(已有)\n`); ok++; continue; }
  const args = [
    '--extractor-args', 'youtube:player_client=android_vr',
    '--write-auto-subs', '--sub-langs', LANGS, '--sub-format', 'srt',
    '--skip-download', '--no-check-formats', '--no-warnings',
    '-o', `${OUT_DIR}/${vid}.%(ext)s`,
    `https://www.youtube.com/watch?v=${vid}`,
    ...EXTRA,
  ];
  const r = spawnSync('yt-dlp', args, { encoding: 'utf8', timeout: 90000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const gotEn = existsSync(join(OUT_DIR, `${vid}.en.srt`));
  const gotZh = existsSync(join(OUT_DIR, `${vid}.zh-Hans.srt`));
  if (gotEn || gotZh) {
    ok++;
    appendFileSync(manifest, [vid, gotEn ? '✓' : '', gotZh ? '✓' : ''].join('\t') + '\n');
    process.stderr.write(`[${vid}] en:${gotEn ? '✓' : '✗'} zh:${gotZh ? '✓' : '✗'}\n`);
  } else {
    fail++;
    const errLine = out.split('\n').find((l) => /ERROR|Sign in|429/i.test(l)) || '未知错误';
    appendFileSync(manifest, [vid, 'FAIL', 'FAIL'].join('\t') + '\n');
    process.stderr.write(`[${vid}] 失败: ${errLine.trim().slice(0, 100)}\n`);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLEEP_MS); // 同步 sleep
}
process.stderr.write(`\n完成: 成功 ${ok} / 失败 ${fail} → ${manifest}\n`);
process.stderr.write(fail > 0 ? `⚠️ 失败视频多因 YouTube bot 限流。换网络(热点新 IP)或导出 cookies.txt(浏览器扩展)后重跑:\n  node scripts/youtube-collect-videos.mjs | node scripts/youtube-collect-subs.mjs youtube-subs --cookies /path/to/cookies.txt\n` : '');
