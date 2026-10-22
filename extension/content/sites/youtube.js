// Elide · YouTube adapter: www, m., music., youtube-nocookie embeds and Shorts.
// The player marks every ad with `ad-showing` on #movie_player; ads play in the same
// <video> element as the content (client-side insertion) or, in some experiments,
// inside the content stream (server-stitched), which the engine detects by length.
(() => {
  'use strict';
  const { register, shown } = globalThis.__elide;

  const SKIP = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    'button[id^="skip-button"]',
    '.ytp-ad-skip-button-slot button'
  ].join(',');

  const SHORTS_AD = 'ytd-ad-slot-renderer, ad-badge-view-model, ytd-in-feed-ad-layout-renderer, ytd-reel-player-overlay-renderer [class*="ad-badge"]';

  const metas = new Map(); // videoId -> { length, live, prevented } from the MAIN-world pruner
  let choresAt = 0;
  let shortsSkippedFrom = null;

  const host = location.hostname;
  const music = host === 'music.youtube.com';
  const embed = location.pathname.startsWith('/embed/');

  function videoId() {
    const p = location.pathname;
    const m = p.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    if (m) return m[1];
    const v = new URLSearchParams(location.search).get('v');
    if (v) return v;
    const flexy = document.querySelector('ytd-watch-flexy[video-id]');
    return flexy ? flexy.getAttribute('video-id') : null;
  }

  function player() {
    if (location.pathname.startsWith('/shorts/')) {
      const s = document.querySelector('#shorts-player');
      if (s) return s;
    }
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  function chores(engine) {
    const t = performance.now();
    if (t - choresAt < 500) return;
    choresAt = t;

    // "Ad blockers are not allowed": remove the dialog and keep playing.
    const wall = document.querySelector('ytd-enforcement-message-view-model');
    if (wall && engine.active()) {
      const dialog = wall.closest('tp-yt-paper-dialog') || wall;
      dialog.remove();
      document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((b) => b.remove());
      if (engine.video && engine.video.paused && engine.content.playing) engine.video.play().catch(() => {});
    }

    // Sponsored Shorts: move on to the next short.
    if (location.pathname.startsWith('/shorts/') && engine.active() && globalThis.__elide.settings.cut) {
      const active = document.querySelector('ytd-reel-video-renderer[is-active]');
      if (active && active !== shortsSkippedFrom && active.querySelector(SHORTS_AD)) {
        shortsSkippedFrom = active;
        const next = document.querySelector('#navigation-button-down button, button[aria-label="Next video"]');
        if (next) next.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
        globalThis.__elide.send({ type: 'elide:break', cut: 1, adSeconds: 0, blankMs: 0, last: { site: 'youtube', reason: 'ad', method: 'next-short', adSeconds: 0, blankMs: 0, at: Date.now() } });
      }
    }
  }

  function applyClasses(settings) {
    const on = settings.enabled && settings.site_youtube;
    const root = document.documentElement;
    root.classList.toggle('elide-clean', Boolean(on && settings.cleanFeed));
  }

  register({
    name: 'youtube',
    label: music ? 'YouTube Music' : embed ? 'YouTube embed' : 'YouTube',
    // Seeking an ad to its end stalls YouTube's streaming (SABR): the server only sends
    // what is near the playhead, so the player waits ~9 s and kills the ad. Measured live.
    seek: false,

    match: (loc) => /(^|\.)youtube(-nocookie)?\.com$/.test(loc.hostname),

    setup(engine) {
      document.addEventListener('elide:yt', (e) => {
        let meta;
        try {
          meta = JSON.parse(e.detail);
        } catch (_) {
          return;
        }
        const seen = metas.get(meta.videoId);
        metas.set(meta.videoId, meta);
        if (meta.prevented > 0 && !(seen && seen.prevented >= meta.prevented)) {
          globalThis.__elide.send({ type: 'elide:prevented', n: meta.prevented });
        }
      });
      document.dispatchEvent(new CustomEvent('elide:yt-hello'));
      applyClasses(globalThis.__elide.settings);
      document.addEventListener('yt-navigate-finish', () => engine.schedule());
    },

    onSettings(_engine, settings) {
      applyClasses(settings);
    },

    videoId,

    // Next scheduled mid-roll after t (seconds), from the player data.
    nextBreak(id, t) {
      const meta = metas.get(id);
      const at = meta && meta.breaks ? meta.breaks.find((x) => x > t + 0.5) : undefined;
      return at === undefined ? null : at;
    },

    scan(engine) {
      chores(engine);
      const box = player();
      if (!box) return { host: null, video: null, ad: null };
      const video = box.querySelector('video.html5-main-video') || box.querySelector('video');
      if (!box.classList.contains('ad-showing') && !box.classList.contains('ad-interrupting')) {
        return { host: box, video, ad: null };
      }
      let skip = null;
      for (const el of box.querySelectorAll(SKIP)) {
        if (shown(el)) {
          skip = el;
          break;
        }
      }
      // Ad media at least as long as the video itself is the content stream with the
      // ad stitched in (or the content mid-swap): seeking to its end would end the video.
      const meta = metas.get(videoId());
      const stitched = Boolean(video && meta && meta.length && video.duration >= meta.length - 1.5);
      return { host: box, video, ad: { video, skip, stitched } };
    },

    poster: (id) => (id ? [`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`] : null),

    // Shadow player: YouTube's own embed player for the same video, which served no ads
    // in live testing. YouTube refuses to play an embed inside its own app pages (watch,
    // home), so the embed is nested in a youtube-nocookie.com page that is not the app:
    // a tiny text file. Warmed up (muted, paused) whenever a video opens.
    relay: music || embed || location.pathname.startsWith('/shorts/') ? null : {
      warm: true,
      eager: true, // YouTube holds content for the ad's real length, so there is nothing to wait for
      nested: true,
      origin: 'https://www.youtube-nocookie.com',
      url(id, t) {
        const meta = metas.get(id);
        if (!id || !/^[\w-]{11}$/.test(id) || (meta && meta.live)) return null;
        return `https://www.youtube-nocookie.com/robots.txt?elide_relay=${id}&t=${Math.floor(t || 0)}`;
      }
    },

    // Inside that text page: put the embed in it.
    isRelayHost: () => host === 'www.youtube-nocookie.com' && location.pathname === '/robots.txt' &&
      window.top !== window && new URLSearchParams(location.search).has('elide_relay'),
    relayHost() {
      const p = new URLSearchParams(location.search);
      const id = p.get('elide_relay');
      if (!/^[\w-]{11}$/.test(id)) return;
      const q = new URLSearchParams({
        autoplay: '1', mute: '1', controls: '0', disablekb: '1', fs: '0', iv_load_policy: '3',
        playsinline: '1', rel: '0', start: String(Number(p.get('t')) || 0), elide_relay: '1'
      });
      const frame = document.createElement('iframe');
      frame.allow = 'autoplay; encrypted-media';
      frame.src = `https://www.youtube-nocookie.com/embed/${id}?${q}`;
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#000';
      const mount = () => document.body ? document.body.replaceChildren(frame) : requestAnimationFrame(mount);
      mount();
    },

    isRelayChild: () => embed && window.top !== window && new URLSearchParams(location.search).has('elide_relay'),
    // The player template always contains a hidden .ytp-error; only a visible one is real.
    relayError: () => shown(document.querySelector('.ytp-error'))
  });
})();
