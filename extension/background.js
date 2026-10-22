// Elide · service worker. Owns three things:
//   1. which MAIN-world / optional-site scripts are registered (they follow the settings)
//   2. the network shield ruleset
//   3. the lifetime stats (single writer, so tabs never race each other)
importScripts('shared/defaults.js');

const DEFAULTS = globalThis.ELIDE_DEFAULTS;
const EMPTY = globalThis.ELIDE_EMPTY_STATS;
const YOUTUBE = ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'];
const TWITCH = ['*://*.twitch.tv/*'];
const ALL_SITES = ['<all_urls>'];
const HULU = ['*://*.hulu.com/*'];

let queue = Promise.resolve();
function serial(task) {
  queue = queue.then(task).catch((e) => console.warn('[elide]', e));
  return queue;
}

const bundle = (site) => ['shared/defaults.js', 'content/engine.js', `content/sites/${site}.js`, 'content/boot.js'];

async function wantedScripts(s) {
  const want = [];
  if (!s.enabled) return want;
  if (s.site_youtube) {
    const js = s.prevent ? ['page/strip.js', 'page/youtube-data.js'] : ['page/youtube-data.js'];
    want.push({ id: 'yt-data', matches: YOUTUBE, js, runAt: 'document_start', allFrames: true, world: 'MAIN' });
  }
  if (s.site_any && (await chrome.permissions.contains({ origins: ALL_SITES }))) {
    want.push({
      id: 'any-site', matches: ALL_SITES, excludeMatches: [...YOUTUBE, ...TWITCH, ...HULU],
      js: bundle('generic'), css: ['content/elide.css'], runAt: 'document_start', allFrames: true
    });
  }
  if (s.site_hulu && (await chrome.permissions.contains({ origins: HULU }))) {
    want.push({ id: 'hulu', matches: HULU, js: bundle('hulu'), css: ['content/elide.css'], runAt: 'document_start', allFrames: false });
  }
  return want;
}

async function sync() {
  const s = await chrome.storage.local.get(DEFAULTS);

  const want = await wantedScripts(s);
  const have = await chrome.scripting.getRegisteredContentScripts();
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((x) => x.id) });
  if (want.length) await chrome.scripting.registerContentScripts(want);

  const shieldOn = s.enabled && s.shield;
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    shieldOn ? { enableRulesetIds: ['shield'] } : { disableRulesetIds: ['shield'] }
  );

  const state = s.enabled ? 'on' : 'off';
  await chrome.action.setIcon({ path: { 16: `icons/${state}-16.png`, 32: `icons/${state}-32.png` } });
  await chrome.action.setTitle({ title: s.enabled ? 'Elide' : 'Elide (off)' });
}

async function bumpStats(apply) {
  const { stats } = await chrome.storage.local.get({ stats: EMPTY });
  const next = { ...EMPTY, ...stats };
  apply(next);
  await chrome.storage.local.set({ stats: next });
}

chrome.runtime.onInstalled.addListener(() => serial(async () => {
  const current = await chrome.storage.local.get(DEFAULTS); // keeps saved values, fills new keys
  await chrome.storage.local.set(current);
  await sync();
}));

chrome.runtime.onStartup.addListener(() => serial(sync));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k in DEFAULTS)) serial(sync);
});

chrome.permissions.onRemoved.addListener(({ origins = [] }) => serial(async () => {
  if (origins.includes('<all_urls>')) await chrome.storage.local.set({ site_any: false, site_hulu: false });
  else if (origins.some((o) => o.includes('hulu.com'))) await chrome.storage.local.set({ site_hulu: false });
}));

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'elide:break') {
    serial(() => bumpStats((st) => {
      st.cut += msg.cut || 0;
      st.adSeconds += msg.adSeconds || 0;
      st.blankMs += msg.blankMs || 0;
      st.relayed += msg.relayed ? 1 : 0;
      st.breaks += 1;
      st.last = msg.last || st.last;
    }));
  } else if (msg.type === 'elide:prevented') {
    serial(() => bumpStats((st) => { st.prevented += msg.n || 0; }));
  } else if (msg.type === 'elide:sync') {
    serial(sync);
  }
});
