// Elide · Hulu adapter. EXPERIMENTAL and UNTESTED: written without a Hulu account, so
// the ad markers below are informed guesses. Off by default and opt-in from the popup.
// Hulu stitches ads into a DRM stream, so the only safe actions are curtain + mute; no
// seeking or speeding. The curtain shows black (DRM frames cannot be drawn to a canvas).
(() => {
  'use strict';
  const { register, shown } = globalThis.__elide;

  const AD_MARKS = [
    '[data-testid="ad-countdown"]',
    '[data-testid="ad-timer"]',
    '[class*="AdUnitView"]',
    '[class*="ad-countdown" i]',
    '[class*="AdBadge"]',
    '[aria-label*="advertisement" i]'
  ].join(',');

  register({
    name: 'hulu',
    label: 'Hulu (experimental)',
    cut: false,

    match: (loc) => /(^|\.)hulu\.com$/.test(loc.hostname),

    scan() {
      const video = document.querySelector('video');
      if (!video) return { host: null, video: null, ad: null };
      const host = video.closest('[data-testid*="player" i], [class*="Player" i]') || video.parentElement;
      let ad = false;
      for (const el of document.querySelectorAll(AD_MARKS)) {
        if (shown(el)) {
          ad = true;
          break;
        }
      }
      return { host, video, ad: ad ? { video, skip: null, stitched: true } : null };
    }
  });
})();
