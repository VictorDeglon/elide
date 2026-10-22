// End-to-end tests against a stand-in YouTube player (see harness/player.js), served at
// https://www.youtube.com inside the test browser so the real extension runs unmodified.
// Ads are solid red and content is grayscale, so "you never see the ad" is checked on pixels.
import { test, expect, routeHarness, routeImaSite, watchForRed, events, extensionWithAllSites, VJS_PAGE, ms as within } from './fixtures.js';

const metric = (name, value) => console.log(`METRIC ${name} ${value}`);
const open = (page, query) => page.goto(`https://www.youtube.com/watch?v=elideHarnes&${query}`);
const first = (list, type) => list.find((e) => e.type === type);

test.beforeEach(async ({ context }) => {
  await routeHarness(context);
});

test('pre-roll: the ad is never on screen and runs out at 16x under the curtain', async ({ page, elide }) => {
  await open(page, 'mode=preroll&skip=5');
  const red = await watchForRed(page, 2500);
  const ev = await events(page);
  const adStart = first(ev, 'ad-start');
  const frame = first(ev, 'content-frame');

  expect(Math.max(...red), 'red (ad) pixels visible').toBeLessThan(0.01);
  expect(first(ev, 'ad-ended').by).toBe('end');
  expect(frame, 'content frame presented').toBeTruthy();
  const ms = frame.t - adStart.t;
  metric('preroll.ms', Math.round(ms));
  metric('preroll.speed', (15000 / ms).toFixed(1) + 'x');
  expect(ms).toBeLessThan(within(1800)); // 15 s at 16x is 0.94 s, plus media loads and the shadow warming up

  await expect.poll(() => elide.stats().then((s) => s && s.cut)).toBe(1);
  const stats = await elide.stats();
  expect(stats.adSeconds).toBeCloseTo(15, 0);
  expect(stats.last.method).toBe('rate');
  const v = await page.evaluate(() => ({ muted: document.querySelector('video').muted, rate: document.querySelector('video').playbackRate }));
  expect(v).toEqual({ muted: false, rate: 1 });
});

test('server-held content: the shadow player plays the video while YouTube holds it back', async ({ page, elide }) => {
  test.setTimeout(45_000);
  await open(page, 'mode=held&skip=-1');
  await page.waitForFunction(() => document.querySelector('.elide-shadow[data-live]'), null, { timeout: 5000 });
  const liveAt = await page.evaluate(() => performance.now());
  const red = await watchForRed(page, 3000);
  expect(Math.max(...red)).toBeLessThan(0.01);
  const ev = await events(page);
  metric('held.contentVisibleAfter', Math.round(liveAt - first(ev, 'ad-start').t) + 'ms');

  // The ad itself is long gone (16x), but the "server" only releases content at 15 s.
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-frame'), null, { timeout: 25_000 });
  await expect(page.locator('.elide-curtain')).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator('.elide-shadow')).toHaveCount(0);
  const t = await page.evaluate(() => document.querySelector('video').currentTime);
  metric('held.resumedAt', t.toFixed(1) + 's');
  expect(t).toBeGreaterThan(11); // picked up where the shadow got to, not at 0
  await expect.poll(() => elide.stats().then((s) => s && s.relayed)).toBe(1);
  const stats = await elide.stats();
  metric('held.blankMs', stats.last.blankMs);
  expect(stats.last.blankMs).toBeLessThan(within(3500));
  expect(await page.evaluate(() => document.querySelector('video').muted)).toBe(false);
});

test('startup stall without an ad: the shadow player covers it', async ({ page, elide }) => {
  test.setTimeout(45_000);
  await open(page, 'mode=stall&hold=9');
  await page.waitForFunction(() => document.querySelector('.elide-shadow[data-live]'), null, { timeout: 6000 });
  metric('stall.contentVisibleAfter', Math.round(await page.evaluate(() => performance.now())) + 'ms');
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-frame'), null, { timeout: 20_000 });
  await expect(page.locator('.elide-shadow')).toHaveCount(0, { timeout: 8000 });
  const t = await page.evaluate(() => document.querySelector('video').currentTime);
  metric('stall.resumedAt', t.toFixed(1) + 's');
  expect(t).toBeGreaterThan(4);
  await expect.poll(() => elide.stats().then((s) => s && s.last && s.last.reason)).toBe('stall');
});

