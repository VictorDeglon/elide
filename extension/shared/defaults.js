// Settings shared by the service worker, the popup and every content script.
// Loaded as a classic script so all three contexts can use it without a bundler.
globalThis.ELIDE_DEFAULTS = Object.freeze({
  enabled: true,

  // Engine layers, in the order they act.
  prevent: false,   // YouTube: strip ad schedules from player data (off: YouTube answers with a startup hold)
  shield: true,     // block known ad/tracker hosts at the network layer (never on YouTube/Twitch)
  curtain: true,    // cover a running ad with the last content frame
  cut: true,        // end the ad under the curtain: skip button, seek to end, or 16x
  relay: true,      // if an ad survives the cut, play the content in a shadow player meanwhile
  cleanFeed: true,  // hide sponsored cards, banners, player overlays and upsell popups
  indicator: true,  // tiny label on the curtain while an ad is being cut

  // Sites.
  site_youtube: true,
  site_twitch: true,
  site_any: false,  // IMA / video.js / JW Player ads on any site; needs the optional <all_urls> grant
  site_hulu: false  // experimental, untested
});

globalThis.ELIDE_EMPTY_STATS = Object.freeze({
  cut: 0,          // ads handled (cut, or covered while they ran out)
  prevented: 0,    // ad breaks removed from player data before they were scheduled
  breaks: 0,       // interruptions handled (ad breaks and server holds)
  relayed: 0,      // of those, bridged by the shadow player
  adSeconds: 0,    // total length of the ads handled
  blankMs: 0,      // total time without the video on screen during those breaks
  last: null       // { site, reason, adSeconds, blankMs, method, relayed, at }
});
