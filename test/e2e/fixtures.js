import { test as base, expect, chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
export const ROOT = path.resolve(HERE, '../..');
export const EXTENSION = path.join(ROOT, 'extension');
const HARNESS = path.join(HERE, 'harness');
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// A copy of the extension that is also granted <all_urls>, standing in for a user who
// switched on "Any site" and accepted Chrome's permission prompt.
export function extensionWithAllSites() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elide-ext-'));
  fs.cpSync(EXTENSION, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('<all_urls>');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

class Elide {
  constructor(sw) {
    this.sw = sw;
    this.id = new URL(sw.url()).host;
  }

  // "id:scriptCount" per registration, e.g. "yt-data:1" (read) or "yt-data:2" (strip).
  registered() {
    return this.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => `${s.id}:${s.js.length}`).sort().join(','));
  }

  async ready(ids = 'yt-data:1') {
    await expect.poll(() => this.registered(), { timeout: 10_000 }).toBe(ids);
  }

  // Applies settings and waits until the service worker has re-registered scripts.
  async set(patch, ids) {
    await this.sw.evaluate((p) => chrome.storage.local.set(p), patch);
    if (ids !== undefined) await this.ready(ids);
  }

  async stats() {
    return this.sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats || null);
  }
}

export const test = base.extend({
  extensionPath: [EXTENSION, { option: true }],
  context: async ({ extensionPath }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: { width: 1280, height: 800 },
      userAgent: UA,
      locale: 'en-US',
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
        // A silent virtual audio clock: Chromium paces playback off the audio output, and
        // macOS stalls that output while the display sleeps, which freezes unmuted video.
        '--disable-audio-output'
      ]
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },
  elide: async ({ sw }, use) => {
    const elide = new Elide(sw);
    await elide.ready();
    await use(elide);
  }
});

export { expect };

// Serves the fake YouTube from https://www.youtube.com/* inside the test browser,
// with byte-range support so <video> can seek like it does against a real CDN.
export async function routeHarness(context) {
  await context.route(/^https:\/\/(www|m)\.youtube(-nocookie)?\.com\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/watch') return route.fulfill({ path: path.join(HARNESS, 'watch.html'), contentType: 'text/html' });
    if (url.pathname === '/robots.txt') return route.fulfill({ body: 'User-agent: *\n', contentType: 'text/plain' });
    if (url.pathname.startsWith('/embed/')) return route.fulfill({ path: path.join(HARNESS, 'embed.html'), contentType: 'text/html' });
    if (url.pathname.startsWith('/youtubei/v1/player')) {
      return route.fulfill({
        json: { responseContext: {}, videoDetails: { videoId: 'fetchedVid1', lengthSeconds: '42' }, adPlacements: [{ adPlacementRenderer: { renderer: { linearAdSequenceRenderer: {} } } }], playerAds: [{}] }
      });
    }
    if (url.pathname.startsWith('/elide-harness/')) {
      // ?release=<epoch ms> holds the response back, like YouTube's server withholding
      // content until an ad's real length has passed.
      const release = Number(url.searchParams.get('release') || 0);
      if (release > Date.now()) await new Promise((r) => setTimeout(r, release - Date.now()));
      return serve(route, path.join(HARNESS, url.pathname.slice('/elide-harness/'.length)));
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await context.route(/ytimg\.com/, (route) => route.abort());
}

// A publisher site at https://video-site.test running Google's real IMA SDK.
export const IMA_PAGE = 'https://video-site.test/ima.html';
export const VJS_PAGE = 'https://video-site.test/vjs.html';
// CI runners are slower than a laptop; timing bounds scale by TIME_SCALE (default 1).
export const ms = (n) => n * Number(process.env.TIME_SCALE || 1);
export async function routeImaSite(context) {
  await context.route(/^https:\/\/video-site\.test\//, (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/ima.html' || p === '/vjs.html') return serve(route, path.join(HARNESS, p.slice(1)));
    if (p.startsWith('/media/')) return serve(route, path.join(HARNESS, p.slice(1)));
    return route.fulfill({ status: 404, body: '' });
  });
}

// Fulfills a request from disk, honouring Range so <video> can seek like against a CDN.
function serve(route, file) {
  const body = fs.readFileSync(file);
  const type = file.endsWith('.webm') ? 'video/webm' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] || '');
  if (!range) return route.fulfill({ status: 200, body, contentType: type, headers: { 'accept-ranges': 'bytes' } });
  const start = Number(range[1]);
  const end = range[2] ? Number(range[2]) : body.length - 1;
  return route.fulfill({
    status: 206,
    body: body.subarray(start, end + 1),
    contentType: type,
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }
  });
}

// Share of the element's pixels that are "ad red" in a fresh screenshot.
export async function redShare(page, box) {
  const png = PNG.sync.read(await page.screenshot({ clip: box }));
  let red = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] > 170 && png.data[i + 1] < 80 && png.data[i + 2] < 80) red++;
  }
  return red / (png.width * png.height);
}

// Screenshots the player back-to-back for `ms` and returns every red share seen.
export async function watchForRed(page, ms, selector = '#movie_player') {
  const box = await page.locator(selector).boundingBox();
  const seen = [];
  const end = Date.now() + ms;
  while (Date.now() < end) seen.push(await redShare(page, box));
  return seen;
}

export const events = (page) => page.evaluate(() => window.__h.events);
