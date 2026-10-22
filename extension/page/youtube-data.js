// Elide · YouTube player data. Runs in the page's MAIN world at document_start, before
// any YouTube script, and sees every player response YouTube hands its player:
//   1. inline  `var ytInitialPlayerResponse = {...}`  -> accessor trap on window
//   2. fetch   `/youtubei/v1/player`, `/player/ad_break` -> Response.prototype.json
//   3. text    responses parsed with JSON.parse        -> JSON.parse
//   4. embeds  `embedded_player_response` JSON string  -> JSON.parse
//
// Always: reads the video length and the ad schedule (when mid-rolls are due) and passes
// them to the content script, which warms the shadow player ahead of each break.
// With Prevent on (page/strip.js runs first and sets the flag): also deletes the ad
// schedule, so the player never queues an ad.
(() => {
  'use strict';
  const FLAG = Symbol.for('elide.data');
  if (window[FLAG]) return;
  window[FLAG] = true;
  // Elide's own shadow player is left alone: embeds served no ads in testing, and a
  // stripped embed is one YouTube may hold back, which is the opposite of the point.
  if (/[?&]elide_relay=/.test(location.search)) return;

  const STRIP = window[Symbol.for('elide.strip')] === true;
  // Top-level keys that schedule or describe ads in an innertube response.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  // Placeholder YouTube uses for impression forecasting: not an ad, not counted.
  const FORECAST = 'clientForecastingAdRenderer';

  const metas = new Map(); // videoId -> meta, replayed to the content script on request

  function emit(meta) {
    metas.set(meta.videoId, meta);
    if (metas.size > 50) metas.delete(metas.keys().next().value);
    document.dispatchEvent(new CustomEvent('elide:yt', { detail: JSON.stringify(meta) }));
  }

  document.addEventListener('elide:yt-hello', () => {
    for (const meta of metas.values()) {
      document.dispatchEvent(new CustomEvent('elide:yt', { detail: JSON.stringify(meta) }));
    }
  });

  // Real ad breaks and, for mid-rolls, when they are due (seconds into the video).
  function schedule(obj) {
    let breaks = 0;
    const at = [];
    for (const p of Array.isArray(obj.adPlacements) ? obj.adPlacements : []) {
      const r = p && p.adPlacementRenderer;
      if (!r || (r.renderer && FORECAST in r.renderer)) continue;
      breaks++;
      const cfg = r.config && r.config.adPlacementConfig;
      const ms = cfg && cfg.kind === 'AD_PLACEMENT_KIND_MILLISECONDS' && Number(cfg.adTimeOffset && cfg.adTimeOffset.offsetStartMilliseconds);
      if (ms > 0) at.push(Math.round(ms / 100) / 10);
    }
    if (Array.isArray(obj.adSlots)) breaks += obj.adSlots.length;
    return { breaks, at: [...new Set(at)].sort((a, b) => a - b) };
  }

  function read(obj) {
    const { breaks, at } = schedule(obj);
    if (STRIP) {
      for (const key of AD_KEYS) if (key in obj) delete obj[key];
      // The "ad blockers are not allowed" dialog ships inside the player response.
      const mr = obj.auxiliaryUi && obj.auxiliaryUi.messageRenderers;
      if (mr) {
        delete mr.enforcementMessageViewModel;
        delete mr.bkaEnforcementMessageViewModel;
      }
    }
    const vd = obj.videoDetails;
    if (vd && vd.videoId) {
      emit({
        videoId: vd.videoId,
        length: Number(vd.lengthSeconds) || 0,
        live: Boolean(vd.isLive),
        prevented: STRIP ? breaks : 0,
        breaks: STRIP ? [] : at
      });
    }
    return obj;
  }

  function inspect(value) {
    if (!value || typeof value !== 'object') return value;
    try {
      if (Array.isArray(value)) {
        // legacy `?pbj=1` responses: [{ playerResponse }, { response }, ...]
        for (const part of value) if (part && part.playerResponse) read(part.playerResponse);
        return value;
      }
      if (value.responseContext || value.playabilityStatus || value.videoDetails) read(value);
      if (value.playerResponse && typeof value.playerResponse === 'object') read(value.playerResponse);
    } catch (_) {
      // Never let this break the page.
    }
    return value;
  }

  // 1. inline global
  let initial;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      enumerable: true,
      get: () => initial,
      set: (v) => { initial = inspect(v); }
    });
  } catch (_) { /* already defined as non-configurable: nothing to trap */ }

  // 2 + 3. Proxies keep `fn.toString()` reporting native code.
  JSON.parse = new Proxy(JSON.parse, {
    apply(target, self, args) {
      return inspect(Reflect.apply(target, self, args));
    }
  });

  const responseJson = Response.prototype.json;
  Response.prototype.json = new Proxy(responseJson, {
    apply(target, self, args) {
      return Reflect.apply(target, self, args).then(inspect);
    }
  });
})();
