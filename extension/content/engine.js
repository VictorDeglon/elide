// Elide · engine. Isolated-world content script shared by every site adapter.
//
// One break, start to finish:
//   detect   the adapter reports an ad on the player, or the player stalls with nothing
//            to show (YouTube holds content back while an ad "should" be playing)
//   curtain  the last content frame covers the player and the ad is muted
//   cut      under the curtain: the site's skip button, a seek to the ad's end, or 16x
//            (Chromium's ceiling; 17x+ throws NotSupportedError). Each adapter picks.
//   relay    a shadow copy of the video, warmed up hidden next to the player, plays the
//            content in front while the main player sits out the ad behind it
//   resume   the main player takes over where the shadow got to; rate and audio restored
(() => {
  'use strict';
  if (globalThis.__elide) return;

  const MAX_RATE = 16;
  const POD_GRACE_MS = 220;      // the ad flag can drop for a beat between ads in a pod
  const SEEK_PATIENCE_MS = 700;  // a seek that hasn't ended the ad by then falls back to 16x
  const RELAY_AFTER_MS = 1200;   // an ad still running after this is handed to the shadow
  const STALL_MS = 2500;         // wants to play, has nothing to show, for this long = stall
  const HOLD_GRACE_MS = 800;     // after an ad, content this late is being held back by the site
  const WARM_FOR_MS = 25000;     // a shadow warmed at startup is dropped after this much smooth playback
  const WARM_AHEAD_S = 20;       // warm the shadow this long before a scheduled mid-roll
  const CURTAIN_MAX_MS = 5000;   // never hold the curtain longer than this once a break ends
  const FRAME_EVERY_MS = 400;    // refresh interval for the remembered content frame
  const SETTLE_MS = 600;         // ignore frames this soon after a source change
  const SWALLOW = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu'];

  const settings = { ...globalThis.ELIDE_DEFAULTS };
  const sites = [];
  let engine = null;

  const now = () => performance.now();

  // Opt-in trace for bug reports: localStorage['elide:debug'] = '1' on the site, reload.
  let DEBUG = false;
  try {
    DEBUG = localStorage.getItem('elide:debug') === '1';
  } catch (_) { /* storage blocked */ }
  const debug = (...args) => {
    if (DEBUG) console.debug('[elide]', (top === self ? 'top' : 'frame'), ...args);
  };

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (_) {
      // Extension was reloaded; this content script is orphaned.
    }
  }

  function shown(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function press(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    el.click();
  }

  function swallowClicks(el) {
    for (const type of SWALLOW) el.addEventListener(type, (e) => e.stopPropagation());
  }

  // Remembers the most recent content frame so the curtain can show it.
  class Frames {
    constructor() {
      this.canvas = null;
      this.ok = false;
      this.key = '';
      this.at = 0;
    }

    grab(video, key) {
      const t = now();
      if (t - this.at < FRAME_EVERY_MS) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      if (video.paused && this.ok && this.key === key) return;
      this.at = t;
      const w = Math.min(video.videoWidth, 1280);
      const h = Math.round((w * video.videoHeight) / video.videoWidth);
      const c = this.canvas || (this.canvas = document.createElement('canvas'));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      try {
        c.getContext('2d', { alpha: false }).drawImage(video, 0, 0, w, h);
        this.ok = true;
        this.key = key;
      } catch (_) {
        this.ok = false;
      }
    }

    copy(key) {
      if (!this.ok || this.key !== key) return null;
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      c.getContext('2d', { alpha: false }).drawImage(this.canvas, 0, 0);
      return c;
    }

    clear() {
      this.ok = false;
    }
  }

  // The layer that hides a running ad. Lives inside the player so it follows
  // fullscreen, theater mode and the miniplayer.
  class Curtain {
    constructor() {
      this.el = null;
      this.host = null;
      this.tag = null;
      this.revealed = false;
    }

    get up() {
      return Boolean(this.el);
    }

    show(host, { frame, poster, label }) {
      if (this.el && this.host === host) return;
      this.drop(true);
      const el = document.createElement('div');
      el.className = 'elide-curtain';
      el.setAttribute('aria-hidden', 'true');
      if (frame) {
        el.appendChild(frame);
      } else if (poster && poster.length) {
        // Try each URL in turn; YouTube answers a missing size with a 120px placeholder.
        const urls = [].concat(poster);
        const img = new Image();
        img.decoding = 'async';
        img.alt = '';
        img.onerror = () => {
          urls.shift();
          if (urls.length) img.src = urls[0];
          else img.remove();
        };
        img.onload = () => {
          if (img.naturalWidth <= 120) img.onerror();
        };
        img.src = urls[0];
        el.appendChild(img);
      }
      this.tag = null;
      if (label) {
        this.tag = document.createElement('span');
        this.tag.className = 'elide-tag';
        this.tag.textContent = 'ad · cutting';
        const bar = document.createElement('i');
        bar.className = 'elide-bar';
        el.append(this.tag, bar);
      }
      // Keep clicks away from the ad underneath; double-click reveals it.
      swallowClicks(el);
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.revealed = true;
        this.drop();
      });
      host.appendChild(el);
      this.el = el;
      this.host = host;
    }

    label(text) {
      if (this.tag && this.tag.textContent !== text) this.tag.textContent = text;
    }

    drop(instant = false) {
      const el = this.el;
      if (!el) return;
      this.el = null;
      this.tag = null;
      this.host = null;
      if (instant) {
        el.remove();
      } else {
        el.dataset.out = '';
        setTimeout(() => el.remove(), 220);
      }
    }
  }

  // The shadow player: a second, ad-free copy of the video from the site itself (for
  // YouTube, its embed player). Sits in its own layer inside the player, hidden, because
  // an iframe reloads if it is moved. Elide's content script inside it reports playback
  // and takes commands over postMessage (see relayChild below).
  class Relay {
    constructor(host, url, key, at, spec, purpose) {
      this.key = key;
      this.purpose = purpose; // 'start' (freshly opened video) or 'break' (a scheduled mid-roll)
      this.nested = Boolean(spec.nested); // the player sits one frame deeper than our iframe
      this.origin = spec.origin || new URL(url).origin;
      this.born = now();
      this.time = at;
      this.at = now();
      this.holdAt = at;
      this.ready = false;
      this.playing = false;
      this.live = false;
      this.failed = false;
      this.wantPlay = null;
      this.layer = document.createElement('div');
      this.layer.className = 'elide-shadow';
      this.layer.setAttribute('aria-hidden', 'true');
      swallowClicks(this.layer);
      this.frame = document.createElement('iframe');
      this.frame.allow = 'autoplay; encrypted-media';
      this.frame.tabIndex = -1;
      this.frame.src = url;
      this.layer.appendChild(this.frame);
      host.appendChild(this.layer);
      debug('relay created', url);
    }

    get win() {
      const w = this.frame.contentWindow;
      return this.nested ? w && w[0] : w;
    }

    send(msg) {
      try {
        this.win.postMessage({ elide: 'relay-cmd', ...msg }, this.origin);
      } catch (_) { /* frame gone */ }
    }

    tick(d) {
      if (d.error) {
        debug('relay failed');
        this.failed = true;
        return;
      }
      this.time = d.t;
      this.at = now();
      this.playing = Boolean(d.playing);
      if (d.ready && !this.ready) {
        debug('relay ready at', d.t);
        this.ready = true;
        if (this.wantPlay) this.send({ cmd: 'play', ...this.wantPlay });
        else this.send({ cmd: 'hold', t: this.holdAt });
      }
      if (this.wantPlay && this.playing && !this.live) {
        debug('relay live at', d.t);
        this.live = true;
        this.layer.dataset.live = '';
      }
    }

    hold(t) {
      this.holdAt = t;
      if (this.ready && !this.wantPlay) this.send({ cmd: 'hold', t });
    }

    play(opts) {
      this.wantPlay = opts;
      if (this.ready) this.send({ cmd: 'play', ...opts });
    }

    position(rate) {
      return this.time + (this.playing ? ((now() - this.at) / 1000) * rate : 0);
    }

    destroy() {
      this.send({ cmd: 'stop' });
      this.layer.remove();
    }
  }

  class Engine {
    constructor(site) {
      this.site = site;
      this.state = 'idle'; // idle | ad | resume
      this.host = null;
      this.video = null;
      this.brk = null;
      this.last = null;
      this.token = 0;
      this.forcedRate = 0;
      this.loadStartAt = 0;
      this.stallSince = 0;
      this.lastKey = null;
      this.relay = null;
      this.refused = new Set(); // videos whose shadow player failed to load
      this.pendingLift = false;
      this.content = { rate: 1, time: 0, duration: 0, playing: false, src: '' };
      this.frames = new Frames();
      this.curtain = new Curtain();
      this.queued = false;
      // Changes Elide makes itself (curtain, shadow layer) must not trigger another check,
      // or a subtree watch would loop: check, update the label, mutation, check...
      const ours = (n) => n && n.nodeType === 1 && (n.matches('.elide-curtain, .elide-shadow') || n.closest('.elide-curtain, .elide-shadow'));
      this.hostObserver = new MutationObserver((records) => {
        for (const r of records) {
          if (ours(r.target)) continue;
          if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)) continue;
          return this.schedule();
        }
      });
      this.onVideoEvent = this.onVideoEvent.bind(this);
      this.onMessage = this.onMessage.bind(this);
    }

    start() {
      this.site.setup?.(this);
      window.addEventListener('message', this.onMessage);
      // Media events don't bubble, but they do pass through a capture listener on the
      // document: any <video> on the page starting (an ad element included) is seen at once.
      for (const type of ['loadstart', 'play', 'playing']) document.addEventListener(type, () => this.schedule(), true);
      const tick = () => {
        this.check();
        setTimeout(tick, this.host ? 250 : 1000);
      };
      tick();
      new MutationObserver(() => {
        if (!this.host || !this.host.isConnected) this.schedule();
      }).observe(document.documentElement, { childList: true, subtree: true });
    }

    active() {
      return settings.enabled && settings['site_' + this.site.name] !== false;
    }

    schedule() {
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        this.check();
      });
    }

    key() {
      return this.site.videoId?.() || location.pathname + location.search;
    }

    check() {
      if (!this.active()) {
        if (this.state !== 'idle' || this.curtain.up || this.relay) this.release(true);
        return;
      }
      const key = this.key();
      if (key !== this.lastKey) {
        if (this.lastKey !== null) this.navigated();
        this.lastKey = key;
      }
      const scan = this.site.scan(this);
      if (scan.host !== this.host) this.bindHost(scan.host);
      if (scan.video !== this.video) this.bindVideo(scan.video);
      if (!scan.video) return;
      if (scan.ad) this.onAd(scan);
      else if (this.brk && this.state === 'ad' && (this.brk.reason === 'stall' || this.brk.hold)) this.onStall(scan);
      else this.onContent(scan);
    }

    bindHost(host) {
      this.hostObserver.disconnect();
      if (this.relay) this.dropRelay();
      this.host = host;
      if (!host) return;
      // Sites whose ad markup appears inside the player (rather than as a class on it)
      // ask for the whole player subtree to be watched.
      this.hostObserver.observe(host, this.site.watchSubtree
        ? { attributes: true, attributeFilter: ['class', 'style', 'src'], childList: true, subtree: true }
        : { attributes: true, attributeFilter: ['class'] });
    }

    bindVideo(video) {
      const events = ['loadstart', 'playing', 'pause', 'timeupdate', 'ratechange', 'volumechange', 'durationchange', 'ended', 'waiting'];
      if (this.video) for (const e of events) this.video.removeEventListener(e, this.onVideoEvent);
      this.video = video;
      if (video) {
        for (const e of events) video.addEventListener(e, this.onVideoEvent);
        if (this.state === 'idle') this.content.rate = video.playbackRate;
      }
    }

    onVideoEvent(e) {
      const v = e.target;
      switch (e.type) {
        case 'loadstart':
          this.loadStartAt = now();
          this.schedule();
          return;
        case 'volumechange':
          // Our own mute arrives here too, so only an unmute matters. It counts as the
          // user's choice only with a fresh user gesture; otherwise the player undid it.
          if (this.brk && this.state !== 'idle' && !v.muted && !this.brk.userAudio && this.brk.muted.has(v)) {
            if (navigator.userActivation?.isActive) this.brk.userAudio = true;
            else v.muted = true;
          }
          return;
        case 'ratechange':
          if (this.state === 'idle') {
            if (v.playbackRate > 0 && v.playbackRate !== this.forcedRate) this.content.rate = v.playbackRate;
          } else if (this.forcedRate && v.playbackRate !== this.forcedRate && this.brk) {
            // Players reset the rate once per ad; one that keeps resetting it is fighting
            // back, and a re-force loop would starve the page. Leave it to curtain + relay.
            const brk = this.brk;
            const t = now();
            brk.resets = (brk.resets || []).filter((x) => t - x < 1000).concat(t);
            if (brk.resets.length > 4) {
              brk.rateBlocked = true;
              this.forcedRate = 0;
              return;
            }
            this.forceRate(v);
          }
          return;
        case 'timeupdate':
          if (this.state === 'idle' && !this.queued && v === this.video) this.remember(v);
          return;
        default:
          this.schedule();
      }
    }

    // Content bookkeeping while no ad is running.
    remember(v) {
      if (now() - this.loadStartAt < SETTLE_MS || this.pendingLift) return;
      if (this.site.scan(this).ad) return;
      this.content.time = v.currentTime;
      this.content.playing = !v.paused;
      if (Number.isFinite(v.duration)) this.content.duration = v.duration;
      this.content.src = v.currentSrc;
      if (settings.curtain) this.frames.grab(v, this.key());
    }

    onContent(scan) {
      if (this.state === 'ad') this.beginResume();
      if (this.state !== 'idle') return;
      if (this.curtain.up && !this.pendingLift) this.curtain.drop();
      if (this.pendingLift) return;
      const v = scan.video;

      // Keep a shadow warm when an interruption is likely: a freshly opened video (YouTube
      // may hold it back) and the run-up to a scheduled mid-roll, buffered at that point.
      const due = this.site.nextBreak?.(this.key(), v.currentTime);
      const soon = due !== null && due !== undefined && due - v.currentTime < WARM_AHEAD_S;
      const r = this.relay;
      if (r && !r.wantPlay) {
        const stale = r.purpose === 'start'
          ? now() - r.born > WARM_FOR_MS && this.content.playing && v.readyState >= 3
          : v.currentTime > r.holdAt + 20;
        if (soon && Math.abs(r.holdAt - due) > 1) {
          r.purpose = 'break';
          r.hold(due);
        } else if (r.failed || stale) {
          this.dropRelay();
        }
      } else if (!r && this.site.relay?.warm && this.canRelay()) {
        if (soon) this.relayFor(due, 'break');
        else if (v.currentTime < 1 && this.warmedKey !== this.key()) {
          this.warmedKey = this.key();
          this.relayFor(v.currentTime, 'start');
        }
      }

      // A player that wants to play but has nothing to show is being held back.
      const starving = !v.paused && !v.ended && v.readyState < 3;
      if (DEBUG && (starving || this.stallSince)) debug('starving', starving, 'paused', v.paused, 'readyState', v.readyState, 'canRelay', this.canRelay());
      if (!starving || !this.canRelay()) {
        this.stallSince = 0;
      } else if (!this.stallSince) {
        this.stallSince = now();
      } else if (now() - this.stallSince > STALL_MS) {
        const since = this.stallSince;
        this.stallSince = 0;
        this.beginBreak(scan, 'stall', since);
      }
    }

    onAd(scan) {
      const v = scan.ad.video || scan.video;
      if (this.state === 'idle') this.beginBreak(scan, 'ad');
      else if (this.state === 'resume') {
        this.state = 'ad';
        clearTimeout(this.resumeTimer);
      }
      const brk = this.brk;
      if (brk.reason === 'stall') brk.reason = 'ad'; // the stall turned out to be an ad
      brk.hold = 0;
      brk.lastAdAt = now();
      this.mute(v);
      if (settings.curtain && !this.curtain.revealed) this.raise(scan);
      if (settings.cut && this.site.cut !== false) this.cut(scan, v);
      if (scan.ad.stitched) brk.stitched = true;
      // A shadow that is already buffered takes over at once on sites that hold content
      // for the ad's length anyway (eager); otherwise give the cut a moment first.
      const ready = this.relay && this.relay.ready && this.relay.key === brk.key;
      const due = (this.site.relay?.eager && ready) || now() - brk.t0 > RELAY_AFTER_MS;
      if (settings.curtain && !this.curtain.revealed && !brk.stitched && due) this.startRelay(scan);
      this.updateLabel(v);
    }

    // The main player has nothing to show: a stall, or content held back after an ad.
    onStall(scan) {
      const brk = this.brk;
      const v = scan.video;
      const due = !brk.hold || brk.relayOn || now() - brk.hold > HOLD_GRACE_MS;
      const relay = due ? this.startRelay(scan) : this.relay;
      if (due && (!relay || relay.failed)) {
        this.refused.add(brk.key); // no shadow for this video (live, refused): stop trying
        return this.release(); // nothing better to show than the site's spinner
      }
      if (relay && relay.live) {
        this.mute(v);
        brk.relayLive = true;
        if (!brk.visibleAt) brk.visibleAt = now();
      }
      const moving = v.readyState >= 3 && !v.paused && (brk.hold || v.currentTime > brk.stallTime + 0.25);
      if (moving) this.beginResume();
    }

    // `since`: when the interruption really began (a stall is only called after STALL_MS).
    beginBreak(scan, reason, since = now()) {
      debug('break', reason, 'at', scan.video.currentTime, 'readyState', scan.video.readyState);
      this.state = 'ad';
      this.token++;
      this.pendingLift = false;
      this.curtain.revealed = false;
      this.brk = {
        reason,
        t0: since,
        lastAdAt: now(),
        key: this.key(),
        resumeAt: reason === 'stall' ? scan.video.currentTime : this.content.time,
        stallTime: scan.video.currentTime,
        wasPlaying: reason === 'stall' || this.content.playing,
        medias: new Map(),
        muted: new Set(),
        userAudio: false,
        method: null,
        relayOn: false,
        visibleAt: 0
      };
      if (this.canRelay()) this.relayFor(this.brk.resumeAt); // warm it now; it takes over after RELAY_AFTER_MS
      this.site.onBreak?.(this, scan);
    }

    mute(v) {
      const brk = this.brk;
      if (brk.userAudio || v.muted) return;
      v.muted = true;
      brk.muted.add(v);
    }

    raise(scan) {
      const host = scan.ad.host || scan.host;
      if (!host) return;
      const key = this.brk.key;
      this.curtain.show(host, {
        frame: this.frames.copy(key),
        poster: this.site.poster?.(key) || null,
        label: settings.indicator
      });
    }

    canRelay() {
      return Boolean(settings.relay && settings.curtain && this.site.relay && this.host && !this.refused.has(this.key()));
    }

    // The shadow for the current video: the warm one if there is one, else a new one.
    relayFor(t, purpose = 'break') {
      const key = this.key();
      if (this.relay && (this.relay.key !== key || this.relay.failed)) this.dropRelay();
      if (this.relay) return this.relay;
      if (!this.canRelay()) return null;
      const url = this.site.relay.url(key, t);
      if (!url) return null;
      debug('warming shadow for', purpose, 'at', t);
      this.relay = new Relay(this.host, url, key, t, this.site.relay, purpose);
      return this.relay;
    }

    dropRelay() {
      if (!this.relay) return;
      if (this.relay.failed) this.refused.add(this.relay.key);
      this.relay.destroy();
      this.relay = null;
    }

    startRelay(scan) {
      const brk = this.brk;
      const relay = this.relayFor(brk.resumeAt);
      if (!relay) return null;
      if (!brk.relayOn) {
        brk.relayOn = true;
        const v = scan.video;
        relay.play({
          t: brk.resumeAt,
          rate: this.content.rate || 1,
          volume: v ? v.volume : 1,
          muted: brk.muted.size ? false : Boolean(v && v.muted)
        });
      }
      if (relay.live) {
        brk.relayLive = true;
        if (!brk.visibleAt) brk.visibleAt = now();
      }
      return relay;
    }

    // Ends the ad as fast as the page allows. Called on every check during an ad.
    cut(scan, v) {
      const brk = this.brk;
      const t = now();
      const id = v.currentSrc || v.src || 'media';
      let m = brk.medias.get(id);
      if (!m) {
        m = { first: t, seekAt: 0, skipped: false, rate: false, dur: NaN, from: v.currentTime, to: v.currentTime };
        brk.medias.set(id, m);
      }
      m.to = v.currentTime;

      // Never seek the content itself. Players raise the ad flag a beat before swapping
      // the ad in, and server-stitched ads share the content's media; either way the
      // element still looks like the content (same source or same length).
      const c = this.content;
      const midSwap = !scan.ad.stitched && Boolean(
        (c.src && v.currentSrc === c.src) || (c.duration > 0 && Math.abs(v.duration - c.duration) < 1.5)
      );
      const looksLikeContent = scan.ad.stitched || midSwap;
      if (looksLikeContent) {
        m.content = true;
        if (midSwap && t - m.first < SEEK_PATIENCE_MS) return; // give the ad a moment to load
      } else if (Number.isFinite(v.duration)) {
        m.dur = v.duration;
      }

      // 1. The site's own skip button, the cleanest exit when it is offered.
      const skip = scan.ad.skip;
      if (skip && !m.skipped && shown(skip)) {
        m.skipped = true;
        brk.method = 'skip';
        press(skip);
        if (!this.site.scan(this).ad) return;
      }

      // 2. Seek to the end: effectively instant, far beyond any playback rate. Only where
      //    the player can fetch the last segment on demand (not YouTube: it stalls there).
      //    Until the ad's length is known, 16x stands in; the seek still follows.
      const canSeek = !looksLikeContent && this.site.seek !== false && !m.seekFailed;
      if (canSeek && Number.isFinite(v.duration) && v.duration > 0) {
        if (!m.seekAt) {
          m.seekAt = t;
          brk.method = 'seek';
          try {
            v.currentTime = v.duration;
            return;
          } catch (_) {
            m.seekFailed = true;
          }
        } else if (t - m.seekAt < SEEK_PATIENCE_MS) {
          return;
        } else {
          m.seekFailed = true; // the player refused or reverted the seek
        }
      }
      if (canSeek && Number.isNaN(v.duration) && t - m.first < SEEK_PATIENCE_MS) return; // length is moments away

      // 3. 16x: Chromium's hard ceiling.
      if (this.site.rate !== false && !brk.rateBlocked) {
        m.rate = true;
        if (!m.seekAt || m.seekFailed) brk.method = 'rate';
        if (v.playbackRate !== this.forcedRate) this.forceRate(v);
      }
    }

    forceRate(v) {
      for (const r of [MAX_RATE, 8, 4, 2]) {
        try {
          v.playbackRate = r;
          this.forcedRate = r;
          this.brk.touchedRate = true;
          return;
        } catch (_) { /* rejected; try the next one down */ }
      }
    }

    updateLabel(v) {
      if (!this.curtain.tag) return;
      if (this.forcedRate) {
        const left = (v.duration - v.currentTime) / this.forcedRate;
        if (Number.isFinite(left)) return this.curtain.label(`ad · ${this.forcedRate}× · ${Math.max(0, left).toFixed(1)}s`);
      }
      this.curtain.label('ad · cutting');
    }

    beginResume() {
      this.state = 'resume';
      clearTimeout(this.resumeTimer);
      this.resumeTimer = setTimeout(() => this.finishBreak(), POD_GRACE_MS);
    }

    finishBreak() {
      if (this.state !== 'resume') return;
      const scan = this.site.scan(this);
      if (scan.ad) {
        this.state = 'ad';
        return;
      }
      const v = scan.video || this.video;
      const brk = this.brk;
      const relay = brk.relayOn ? this.relay : null;

      // The ad is over but the site is still holding the content back (YouTube does this
      // until the ad's real length has passed). The shadow plays until it lets go.
      if (v && !brk.stitched && !v.paused && v.readyState < 3 && ((relay && relay.live) || this.canRelay())) {
        if (!brk.hold) brk.hold = now();
        brk.stallTime = v.currentTime;
        this.state = 'ad';
        return;
      }

      const token = this.token;
      debug('break over', brk.reason, 'relay', relay ? (relay.live ? 'live' : 'not live') : 'none');
      this.state = 'idle';
      const shadowAudio = Boolean(relay && relay.live);
      if (v) this.restore(v, brk, !shadowAudio); // with the shadow live, unmute only after it stops
      this.pendingLift = true;

      const lift = () => this.afterFrame(v, () => {
        if (this.token !== token) {
          // A new break started meanwhile: it inherits the unmute still owed from this one.
          if (shadowAudio && this.brk && this.brk !== brk) for (const el of brk.muted) this.brk.muted.add(el);
          return;
        }
        this.pendingLift = false;
        if (relay && relay === this.relay) this.dropRelay();
        if (shadowAudio) this.restoreAudio(brk);
        if (v) this.restoreRate(v); // a media load in between may have reset it
        if (!brk.visibleAt) brk.visibleAt = now();
        this.curtain.drop();
        this.report(brk);
      });

      // A stitched ad shares the content's timeline and the shadow's has no ad in it, so
      // positions don't line up; those breaks end on the main player's own clock.
      if (v && relay && relay.live && !brk.stitched) this.handOff(v, relay, lift);
      else lift();
    }

    // Moves the main player to where the shadow player got to, then lifts the curtain.
    // Sites seek to their own resume point after an ad; if one does, Elide seeks again.
    handOff(v, relay, lift) {
      let goal = 0;
      let retries = 2;
      let lifted = false;
      const done = () => {
        if (lifted) return;
        lifted = true;
        v.removeEventListener('seeked', onSeeked);
        lift();
      };
      const go = () => {
        goal = relay.position(this.content.rate || 1);
        try {
          v.currentTime = goal;
        } catch (_) {
          done();
        }
      };
      const onSeeked = () => {
        if (v.currentTime < goal - 2 && retries-- > 0) return go(); // pulled back by the site
        done();
      };
      v.addEventListener('seeked', onSeeked);
      setTimeout(done, CURTAIN_MAX_MS);
      if (v.readyState >= 1) go();
      else v.addEventListener('loadedmetadata', go, { once: true });
    }

    restoreRate(v) {
      const rate = this.content.rate || 1;
      if (v.playbackRate !== rate) {
        try {
          v.playbackRate = rate;
        } catch (_) { /* ignore */ }
      }
    }

    restore(v, brk, audio = true) {
      this.restoreRate(v);
      this.forcedRate = 0;
      if (audio) this.restoreAudio(brk);
      if (brk.wasPlaying && v.paused) v.play().catch(() => {});
    }

    restoreAudio(brk) {
      if (brk.userAudio) return;
      for (const el of brk.muted) if (el.isConnected) el.muted = false;
      brk.muted.clear();
    }

    // Calls back once the main video presents a content frame (or is ready while paused).
    afterFrame(v, done) {
      let fired = false;
      const finish = () => {
        if (fired) return;
        fired = true;
        clearTimeout(cap);
        if (v) v.removeEventListener('canplay', onReady);
        done();
      };
      const onReady = () => {
        if (v.paused) requestAnimationFrame(finish);
      };
      const cap = setTimeout(finish, CURTAIN_MAX_MS);
      if (!v) return finish();
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => finish());
      else v.addEventListener('timeupdate', finish, { once: true });
      v.addEventListener('canplay', onReady);
      if (v.paused && v.readyState >= 2) requestAnimationFrame(finish);
    }

    report(brk) {
      let adSeconds = 0;
      let cut = 0;
      for (const m of brk.medias.values()) {
        if (m.content && !m.rate) continue; // the content element seen mid-swap, not an ad
        if (m.content) adSeconds += Math.max(0, m.to - m.from); // stitched: the stretch we ran through
        else if (Number.isFinite(m.dur)) adSeconds += m.dur;
        cut++;
      }
      const relayed = Boolean(brk.relayLive);
      const method = brk.reason === 'stall' ? 'relay' : brk.method || (relayed ? 'relay' : 'curtain');
      const blankMs = Math.round((brk.visibleAt || now()) - brk.t0);
      this.last = { site: this.site.name, reason: brk.reason, adSeconds: Math.round(adSeconds * 10) / 10, blankMs, method, relayed, at: Date.now() };
      send({ type: 'elide:break', cut, adSeconds, blankMs, relayed, last: this.last });
    }

    // Undo everything Elide changed. Used when disabled and on navigation.
    release(dropShadow = false) {
      clearTimeout(this.resumeTimer);
      if (this.brk && this.video && this.state !== 'idle') this.restore(this.video, this.brk);
      if (this.brk) this.restoreAudio(this.brk); // also covers a hand-off cut short
      if (this.brk && this.brk.relayOn) this.dropRelay();
      if (dropShadow) this.dropRelay();
      this.curtain.drop(true);
      this.pendingLift = false;
      this.stallSince = 0;
      this.state = 'idle';
      this.token++;
    }

    navigated() {
      this.release(true);
      this.frames.clear();
      this.warmedKey = null;
      this.content.time = 0;
      this.content.duration = 0;
      this.content.playing = false;
      this.content.src = '';
    }

    onMessage(e) {
      const relay = this.relay;
      if (!relay || e.source !== relay.win || e.origin !== relay.origin) return;
      if (e.data && e.data.elide === 'relay-tick') relay.tick(e.data);
    }

    status() {
      return {
        site: this.site.label || this.site.name,
        active: this.active(),
        player: Boolean(this.video),
        state: this.state,
        last: this.last
      };
    }
  }

  // Runs inside a shadow-player iframe: reports playback to the page and obeys it. It may
  // be nested a frame deep, so it talks to the top page directly. It holds paused at the
  // requested time until told to play, so it can start instantly.
  function relayChild(site) {
    const ancestors = location.ancestorOrigins;
    const topOrigin = ancestors && ancestors.length ? ancestors[ancestors.length - 1] : '*';
    const post = (msg) => top.postMessage({ elide: 'relay-tick', ...msg }, topOrigin);
    let mode = 'warm';
    let target = null;
    const video = () => site.scan(engine).video;
    const seekNear = (v, t) => {
      if (Math.abs(v.currentTime - t) > 0.5) v.currentTime = t;
    };

    debug('relay child up, top', topOrigin);
    window.addEventListener('message', (e) => {
      if (e.source !== top || (topOrigin !== '*' && e.origin !== topOrigin)) return;
      const d = e.data || {};
      if (d.elide !== 'relay-cmd') return;
      const v = video();
      debug('relay child got', d.cmd, d.t, 'video', Boolean(v));
      if (d.cmd === 'hold') {
        mode = 'hold';
        target = d.t;
        if (v) {
          v.muted = true;
          v.pause();
          seekNear(v, d.t);
        }
      } else if (d.cmd === 'play' && v) {
        mode = 'play';
        seekNear(v, d.t);
        v.playbackRate = d.rate;
        v.volume = d.volume;
        v.muted = d.muted;
        v.play().catch(() => {
          v.muted = true; // autoplay with sound refused: muted content still beats an ad
          v.play().catch(() => {});
        });
      } else if (d.cmd === 'stop' && v) {
        mode = 'stopped';
        v.pause();
      }
    });

    setInterval(() => {
      if (site.relayError?.()) {
        debug('relay child error:', (document.querySelector('.ytp-error')?.innerText || '').replace(/\s+/g, ' ').slice(0, 160), location.href);
        return post({ error: true });
      }
      const scan = site.scan(engine);
      const v = scan.video;
      if (!v) return;
      // Warm: let the embed autoplay (muted) until it has data, then hold it.
      if (mode === 'warm' && v.readyState >= 3) v.muted = true;
      if (mode === 'hold' && target !== null && !v.paused) {
        v.pause();
        seekNear(v, target);
      }
      post({ t: v.currentTime, ready: v.readyState >= 3 && !scan.ad, playing: mode === 'play' && !scan.ad && !v.paused && v.readyState >= 3 });
    }, 150);
  }

  function boot() {
    const site = sites.find((s) => s.match(location));
    if (!site) return;
    if (site.isRelayHost?.()) return site.relayHost();
    engine = new Engine(site);
    globalThis.__elide.engine = engine;

    chrome.storage.local.get(globalThis.ELIDE_DEFAULTS).then((stored) => {
      Object.assign(settings, stored);
      engine.start();
      if (site.isRelayChild?.()) relayChild(site);
    }, () => engine.start());

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [k, c] of Object.entries(changes)) if (k in settings) settings[k] = c.newValue;
      site.onSettings?.(engine, settings);
      engine.schedule();
    });

    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg && msg.type === 'elide:status') reply(engine.status());
      else if (msg && msg.type === 'elide:restore') {
        engine.release(true);
        if (engine.video) {
          engine.video.playbackRate = engine.content.rate || 1;
          if (engine.video.paused) engine.video.play().catch(() => {});
        }
        reply({ ok: true });
      }
    });
  }

  globalThis.__elide = { register: (site) => sites.push(site), boot, settings, shown, send };
})();
