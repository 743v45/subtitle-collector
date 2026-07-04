// 万级数字格式化：zh-CN compact 自动产出 "1.2万 / 3.4亿"，对齐原 popup.js fmtNum 行为。
const compact = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '-';
  return compact.format(Number(n));
}
