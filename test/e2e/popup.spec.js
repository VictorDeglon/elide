// The popup: settings round-trip through storage, the service worker follows them, and the
// status line reports a real break from a real tab. DOCS=1 also saves README screenshots.
import { test, expect, routeHarness, ROOT } from './fixtures.js';
import path from 'node:path';

const popupUrl = (elide, query = '') => `chrome-extension://${elide.id}/popup/popup.html${query}`;
const setting = (elide, key) => elide.sw.evaluate((k) => chrome.storage.local.get(k).then((s) => s[k]), key);

test('toggles write settings and the service worker follows them', async ({ page, elide }) => {
  await page.goto(popupUrl(elide));
  await expect(page.locator('input[data-key="relay"]')).toBeChecked();
  await expect(page.locator('input[data-key="prevent"]')).not.toBeChecked();

  await page.locator('label.row', { hasText: 'Prevent' }).click();
  await expect.poll(() => setting(elide, 'prevent')).toBe(true);
  await elide.ready('yt-data:2'); // strip mode registered

  await page.locator('input[data-key="enabled"]').click({ force: true });
  await expect.poll(() => setting(elide, 'enabled')).toBe(false);
  await elide.ready(''); // nothing injected while off
  await expect(page.locator('body')).toHaveClass(/off/);
});

test('reports the last break on the tab, with lifetime stats', async ({ context, page, elide }) => {
  await routeHarness(context);
  const video = await context.newPage();
  await video.goto('https://www.youtube.com/watch?v=elideHarnes&mode=held&skip=-1');
  await expect.poll(() => elide.stats().then((s) => s && s.relayed), { timeout: 30_000 }).toBe(1);
  const tabId = await elide.sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);

  await page.setViewportSize({ width: 340, height: 720 });
  await page.goto(popupUrl(elide, `?tab=${tabId}`));
  await expect(page.locator('#tab-site')).toHaveText('YouTube');
  await expect(page.locator('#tab-state')).toHaveText('watching');
  await expect(page.locator('#tab-last')).toContainText('shadow player');
  await expect(page.locator('#st-relayed')).toHaveText('1');

  if (process.env.DOCS) {
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: path.join(ROOT, `assets/popup-${scheme}.png`), fullPage: true, animations: 'disabled' });
    }
  }
});
