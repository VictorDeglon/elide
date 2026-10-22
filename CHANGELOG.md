# Changelog

## 1.0.0 (2026-10-22)

First release as Elide, rebuilt from scratch as the successor to AdRush 2.0.

- **Curtain.** The last content frame covers the player the moment an ad starts, and the ad is muted. Pixel-checked in tests: no ad frame reaches the screen.
- **Cut.** Uses the site's skip button, then seek-to-end where the player allows it (about 70× on IMA, video.js and JW Player), then 16×, Chromium's real ceiling. AdRush's 20× setting could never take effect.
- **Relay.** A shadow copy of the video (YouTube's ad-free embed player) warms up when a video opens and about 20 s before scheduled mid-rolls. It plays the content while YouTube holds the main player back, and the main player then takes over at the shadow's position.
- **Prevent (optional).** Strips YouTube ad schedules from inline data, `fetch` and `JSON.parse`. Off by default, because YouTube currently answers it with startup holds.
- **Sites.** YouTube (watch, Music, mobile, embeds, Shorts, feed and overlay ads), Twitch (curtain over stitched breaks), any site using Google IMA, video.js or JW Player (opt-in), and Hulu (experimental, untested).
- **Safety.** Never seeks media that looks like the video itself. Stops fighting players that keep resetting the rate. Restores your speed, volume and mute state after every break.
- **Tests.** Stand-in YouTube player with pixel checks, real Google IMA SDK, and live youtube.com measurements.