test('mid-roll: freeze frame, resume at the break point, keep the user speed', async ({ page }) => {
  await open(page, 'mode=midroll&at=4');
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-start'));
  await page.evaluate(() => { document.querySelector('video').playbackRate = 1.5; });
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'break-start'), null, { timeout: 15_000 });

  const curtain = await page.evaluate(() => {
    const c = document.querySelector('.elide-curtain');
    return c && { frame: Boolean(c.querySelector('canvas')), tag: c.querySelector('.elide-tag')?.textContent };
  });
  expect(curtain, 'curtain raised').toBeTruthy();
  expect(curtain.frame, 'last content frame shown').toBe(true);

  const red = await watchForRed(page, 2000);
  expect(Math.max(...red)).toBeLessThan(0.01);

  const ev = await events(page);
  const brk = first(ev, 'break-start');
  const frame = ev.filter((e) => e.type === 'content-frame').at(-1);
  metric('midroll.ms', Math.round(frame.t - brk.t));
  expect(frame.time).toBeGreaterThanOrEqual(brk.resumeAt - 0.1); // resumed where it left off
  expect(frame.time).toBeLessThan(brk.resumeAt + 1.5);
  expect(await page.evaluate(() => document.querySelector('video').playbackRate)).toBe(1.5);
  await expect(page.locator('.elide-curtain')).toHaveCount(0);
});

test('pod of two ads: the curtain stays up across both, no flash in between', async ({ page, elide }) => {
  await open(page, 'mode=pod&skip=-1');
  const red = await watchForRed(page, 2500);
  const ev = await events(page);
  expect(Math.max(...red)).toBeLessThan(0.01);
  expect(ev.filter((e) => e.type === 'ad-ended')).toHaveLength(2);
  const ms = first(ev, 'content-frame').t - first(ev, 'ad-start').t;
  metric('pod.ms', Math.round(ms));
  metric('pod.speed', (23000 / ms).toFixed(1) + 'x');
  expect(ms).toBeLessThan(within(2600)); // 23 s of ads at 16x is 1.44 s, plus two media loads
  await expect.poll(() => elide.stats().then((s) => s && s.cut)).toBe(2);
});

test('skip button is used when the site offers one', async ({ page, elide }) => {
  await open(page, 'mode=preroll&skip=0');
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-frame'));
  expect(first(await events(page), 'ad-ended').by).toBe('skip');
  await expect.poll(() => elide.stats().then((s) => s && s.last && s.last.method)).toBe('skip');
});

test('a user who muted stays muted after the ad', async ({ page }) => {
  await open(page, 'mode=midroll&at=3');
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-start'));
  await page.evaluate(() => { document.querySelector('video').muted = true; });
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-frame' && e.time > 2), null, { timeout: 15_000 });
  expect(await page.evaluate(() => document.querySelector('video').muted)).toBe(true);
});

test('stitched ad: never seeks past the content, runs the ad stretch at 16x', async ({ page, elide }) => {
  await open(page, 'mode=stitched');
  const red = await watchForRed(page, 3000);
  const ev = await events(page);
  expect(Math.max(...red)).toBeLessThan(0.01);
  expect(first(ev, 'content-ended'), 'content was not skipped to its end').toBeFalsy();
  const frame = first(ev, 'content-frame');
  expect(frame.time).toBeGreaterThanOrEqual(15);
  expect(frame.time).toBeLessThan(20); // the stand-in only checks its ad flag every ~4 s of media at 16x
  const ms = frame.t - first(ev, 'ad-start').t;
  metric('stitched.ms', Math.round(ms));
  expect(ms).toBeLessThan(within(2500));
  const v = await page.evaluate(() => ({ rate: document.querySelector('video').playbackRate, t: document.querySelector('video').currentTime }));
  expect(v.rate).toBe(1);
  expect(v.t).toBeLessThan(30);
  await expect.poll(() => elide.stats().then((s) => s && s.last && s.last.method)).toBe('rate');
});

