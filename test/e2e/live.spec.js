// Live tests against the real youtube.com. YouTube decides when to serve ads and when to
// hold content back, so these measure what happened instead of assuming an ad appears.
// The number that matters is "time to picture": how long after opening a video you see
// the video itself (main player playing, or Elide's shadow player live).
// Run: npm run test:live
import { test, expect } from './fixtures.js';

const VIDEOS = ['kJQP7kiw5Fk', 'fRh_vgS2dFE', 'dQw4w9WgXcQ', 'JGwWNGJdvx8', 'YQHsXMglC9A', 'OPf0YbXqDm0'];

// Declines YouTube's cookie consent up front (SOCS=CAI is the "reject all" choice), so the
// dialog never pauses playback mid-test.
async function declineConsent(context) {
  await context.addCookies([{ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/', secure: true, sameSite: 'Lax' }]);
}

// Watches the real player from the page.
async function instrument(page) {
  await page.addInitScript(() => {
    const log = (window.__live = { picture: null, ads: 0, adMs: 0, exposedMs: 0, shadowMs: 0, inAd: false });
    const t0 = performance.now();
    let lastT = -1;
    setInterval(() => {
      const mp = document.querySelector('#movie_player');
      const v = mp && mp.querySelector('video.html5-main-video, video');
      if (!v) return;
      const t = performance.now() - t0;
      const ad = mp.classList.contains('ad-showing');
      const curtain = Boolean(mp.querySelector('.elide-curtain:not([data-out])'));
      const shadow = Boolean(mp.querySelector('.elide-shadow[data-live]'));
      const moving = !ad && v.currentTime > 0.2 && v.currentTime !== lastT && !v.paused;
      lastT = v.currentTime;
      if (ad && !log.inAd) log.ads++;
      log.inAd = ad;
      if (ad) log.adMs += 50;
      if (ad && !curtain && !shadow) log.exposedMs += 50;
      if (shadow) log.shadowMs += 50;
      if (log.picture === null && (shadow || (moving && !curtain))) log.picture = Math.round(t);
    }, 50);
  });
}

async function watch(page, id, ms) {
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const mp = document.querySelector('#movie_player');
    const v = mp.querySelector('video');
    return {
      ...window.__live,
      end: { t: Math.round(v.currentTime * 10) / 10, paused: v.paused, muted: v.muted, rate: v.playbackRate, shadow: Boolean(mp.querySelector('.elide-shadow[data-live]')), ad: mp.classList.contains('ad-showing') },
      wall: Boolean(document.querySelector('ytd-enforcement-message-view-model'))
    };
  });
}

async function run(page, label, ms) {
  const rows = [];
  for (const id of VIDEOS) rows.push({ id, ...(await watch(page, id, ms)) });
  console.log(`\n== ${label}`);
  for (const r of rows) {
    console.log(`   ${r.id}  picture=${r.picture ?? 'never'}ms ads=${r.ads} adMs=${r.adMs} exposedMs=${r.exposedMs} shadowMs=${r.shadowMs} end=${JSON.stringify(r.end)}${r.wall ? ' WALL' : ''}`);
  }
  const pics = rows.map((r) => r.picture ?? ms).sort((a, b) => a - b);
  console.log(`   time to picture: median ${pics[pics.length >> 1]}ms, worst ${pics.at(-1)}ms`);
  return rows;
}

test.describe('youtube.com', () => {
  test.beforeEach(async ({ context, page }) => {
    await declineConsent(context);
    await instrument(page);
  });

  test('baseline: Elide switched off', async ({ page, elide }) => {
    await elide.set({ enabled: false }, '');
    await run(page, 'baseline (Elide off)', 25_000);
  });

  test('Elide default: no ad ever on screen, picture fast, main player back in charge', async ({ page, elide }) => {
    const rows = await run(page, 'Elide default (prevent off)', 32_000);
    console.log('   stats', JSON.stringify(await elide.stats()));
    for (const r of rows) {
      expect(r.exposedMs, `${r.id}: ad on screen`).toBe(0);
      expect(r.wall, `${r.id}: anti-adblock wall`).toBe(false);
      expect(r.picture, `${r.id}: never showed the video`).not.toBeNull();
      expect(r.picture, `${r.id}: time to picture`).toBeLessThan(9000);
    }
  });

  test('Elide with Prevent on: ad schedules stripped, holds covered by the shadow', async ({ page, elide }) => {
    await elide.set({ prevent: true }, 'yt-data:2');
    const rows = await run(page, 'Elide, prevent on', 32_000);
    console.log('   stats', JSON.stringify(await elide.stats()));
    for (const r of rows) {
      expect(r.exposedMs, `${r.id}: ad on screen`).toBe(0);
      expect(r.picture, `${r.id}: never showed the video`).not.toBeNull();
    }
  });
});
