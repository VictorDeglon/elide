// Generates extension/rules/shield.json: the network shield's static ruleset.
// Ad-serving and ad-verification hosts, blocked for every initiator except the sites
// Elide handles in-page (blocking their ad pings there invites anti-adblock checks).
import { writeFileSync } from 'node:fs';

const BLOCK = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'amazon-adsystem.com', 'adnxs.com', 'adsrvr.org', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net',
  'casalemedia.com', 'indexww.com', 'moatads.com', 'adform.net', 'smartadserver.com',
  'teads.tv', 'spotxchange.com', 'spotx.tv', 'springserve.com', 'sharethrough.com',
  '33across.com', 'yieldmo.com', 'bidswitch.net', 'serving-sys.com', 'flashtalking.com',
  'innovid.com', 'adcolony.com', 'media.net', 'zedo.com', 'revcontent.com', 'mgid.com'
];
const SPARE = ['youtube.com', 'youtube-nocookie.com', 'twitch.tv', 'hulu.com'];

const rules = [{
  id: 1,
  priority: 1,
  action: { type: 'block' },
  condition: {
    requestDomains: BLOCK,
    excludedInitiatorDomains: SPARE,
    resourceTypes: ['script', 'xmlhttprequest', 'sub_frame', 'image', 'media', 'ping', 'other']
  }
}];

writeFileSync(new URL('../extension/rules/shield.json', import.meta.url), JSON.stringify(rules, null, 2) + '\n');
console.log(`shield.json: ${BLOCK.length} hosts`);
