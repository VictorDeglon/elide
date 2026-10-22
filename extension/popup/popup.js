// Elide · popup. Settings live in chrome.storage.local; the service worker reacts to them.
const DEFAULTS = globalThis.ELIDE_DEFAULTS;
const EMPTY = globalThis.ELIDE_EMPTY_STATS;
const $ = (id) => document.getElementById(id);
const toggles = [...document.querySelectorAll('input[data-key]')];

const count = (n) => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n));
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
const span = (s) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

function paintSettings(s) {
  for (const input of toggles) input.checked = Boolean(s[input.dataset.key]);
  document.body.classList.toggle('off', !s.enabled);
}

function paintStats(st) {
  st = { ...EMPTY, ...st };
  $('st-cut').textContent = count(st.cut);
  $('st-relayed').textContent = count(st.relayed);
  $('st-prevented').textContent = count(st.prevented);
  $('st-blank').textContent = st.breaks
    ? `${span(st.adSeconds)} of ads handled · ${secs(st.blankMs / st.breaks)} average without picture`
    : 'Nothing to report yet.';
}

function describe(last) {
  if (!last) return '';
  const what = last.reason === 'stall' ? 'Held back by the site' : last.adSeconds ? `${last.adSeconds}s ad` : 'Ad';
  const how = { skip: 'skip button', seek: 'seeked to end', rate: '16×', relay: 'played around', curtain: 'covered', 'next-short': 'next short' }[last.method] || last.method;
  return `Last: ${what} · ${how} · picture back in ${secs(last.blankMs)}${last.relayed ? ' · shadow player' : ''}`;
}

// popup.html?tab=<id> reports on that tab instead of the active one (tests, screenshots).
const pinnedTab = Number(new URLSearchParams(location.search).get('tab')) || null;
const currentTab = async () => (pinnedTab ? { id: pinnedTab } : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);

async function paintTab() {
  const tab = await currentTab();
  let status = null;
  if (tab && tab.id !== undefined) {
    status = await chrome.tabs.sendMessage(tab.id, { type: 'elide:status' }, { frameId: 0 }).catch(() => null);
  }
  if (!status) {
    $('tab-site').textContent = 'Not active on this page';
    $('tab-state').textContent = '';
    $('tab-last').textContent = '';
    return;
  }
  $('tab-site').textContent = status.site;
  $('tab-state').textContent = !status.active ? 'off' : !status.player ? 'no player' : status.state === 'idle' ? 'watching' : 'working';
  $('tab-last').textContent = describe(status.last);
}

toggles.forEach((input) => {
  input.addEventListener('change', () => {
    const key = input.dataset.key;
    const origins = input.dataset.origins;
    if (origins && input.checked) {
      // Must be requested synchronously inside the click handler.
      chrome.permissions.request({ origins: [origins] }).then((granted) => {
        if (!granted) input.checked = false;
        chrome.storage.local.set({ [key]: granted });
      });
      return;
    }
    chrome.storage.local.set({ [key]: input.checked });
  });
});

$('restore').addEventListener('click', async () => {
  const tab = await currentTab();
  if (tab && tab.id !== undefined) await chrome.tabs.sendMessage(tab.id, { type: 'elide:restore' }).catch(() => {});
  paintTab();
});

$('version').textContent = 'v' + chrome.runtime.getManifest().version;

chrome.storage.local.get({ ...DEFAULTS, stats: EMPTY }).then((s) => {
  paintSettings(s);
  paintStats(s.stats);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stats) paintStats(changes.stats.newValue);
  chrome.storage.local.get(DEFAULTS).then(paintSettings);
});
paintTab();
setInterval(paintTab, 1500);
