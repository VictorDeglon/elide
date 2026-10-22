// Renders the README banners (dark and light) from the logo geometry with Chromium.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../assets/', import.meta.url));
const mark = (fg) => `<svg viewBox="0 0 128 128" width="158" height="158" aria-hidden="true">
  <mask id="m"><rect width="128" height="128" fill="#fff"/><rect x="58" y="6" width="11" height="116" fill="#000" transform="rotate(20 64 64)"/></mask>
  <path d="M30 18 L110 64 L30 110 Z" fill="${fg}" mask="url(#m)"/></svg>`;

const html = (bg, fg, dim) => `<!doctype html><html><head><style>
  html, body { margin: 0; width: 1280px; height: 400px; background: ${bg}; }
  body { display: flex; align-items: center; justify-content: center; gap: 34px;
         font-family: -apple-system, "SF Pro Display", "Inter", "Helvetica Neue", sans-serif; color: ${fg}; }
  .word { font-size: 168px; font-weight: 650; letter-spacing: -0.055em; line-height: 1; margin-top: -18px; }
  .tag { position: absolute; left: 0; right: 0; bottom: 46px; text-align: center;
         font: 500 15px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.32em; text-transform: uppercase; color: ${dim}; }
</style></head><body>${mark(fg)}<div class="word">elide</div><div class="tag">ads, elided · video, uninterrupted</div></body></html>`;

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
for (const [name, bg, fg, dim] of [['banner-dark', '#000', '#fff', '#7a7a7a'], ['banner-light', '#fff', '#000', '#8a8a8a']]) {
  await page.setContent(html(bg, fg, dim));
  await page.screenshot({ path: `${out}${name}.png` });
}
await browser.close();
console.log('banners written to', out);
