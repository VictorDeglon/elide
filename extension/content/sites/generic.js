// Elide · any-site adapter (opt-in, needs the <all_urls> grant). Covers the ad stacks most
// independent video sites use:
//   Google IMA   the ad plays in its own <video title="Advertisement"> laid over the content
//   video.js     contrib-ads marks the player `vjs-ad-playing` and reuses the content <video>
//   JW Player    marks the player `jw-flag-ads`
// These players load ads as plain files, so seeking to the end works and ends the ad at once.
(() => {
  'use strict';
  const { register, shown } = globalThis.__elide;

  const PLAYER = '.video-js, .jwplayer, [data-vjs-player], .plyr, .fp-player, .bitmovinplayer-container';
  const FLAGGED = '.video-js.vjs-ad-playing, .jwplayer.jw-flag-ads';
  const SKIP = '.jw-skip:not(.jw-hidden), .vjs-ad-skip, [class*="ad-skip" i] button, button[class*="skip-ad" i]';

  function largestVideo(except) {
    let best = null;
    let area = 0;
    for (const v of document.querySelectorAll('video')) {
      if (v === except || v.title === 'Advertisement') continue;
      const r = v.getBoundingClientRect();
      if (r.width * r.height > area) {
        area = r.width * r.height;
        best = v;
      }
    }
    return best;
  }

  const playerOf = (v) => (v ? v.closest(PLAYER) || v.parentElement : null);

  register({
    name: 'any',
    label: 'This site',
    watchSubtree: true, // IMA adds and shows its ad <video> inside the player

    match: () => true,

    scan() {
      // 1. Google IMA.
      for (const v of document.querySelectorAll('video[title="Advertisement"]')) {
        if (shown(v) && v.currentSrc && !v.ended) {
          const content = largestVideo(v);
          return {
            host: playerOf(content) || v.parentElement,
            video: content || v,
            ad: { video: v, host: v.parentElement, skip: null, stitched: false }
          };
        }
      }
      // 2. Players that flag ad playback on their own container.
      const flagged = document.querySelector(FLAGGED);
      if (flagged) {
        const v = flagged.querySelector('video');
        if (v) {
          const skip = flagged.querySelector(SKIP);
          return { host: flagged, video: v, ad: { video: v, host: flagged, skip: skip && shown(skip) ? skip : null, stitched: false } };
        }
      }
      const v = largestVideo(null);
      return { host: playerOf(v), video: v, ad: null };
    }
  });
})();
