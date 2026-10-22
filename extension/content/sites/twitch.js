// Elide · Twitch adapter. Twitch stitches ads into the live HLS stream on the server,
// so the <video> element cannot seek or speed past them. In-page, Elide hides and mutes
// the break behind the last stream frame and lifts the curtain the moment it ends.
(() => {
  'use strict';
  const { register, shown } = globalThis.__elide;

  const AD_MARKS = [
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    '[data-test-selector="ad-banner-default-text"]',
    '[data-a-target="ax-overlay"] [aria-label*="Ad" i]'
  ].join(',');

  const RESERVED = new Set(['directory', 'videos', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'p', 'search', 'downloads', 'jobs', 'turbo', 'friends', 'messages']);

  function channel() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (seg[0] === 'popout' && seg[1]) return seg[1].toLowerCase();
    if (seg.length && !RESERVED.has(seg[0])) return seg[0].toLowerCase();
    return null;
  }

  register({
    name: 'twitch',
    label: 'Twitch',
    cut: false, // live and server-stitched: seeking or speeding would only stall the stream

    match: (loc) => /(^|\.)twitch\.tv$/.test(loc.hostname),

    videoId: () => channel() || location.pathname,

    scan() {
      const box = document.querySelector('[data-a-target="video-player"]') ||
        document.querySelector('.video-player__container') ||
        document.querySelector('.video-player');
      if (!box) return { host: null, video: null, ad: null };
      const video = box.querySelector('video');
      let ad = false;
      for (const el of box.querySelectorAll(AD_MARKS)) {
        if (shown(el)) {
          ad = true;
          break;
        }
      }
      return { host: box, video, ad: ad ? { video, skip: null, stitched: true } : null };
    },

    poster: (id) => (id && !id.startsWith('/') ? [`https://static-cdn.jtvnw.net/previews-ttv/live_user_${id}-1280x720.jpg`] : null)
  });
})();
