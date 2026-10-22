// Fast checks that need no browser: the package is consistent, and the YouTube data
// script reads and strips exactly what it should. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXT = path.join(ROOT, 'extension');
const read = (p) => fs.readFileSync(path.join(EXT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

function loadDefaults() {
  const ctx = {};
  vm.runInNewContext(read('shared/defaults.js'), ctx);
  return ctx;
}

test('every file the manifest, service worker and popup reference exists', () => {
  const files = new Set([manifest.background.service_worker, manifest.action.default_popup]);
  for (const cs of manifest.content_scripts) for (const f of [...cs.js, ...(cs.css || [])]) files.add(f);
  for (const icon of Object.values({ ...manifest.icons, ...manifest.action.default_icon })) files.add(icon);
  for (const r of manifest.declarative_net_request.rule_resources) files.add(r.path);
  // Dynamically registered scripts and icons named in background.js.
  for (const m of read('background.js').matchAll(/'((?:page|content|shared)\/[\w/.-]+\.(?:js|css))'/g)) files.add(m[1]);
  for (const site of ['generic', 'hulu']) files.add(`content/sites/${site}.js`);
  for (const state of ['on', 'off']) for (const size of [16, 32]) files.add(`icons/${state}-${size}.png`);
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), `missing ${f}`);
});

test('versions agree: manifest, package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
});

test('permissions stay minimal', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['declarativeNetRequest', 'scripting', 'storage']);
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
});

test('popup toggles map to real settings', () => {
  const { ELIDE_DEFAULTS } = loadDefaults();
  const keys = [...read('popup/popup.html').matchAll(/data-key="(\w+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 10);
  for (const k of keys) assert.ok(k in ELIDE_DEFAULTS, `popup toggle ${k} has no default`);
});

test('network shield is a valid ruleset that spares the sites Elide handles in-page', () => {
  const rules = JSON.parse(read('rules/shield.json'));
  assert.equal(rules.length, 1);
  const { condition, action } = rules[0];
  assert.equal(action.type, 'block');
  assert.ok(condition.requestDomains.includes('doubleclick.net'));
  for (const d of ['youtube.com', 'twitch.tv']) assert.ok(condition.excludedInitiatorDomains.includes(d));
  assert.ok(!condition.resourceTypes.includes('main_frame'));
});

// Runs page/youtube-data.js in a sandbox shaped like a page's MAIN world.
function page({ strip, search = '' }) {
  const events = [];
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }
  class Response {
    constructor(body) {
      this.body = body;
    }
    json() {
      return Promise.resolve(JSON.parse(this.body));
    }
  }
  const window = {
    location: { search },
    document: { addEventListener() {}, dispatchEvent: (e) => events.push(JSON.parse(e.detail)) },
    CustomEvent,
    Response,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Symbol, Object, Proxy, Reflect, Map, Set, Array, Number, Boolean, String, Math
  };
  window.window = window;
  const ctx = vm.createContext(window);
  if (strip) vm.runInContext(read('page/strip.js'), ctx);
  vm.runInContext(read('page/youtube-data.js'), ctx);
  return { ctx, events };
}

const response = () => ({
  responseContext: {},
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '213' },
  adPlacements: [
    { adPlacementRenderer: { renderer: { clientForecastingAdRenderer: {} } } },
    { adPlacementRenderer: { config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START' } }, renderer: { adBreakServiceRenderer: {} } } },
    { adPlacementRenderer: { config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_MILLISECONDS', adTimeOffset: { offsetStartMilliseconds: '95000' } } }, renderer: { adBreakServiceRenderer: {} } } }
  ],
  playerAds: [{}],
  adSlots: [{}],
  adBreakHeartbeatParams: 'x',
  auxiliaryUi: { messageRenderers: { enforcementMessageViewModel: {} } }
});

test('read mode (default): leaves player data intact, reports length and mid-roll times', () => {
  const { ctx, events } = page({ strip: false });
  ctx.ytInitialPlayerResponse = response();
  const pr = ctx.ytInitialPlayerResponse;
  assert.equal(pr.adPlacements.length, 3);
  assert.ok(pr.auxiliaryUi.messageRenderers.enforcementMessageViewModel);
  assert.deepEqual(events.at(-1), { videoId: 'abcdefghijk', length: 213, live: false, prevented: 0, breaks: [95] });
});

test('strip mode: removes every ad key and the anti-adblock dialog, keeps the rest', async () => {
  const { ctx, events } = page({ strip: true });
  ctx.ytInitialPlayerResponse = response();
  const pr = ctx.ytInitialPlayerResponse;
  for (const k of ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams']) assert.equal(pr[k], undefined, k);
  assert.equal(pr.auxiliaryUi.messageRenderers.enforcementMessageViewModel, undefined);
  assert.equal(pr.videoDetails.videoId, 'abcdefghijk');
  // 2 real placements (the forecasting placeholder does not count) + 1 ad slot.
  assert.equal(events.at(-1).prevented, 3);

  const parsed = ctx.JSON.parse(JSON.stringify({ playerResponse: response() }));
  assert.equal(parsed.playerResponse.adPlacements, undefined);
  const fetched = await new ctx.Response(JSON.stringify(response())).json();
  assert.equal(fetched.adSlots, undefined);
  const unrelated = ctx.JSON.parse('{"adPlacements":[1]}');
  assert.deepEqual(unrelated.adPlacements, [1], 'objects that are not innertube responses are untouched');
});

test('the shadow player frame is left untouched', () => {
  const { ctx, events } = page({ strip: true, search: '?autoplay=1&elide_relay=1' });
  ctx.ytInitialPlayerResponse = response();
  assert.equal(ctx.ytInitialPlayerResponse.adPlacements.length, 3);
  assert.equal(events.length, 0);
});