test('uncuttable ad: the shadow plays the content around it, then hands back', async ({ page, elide }) => {
  test.setTimeout(45_000);
  await open(page, 'mode=hard&skip=-1'); // the player pins the rate to 1x and reverts seeks
  await page.waitForFunction(() => document.querySelector('.elide-shadow[data-live]'), null, { timeout: 6000 });
  const liveAt = await page.evaluate(() => performance.now());
  const red = await watchForRed(page, 3000);
  expect(Math.max(...red)).toBeLessThan(0.01);

  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-frame'), null, { timeout: 25_000 });
  await expect(page.locator('.elide-curtain')).toHaveCount(0, { timeout: 6000 });
  const ev = await events(page);
  expect(first(ev, 'ad-ended').t - first(ev, 'ad-start').t).toBeGreaterThan(12_000); // it really ran its length
  expect(first(ev, 'ad-ended').t - liveAt).toBeGreaterThan(5000);
  // When the curtain lifts, the main player is where the shadow player got to, not at 0.
  const t = await page.evaluate(() => document.querySelector('video').currentTime);
  metric('hard.resumedAt', t.toFixed(1) + 's');
  expect(t).toBeGreaterThan(10);
  await expect(page.locator('.elide-shadow')).toHaveCount(0);
  await expect.poll(() => elide.stats().then((s) => s && s.relayed)).toBe(1);
});

test('off switch: the ad plays normally (proves the pixel check sees ads)', async ({ page, elide }) => {
  await elide.set({ enabled: false }, '');
  await open(page, 'mode=preroll&skip=-1');
  const red = await watchForRed(page, 2000);
  expect(Math.max(...red)).toBeGreaterThan(0.5);
  expect(first(await events(page), 'ad-ended')).toBeFalsy();
});

test('prevent: ad schedules are stripped from inline data, fetch and JSON.parse', async ({ page, elide }) => {
  await elide.set({ prevent: true }, 'yt-data:2');
  await open(page, 'mode=none');
  const r = await page.evaluate(async () => {
    const pr = window.ytInitialPlayerResponse;
    const fetched = await (await fetch('/youtubei/v1/player?key=x', { method: 'POST' })).json();
    const parsed = JSON.parse('{"responseContext":{},"videoDetails":{"videoId":"parsedVid01","lengthSeconds":"9"},"adPlacements":[{}],"adSlots":[{}]}');
    const wrapped = JSON.parse('{"playerResponse":{"playabilityStatus":{},"adPlacements":[{}]}}');
    return {
      inline: [pr.adPlacements, pr.playerAds, pr.adSlots, pr.auxiliaryUi.messageRenderers.enforcementMessageViewModel].every((x) => x === undefined),
      kept: pr.videoDetails.videoId,
      fetched: fetched.adPlacements === undefined && fetched.playerAds === undefined && fetched.videoDetails.videoId === 'fetchedVid1',
      parsed: parsed.adPlacements === undefined && parsed.adSlots === undefined,
      wrapped: wrapped.playerResponse.adPlacements === undefined,
      plain: JSON.parse('{"a":[1,2],"adPlacements":"untouched outside innertube"}').adPlacements,
      native: JSON.parse.toString().includes('[native code]') && Response.prototype.json.toString().includes('[native code]')
    };
  });
  expect(r).toEqual({ inline: true, kept: 'elideHarnes', fetched: true, parsed: true, wrapped: true, plain: 'untouched outside innertube', native: true });
  // 1 real placement + 1 ad slot inline (the forecasting placeholder is not counted).
  await expect.poll(() => elide.stats().then((s) => s && s.prevented)).toBeGreaterThanOrEqual(2);
});

test('prevent off (default): player data is read, never modified', async ({ page }) => {
  await open(page, 'mode=none');
  const r = await page.evaluate(() => ({
    placements: window.ytInitialPlayerResponse.adPlacements.length,
    enforcement: Boolean(window.ytInitialPlayerResponse.auxiliaryUi.messageRenderers.enforcementMessageViewModel)
  }));
  expect(r).toEqual({ placements: 2, enforcement: true });
});

