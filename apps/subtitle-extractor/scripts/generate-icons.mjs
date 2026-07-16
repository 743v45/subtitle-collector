// 从 master SVG 生成多尺寸 PNG 图标（Chrome MV3 要求图标为 raster）。
// 主版 icon.svg → 48 / 128；加粗版 icon-small.svg → 16 / 32（小尺寸保清晰）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'icons');
if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });

const master = readFileSync(join(iconsDir, 'icon.svg'), 'utf8');
const small = readFileSync(join(iconsDir, 'icon-small.svg'), 'utf8');

const tasks = [
  { svg: small, size: 16, out: 'icon-16.png' },
  { svg: small, size: 32, out: 'icon-32.png' },
  { svg: master, size: 48, out: 'icon-48.png' },
  { svg: master, size: 128, out: 'icon-128.png' },
];

for (const t of tasks) {
  const resvg = new Resvg(t.svg, { fitTo: { mode: 'width', value: t.size } });
  const png = resvg.render().asPng();
  writeFileSync(join(iconsDir, t.out), png);
  console.log(`✓ generated ${t.out} (${t.size}x${t.size})`);
}
console.log('icons generated.');
