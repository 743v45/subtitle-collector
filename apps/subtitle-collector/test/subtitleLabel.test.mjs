// test/subtitleLabel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAiSubtitle, subtitleTrackLabel, trackTypeBadge } from '../subtitleLabel.mjs';

test('subtitleTrackLabel：lan_doc 优先于 lan', () => {
  assert.equal(
    subtitleTrackLabel({ lan: 'zh-Hans', lan_doc: '中文（简体）' }),
    '中文（简体）',
  );
});

test('subtitleTrackLabel：无 lan_doc 回退 lan', () => {
  assert.equal(subtitleTrackLabel({ lan: 'en' }), 'en');
});

test('subtitleTrackLabel：lan/lan_doc 均缺 → 未知', () => {
  assert.equal(subtitleTrackLabel({}), '未知');
  assert.equal(subtitleTrackLabel(null), '未知');
  assert.equal(subtitleTrackLabel(undefined), '未知');
});

// 回归 BUG-2：AI 字幕的语言名不得被抹成 "AI"。
// 旧 Popup.tsx 逻辑 `isAi ? 'AI' : (lan_doc ?? lan ?? '未知')` 会把下面三条
// 全返回 "AI"，中/英/日 AI 字幕在 popup 列表里无法区分。
test('回归 BUG-2：AI 字幕保留各自语言名，不再统一显示 "AI"', () => {
  const aiZh = { lan: 'zh-Hans', lan_doc: '中文（简体）', subtitle_url: 'https://aisubtitle.hdslb.com/a.json' };
  const aiEn = { lan: 'en', lan_doc: 'English', subtitle_url: 'https://aisubtitle.hdslb.com/b.json' };
  const aiJa = { lan: 'ja', lan_doc: '日本語', subtitle_url: 'https://aisubtitle.hdslb.com/c.json' };
  assert.equal(isAiSubtitle(aiZh), true);
  assert.equal(isAiSubtitle(aiEn), true);
  assert.equal(isAiSubtitle(aiJa), true);
  assert.equal(subtitleTrackLabel(aiZh), '中文（简体）');
  assert.equal(subtitleTrackLabel(aiEn), 'English');
  assert.equal(subtitleTrackLabel(aiJa), '日本語');
});

test('isAiSubtitle：人工字幕（url 不含 aisubtitle）→ false', () => {
  const human = {
    lan: 'zh-Hans',
    lan_doc: '中文（简体）',
    subtitle_url: 'https://i0.hdslb.com/bfs/subtitle/xxx.json',
  };
  assert.equal(isAiSubtitle(human), false);
});

test('isAiSubtitle：url 缺失 / 非串 → false（安全兜底）', () => {
  assert.equal(isAiSubtitle({}), false);
  assert.equal(isAiSubtitle({ subtitle_url: undefined }), false);
  assert.equal(isAiSubtitle(null), false);
});

// 回归 2026-08-22③：YouTube tlang 翻译轨落库 track_type=3（机翻/翻译轨）后，
// popup 需有对应的类型徽标文案（此前 3 无任何展示语义，机翻轨与人工 CC 在 UI 不可区分）。
test('trackTypeBadge：track_type=3（机翻/翻译轨）→ 「机翻」', () => {
  assert.equal(trackTypeBadge(3), '机翻');
  assert.equal(trackTypeBadge('3'), '机翻'); // popup types 里 track_type 声明为 string | null，兼容字符串
});

test('trackTypeBadge：1/2/缺失/非数值 → null（无徽标，不与 AI 徽标重复）', () => {
  assert.equal(trackTypeBadge(1), null, 'AI/asr 轨走 isAiSubtitle 徽标（B 站）或轨名自带（自动生成）后缀');
  assert.equal(trackTypeBadge(2), null, '人工 CC 无徽标');
  assert.equal(trackTypeBadge(null), null);
  assert.equal(trackTypeBadge(undefined), null);
  assert.equal(trackTypeBadge('not-a-number'), null);
});
