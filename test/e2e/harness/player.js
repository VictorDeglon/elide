// A stand-in for YouTube's player that reproduces the behaviour Elide depends on:
// ads play in the same <video> as the content, #movie_player carries `ad-showing`,
// the skip button appears after a countdown, the rate is reset to 1x for each ad,
// and content resumes where it left off. Modes are picked with ?mode=:
//   preroll midroll pod stitched hard none   client-side behaviours
//   held    like preroll, but the "server" withholds content until the ad's real length
//           has passed, however fast the ad was got through (what YouTube does today)
//   stall   no ad, but content is withheld for ?hold= seconds at startup
//   midheld a mid-roll at ?at= seconds, followed by a server hold
(() => {
  const P = new URLSearchParams(location.search);
  const mode = P.get('mode') || 'preroll';
  const skipAfter = Number(P.get('skip') ?? 5);  // seconds until "Skip" shows; -1 = never
  const midAt = Number(P.get('at') || 4);
  const media = (name) => '/elide-harness/media/' + name;

  const box = document.getElementById('movie_player');
  const video = box.querySelector('video');
  const skipBtn = box.querySelector('.ytp-skip-ad-button');
  const label = box.querySelector('.ytp-ad-text');

  const h = (window.__h = { events: [], mode });
  const log = (type, extra = {}) => h.events.push({ type, t: performance.now(), ...extra });

  let queue = [];
  let inAd = false;
  let resumeAt = 0;
  let midDone = false;
  let skipTimer = 0;
  let adTotal = 0;
  let guardTime = 0;
  let releaseAt = 0; // epoch ms before which the "server" sends no content

  function setAd(on) {
    inAd = on;
    box.classList.toggle('ad-showing', on);
    box.classList.toggle('ad-interrupting', on);
  }

  function load(src, at, then) {
    video.src = src;
    video.play().catch(() => {}); // like YouTube: wants to play while it waits for data
    video.addEventListener('loadedmetadata', () => {
      if (at) video.currentTime = at;
      video.play().catch(() => {});
      then && then();
    }, { once: true });
  }

  function playAd(name) {
    setAd(true);
    label.textContent = `Ad ${adTotal - queue.length} of ${adTotal}`;
    skipBtn.style.display = 'none';
    clearTimeout(skipTimer);
    if (skipAfter === 0) skipBtn.style.display = 'block';
    else if (skipAfter > 0) skipTimer = setTimeout(() => { if (inAd) skipBtn.style.display = 'block'; }, skipAfter * 1000);
    guardTime = 0;
    if (mode === 'held' || mode === 'midheld') releaseAt = Math.max(releaseAt, Date.now() + 15000);
    load(media(name), 0, () => { video.playbackRate = 1; });
    log('ad-start', { name });
  }

  function playContent(at) {
    setAd(false);
    skipBtn.style.display = 'none';
    clearTimeout(skipTimer);
    log('content-start', { at });
    const src = releaseAt > Date.now() ? media('content.webm?release=' + releaseAt) : media('content.webm');
    load(src, at, () => {
      video.requestVideoFrameCallback(() => log('content-frame', { time: video.currentTime }));
    });
  }

  function startBreak(ads) {
    if (!inAd) resumeAt = video.currentTime || 0;
    queue = ads.slice();
    adTotal = ads.length;
    log('break-start', { resumeAt });
    next();
  }

  function next() {
    const ad = queue.shift();
    if (ad) playAd(ad);
    else playContent(resumeAt);
  }

  video.addEventListener('ended', () => {
    if (!inAd) return log('content-ended');
    log('ad-ended', { by: 'end' });
    next();
  });

  skipBtn.addEventListener('click', () => {
    if (!inAd) return;
    log('ad-ended', { by: 'skip' });
    next();
  });

  video.addEventListener('timeupdate', () => {
    if ((mode === 'midroll' || mode === 'midheld') && !inAd && !midDone && video.currentTime >= midAt) {
      midDone = true;
      startBreak(['ad15.webm']);
    }
    if (mode === 'stitched' && inAd && video.currentTime >= 15) {
      setAd(false);
      log('content-start', { at: 15 });
      video.requestVideoFrameCallback(() => log('content-frame', { time: video.currentTime }));
    }
    if (mode === 'hard' && inAd) guardTime = video.currentTime;
  });

  // "hard" ads fight back: seeks are reverted and the rate is pinned to 1x.
  if (mode === 'hard') {
    video.addEventListener('seeking', () => {
      if (inAd && video.currentTime > guardTime + 1) {
        log('seek-reverted');
        video.currentTime = guardTime;
      }
    });
    video.addEventListener('ratechange', () => {
      if (inAd && video.playbackRate !== 1) video.playbackRate = 1;
    });
  }

  if (mode === 'preroll' || mode === 'hard' || mode === 'held') startBreak(['ad15.webm']);
  else if (mode === 'stall') {
    releaseAt = Date.now() + Number(P.get('hold') || 9) * 1000;
    playContent(0);
  }
  else if (mode === 'pod') startBreak(['ad15.webm', 'ad8.webm']);
  else if (mode === 'stitched') {
    setAd(true);
    log('break-start', { resumeAt: 0 });
    log('ad-start', { name: 'stitched' });
    load(media('stitched.webm'), 0);
  } else playContent(0);
})();
