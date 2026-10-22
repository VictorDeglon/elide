// Network tests: a publisher page running Google's real IMA SDK, requesting Google's public
// sample ad tag. Needs internet. Run: npx playwright test --project=network
import { test, expect, extensionWithAllSites, routeImaSite, IMA_PAGE, ms as within } from './fixtures.js';

const metric = (name, value) => console.log(`METRIC ${name} ${value}`);
const ALL = extensionWithAllSites(); // "Any site" switched on and its permission granted

test.use({ extensionPath: ALL });

test.beforeEach(async ({ context }) => {
  await routeImaSite(context);
});

test('any site: a real IMA ad is cut by seeking to its end', async ({ page, elide }) => {
  await elide.set({ site_any: true, shield: false }, 'any-site:4,yt-data:1');
  await page.addInitScript(() => {
    // Record whether the curtain covered the ad while IMA's ad <video> was showing.
    window.__cover = { adFrames: 0, covered: 0 };
    setInterval(() => {
      const ad = document.querySelector('video[title="Advertisement"]');
      if (!ad || !ad.currentSrc || ad.ended || !ad.getClientRects().length) return;
      window.__cover.adFrames++;
      if (document.querySelector('.elide-curtain:not([data-out])')) window.__cover.covered++;
    }, 10);
  });
  await page.goto(IMA_PAGE);
  await page.waitForFunction(() => window.__h.events.some((e) => /ad-start|ad-error|no-ima/.test(e.type)), null, { timeout: 30_000 });
  const ev = await page.evaluate(() => window.__h.events);
  const start = ev.find((e) => e.type === 'ad-start');
  test.skip(!start, 'IMA served no ad from this network: ' + JSON.stringify(ev.at(-1)));

  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-resume'), null, { timeout: 30_000 });
  const done = await page.evaluate(() => window.__h.events);
  const resume = done.find((e) => e.type === 'content-resume');
  const ms = resume.t - start.t;
  metric('ima.adSeconds', start.duration);
  metric('ima.ms', Math.round(ms));
  metric('ima.speed', (start.duration * 1000 / ms).toFixed(0) + 'x');
  expect(ms).toBeLessThan(within(1500));
  expect(start.duration).toBeGreaterThan(5);
  const cover = await page.evaluate(() => window.__cover);
  expect(cover.covered, 'curtain over the ad').toBe(cover.adFrames);
  await expect.poll(() => elide.stats().then((s) => s && s.last && s.last.method)).toBe('seek');
});

test('shield: the ad request never leaves the browser, content plays at once', async ({ page }) => {
  await page.goto(IMA_PAGE);
  await page.waitForFunction(() => window.__h.events.some((e) => /ad-start|ad-error|no-ima/.test(e.type)), null, { timeout: 30_000 });
  const ev = await page.evaluate(() => window.__h.events);
  expect(ev.find((e) => e.type === 'ad-start')).toBeFalsy();
  expect(ev.some((e) => e.type === 'ad-error')).toBe(true);
  await page.waitForFunction(() => document.getElementById('content').currentTime > 0.5);
});