test('scheduled mid-roll: the shadow is buffered at the break before it starts', async ({ page, elide }) => {
  test.setTimeout(45_000);
  await open(page, 'mode=midheld&at=6&skip=-1');
  // Warmed ahead of the break, while the content is still playing.
  await page.waitForFunction(() => document.querySelector('.elide-shadow') && window.__h.events.some((e) => e.type === 'content-frame'));
  expect(await page.evaluate(() => window.__h.events.some((e) => e.type === 'break-start'))).toBe(false);
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'break-start'), null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('.elide-shadow[data-live]'), null, { timeout: 4000, polling: 20 });
  const ev = await events(page);
  const liveAfter = (await page.evaluate(() => performance.now())) - first(ev, 'break-start').t;
  metric('midheld.contentVisibleAfter', Math.round(liveAfter) + 'ms');
  const red = await watchForRed(page, 2000);
  expect(Math.max(...red)).toBeLessThan(0.01);
  await page.waitForFunction(() => window.__h.events.filter((e) => e.type === 'content-frame').length > 1, null, { timeout: 25_000 });
  await expect(page.locator('.elide-shadow')).toHaveCount(0, { timeout: 8000 });
  const t = await page.evaluate(() => document.querySelector('video').currentTime);
  metric('midheld.resumedAt', t.toFixed(1) + 's');
  expect(t).toBeGreaterThan(6 + 11); // break at 6 s, ~15 s hold played in the shadow
  await expect.poll(() => elide.stats().then((s) => s && s.last && s.last.relayed)).toBe(true);
  const stats = await elide.stats();
  metric('midheld.blankMs', stats.last.blankMs);
  expect(stats.last.blankMs).toBeLessThan(within(1000));
});

test('clean feed: sponsored cards and companion ads are hidden, live toggle', async ({ page, elide }) => {
  await open(page, 'mode=none');
  await expect(page.locator('#card-ad')).toBeHidden();
  await expect(page.locator('#player-ads')).toBeHidden();
  await expect(page.locator('#card-normal')).toBeVisible();
  await elide.set({ cleanFeed: false });
  await expect(page.locator('#card-ad')).toBeVisible();
});

test('no ads: Elide stays out of the way', async ({ page }) => {
  await open(page, 'mode=none');
  await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-frame'));
  await page.evaluate(() => { document.querySelector('video').playbackRate = 1.25; });
  await page.waitForTimeout(1500);
  const v = await page.evaluate(() => ({ rate: document.querySelector('video').playbackRate, muted: document.querySelector('video').muted, t: document.querySelector('video').currentTime }));
  expect(v).toMatchObject({ rate: 1.25, muted: false });
  expect(v.t).toBeGreaterThan(1);
  await expect(page.locator('.elide-curtain')).toHaveCount(0);
});

test('Chromium refuses playback rates above 16x (why AdRush could never do 20x)', async ({ page }) => {
  await open(page, 'mode=none');
  const r = await page.evaluate(() => {
    const v = document.createElement('video');
    const out = {};
    for (const rate of [16, 17, 20]) {
      try { v.playbackRate = rate; out[rate] = v.playbackRate; } catch (e) { out[rate] = e.name; }
    }
    return out;
  });
  expect(r).toEqual({ 16: 16, 17: 'NotSupportedError', 20: 'NotSupportedError' });
});

test.describe('any site', () => {
  test.use({ extensionPath: extensionWithAllSites() });

  test('video.js-style player: the ad is ended by seeking, far past 20x', async ({ context, page, elide }) => {
    await routeImaSite(context);
    await elide.set({ site_any: true }, 'any-site:4,yt-data:1');
    await page.goto(VJS_PAGE);
    const red = await watchForRed(page, 1500, '#player');
    await page.waitForFunction(() => window.__h.events.some((e) => e.type === 'content-frame'));
    const ev = await events(page);
    const took = first(ev, 'content-frame').t - first(ev, 'ad-start').t;
    metric('seek.ms', Math.round(took));
    metric('seek.speed', (15000 / took).toFixed(0) + 'x');
    expect(Math.max(...red)).toBeLessThan(0.01);
    expect(took).toBeLessThan(within(750)); // 15 s ad: under 0.75 s is better than 20x
    await expect.poll(() => elide.stats().then((s) => s && s.last && s.last.method)).toBe('seek');
  });
});
