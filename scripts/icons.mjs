// Renders the toolbar/store icons from the logo geometry with Chromium.
// on-*: black tile, white mark. off-*: gray tile (Elide disabled).
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../extension/icons/', import.meta.url));
const svg = (size, tile, mark) => {
  const gap = size <= 32 ? 14 : 11; // wider cut so it survives at toolbar size
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
    <mask id="m"><rect width="128" height="128" fill="#fff"/>
      <rect x="${64 - gap / 2 - 0.5}" y="6" width="${gap}" height="116" fill="#000" transform="rotate(20 64 64)"/></mask>
    <rect width="128" height="128" rx="28" fill="${tile}"/>
    <path d="M41 29 L99 64 L41 99 Z" fill="${mark}" mask="url(#m)"/></svg>`;
};

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
for (const [state, tile, mark] of [['on', '#000', '#fff'], ['off', '#9a9a9a', '#fff']]) {
  for (const size of state === 'on' ? [16, 32, 48, 128] : [16, 32]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(size, tile, mark)}`);
    await page.screenshot({ path: `${out}${state}-${size}.png`, omitBackground: true });
  }
}
await browser.close();
console.log('icons written to', out);
