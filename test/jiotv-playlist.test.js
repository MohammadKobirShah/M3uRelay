import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { parseChannelList } from '../lib/channels.js';
import { banglaChannelName, banglaGroupName } from '../lib/bangla.js';
import { Upstream } from '../lib/upstream.js';

/**
 * A trimmed copy of a real JioTV-Go `/playlist.m3u?q=high` export:
 * EPG header, tvg-type, KODIPROP (Widevine) blocks for DRM channels,
 * /live/mpd/<id>?q=high URLs, and plain /live/high/<id>.m3u8 for the rest.
 */
const PLAYER = buffer => buffer.toString();

const JIOTV = `#EXTM3U x-tvg-url="https://tv.example.test/epg.xml.gz"
#EXTINF:-1 tvg-id="143" tvg-name="CNBC TV18 Prime" tvg-logo="https://tv.example.test/jtvimage/CNBCTV18Prime1.png" tvg-language="English" tvg-type="Business" group-title="Business", CNBC TV18 Prime
#KODIPROP:inputstream=inputstream.adaptive
#KODIPROP:inputstream.adaptive.manifest_type=mpd
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://tv.example.test/live/key/143?q=high
https://tv.example.test/live/mpd/143?q=high
#EXTINF:-1 tvg-id="182" tvg-name="Colors HD" tvg-logo="https://tv.example.test/jtvimage/ColorsHD1.png" tvg-language="Hindi" tvg-type="Entertainment" group-title="Entertainment", Colors HD
https://tv.example.test/live/high/182.m3u8
#EXTINF:-1 tvg-id="151" tvg-name="Movies Now HD" tvg-logo="https://tv.example.test/jtvimage/Movies_Now_HD.png" tvg-language="English" tvg-type="Movies" group-title="Movies", Movies Now HD
https://tv.example.test/live/high/151.m3u8
#EXTINF:-1 tvg-id="999" tvg-name="Somoy TV" tvg-language="Bengali" tvg-type="News" group-title="News", Somoy TV
https://tv.example.test/live/high/999.m3u8
`;

test('a real JioTV-Go playlist parses as-is', () => {
  const { channels, duplicates } = parseChannelList(PLAYER(Buffer.from(JIOTV)), {
    defaultGroup: 'Other',
    baseUrl: 'https://tv.example.test/playlist.m3u?q=high',
  });
  assert.equal(channels.length, 4);
  assert.equal(duplicates.length, 0);

  const cnbc = channels[0];
  assert.equal(cnbc.id, '143');
  assert.equal(cnbc.name, 'CNBC TV18 Prime');
  assert.equal(cnbc.group, 'Business');
  assert.equal(cnbc.dash, true);
  assert.equal(cnbc.dashId, '143');
  assert.match(cnbc.customUrl, /\/live\/mpd\/143\?q=high$/);
  assert.equal(cnbc.logo, 'https://tv.example.test/jtvimage/CNBCTV18Prime1.png');

  const colors = channels[1];
  assert.equal(colors.dash, false);
  assert.equal(colors.customUrl, 'https://tv.example.test/live/high/182.m3u8');
});

test('DASH entries are mapped to their HLS twin', () => {
  const upstream = new Upstream({ dashToHls: true, highFirstCustomUrls: true, allowAutoFallback: true });
  const channel = { id: '143', customUrl: 'https://tv.example.test/live/mpd/143?q=high', dash: true };
  assert.deepEqual(upstream.customUrlCandidates(channel), ['https://tv.example.test/live/high/143.m3u8']);
  assert.equal(upstream.masterUrl(channel, 'high'), 'https://tv.example.test/live/high/143.m3u8');

  const disabled = new Upstream({ dashToHls: false, highFirstCustomUrls: true, allowAutoFallback: true });
  assert.deepEqual(disabled.customUrlCandidates(channel), []);
});

test('every JioTV-Go group title has a Bangla label', () => {
  for (const group of [
    'News',
    'Entertainment',
    'Devotional',
    'Educational',
    'Music',
    'Movies',
    'Kids',
    'Infotainment',
    'Lifestyle',
    'Sports',
    'Business',
    'Shopping',
  ]) {
    assert.ok(banglaGroupName(group), `no Bangla label for ${group}`);
  }
});

test('common JioTV-Go channel names get Bangla names', () => {
  for (const [name, bn] of [
    ['Somoy TV', 'সময় টিভি'],
    ['Colors HD', 'কালারস'],
    ['Movies Now HD', 'মুভিজ নাউ'],
    ['CNBC TV18 Prime', 'সিএনবিসি টিভি ১৮ প্রাইম'],
    ['Zee Telugu', 'জি তেলুগু'],
    ['News18 Marathi', 'নিউজ ১৮ মারাঠি'],
    ['Sansad TV', 'সংসদ টিভি'],
    ['DD India', 'ডিডি ইন্ডিয়া'],
    ['Sony Ten 5 HD', 'সনি টেন ৫'],
  ]) {
    assert.equal(banglaChannelName(name), bn, name);
  }
  // Nothing is invented for names we do not know.
  assert.equal(banglaChannelName('Random Channel 42'), null);
});

test('the shipped channels.m3u is HLS-only', async () => {
  const text = await fs.readFile(new URL('../channels.m3u', import.meta.url), 'utf8');
  const { channels } = parseChannelList(text, { defaultGroup: 'Other' });
  assert.ok(channels.length >= 100, `expected a full channel list, got ${channels.length}`);
  assert.equal(channels.filter((channel) => channel.dash).length, 0, 'no DASH entries left');
  const notHls = channels.filter(
    (channel) => !channel.customUrl || !/^https?:\/\/[^/]+\/live\/high\/[^/?#]+\.m3u8/i.test(channel.customUrl),
  );
  assert.deepEqual(notHls.map((channel) => channel.name), [], 'every stream URL must be /live/high/<id>.m3u8');
  assert.ok(channels.every((channel) => channel.group && channel.logo !== undefined));
});
