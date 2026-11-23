import test from 'node:test';
import assert from 'node:assert/strict';

import { parseChannelList } from '../lib/channels.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { Upstream } from '../lib/upstream.js';

test('parses extinf attributes, groups, provider ids and headers', () => {
  const text = `#EXTM3U
#EXTINF:-1 tvg-id="btv-national" tvg-name="BTV National" tvg-logo="https://logo/btv.png" group-title="Bangla",BTV National
#EXTVLCOPT:http-user-agent=okhttp/4.9.3
#EXTVLCOPT:http-referrer=https://example.com/
high://101
#EXTINF:-1 tvg-id="deepto" group-title="Bangla",Deepto TV
https://cdn.example/live/high/deepto.m3u8
#EXTINF:-1 tvg-id="templated",Templated
https://cdn.example/{id}/master.m3u8
#EXTINF:-1 tvg-id="bare-id",Bare
205
`;
  const { channels, duplicates } = parseChannelList(text);
  assert.equal(channels.length, 4);
  assert.equal(duplicates.length, 0);

  const [first, second, third, fourth] = channels;
  assert.equal(first.id, 'btv-national');
  assert.equal(first.providerId, '101');
  assert.equal(first.group, 'Bangla');
  assert.equal(first.headers['user-agent'], 'okhttp/4.9.3');
  assert.equal(first.headers.referer, 'https://example.com/');
  assert.equal(first.customUrl, null);

  assert.equal(second.customUrl, 'https://cdn.example/live/high/deepto.m3u8');
  assert.equal(third.customUrl, 'https://cdn.example/{id}/master.m3u8');
  assert.equal(third.providerId, 'templated');
  assert.equal(fourth.providerId, '205');
});

test('ids are URL-safe, unique and fall back to slugs', () => {
  const text = `#EXTM3U
#EXTINF:-1 tvg-id="Sony SAB (Bangla)",Sony SAB
high://1
#EXTINF:-1 tvg-id="Sony SAB (Bangla)",Duplicate
high://2
#EXTINF:-1,Sony SAB
https://cdn.example/sony-sab.m3u8
`;
  const { channels, duplicates } = parseChannelList(text);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].id, 'Sony-SAB-Bangla');
  assert.equal(duplicates.length, 1);
  assert.equal(channels[1].id, 'sony-sab');
});

test('repo channel list is complete and Bangla first', async () => {
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(new URL('../channels.m3u', import.meta.url), 'utf8');
  const { channels } = parseChannelList(text);
  assert.ok(channels.length >= 100, `expected 100+ channels, got ${channels.length}`);
  assert.equal(channels[0].group, 'Bangla Entertainment');
  assert.ok(new Set(channels.map((channel) => channel.id)).size === channels.length);
  assert.ok(channels.every((channel) => channel.id && channel.name && channel.group));
  assert.ok(channels.every((channel) => !channel.customUrl || /^https?:\/\//.test(channel.customUrl)));
});

test('config defaults are high-only, redirect-mode and fast', () => {
  const config = loadConfig({});
  assert.equal(config.segmentMode, 'redirect');
  assert.equal(config.allowAutoFallback, true);
  assert.equal(config.upstreamHighPath, '/live/high/{id}.m3u8');
  assert.ok(config.warmerIntervalMs <= 2000);
  assert.ok(config.cacheTtlMs >= 1000);
  assert.ok(config.urlSecret.length >= 16);
  assert.equal(config.playlistQuality, 'high');

  const configured = loadConfig({
    PORT: '8080',
    SEGMENT_MODE: 'proxy',
    WARMER_INTERVAL_MS: '1500',
    UPSTREAM_BASE: 'http://jio:8080/',
  });
  assert.equal(configured.port, 8080);
  assert.equal(configured.segmentMode, 'proxy');
  assert.equal(configured.warmerIntervalMs, 1500);
  assert.equal(configured.upstreamBase, 'http://jio:8080');
});

test('invalid segment mode falls back to redirect', () => {
  assert.equal(loadConfig({ SEGMENT_MODE: 'raw' }).segmentMode, 'redirect');
});

test('upstream URLs are high-only, even for hand-written channel URLs', () => {
  const upstream = new Upstream(loadConfig({ UPSTREAM_BASE: 'http://up:8080' }), createLogger({ level: 'error' }));
  assert.equal(upstream.masterUrl({ id: 'x', providerId: '101' }, 'high'), 'http://up:8080/live/high/101.m3u8');
  assert.equal(upstream.masterUrl({ id: 'x', providerId: '101' }, 'auto'), 'http://up:8080/live/101.m3u8');
  assert.equal(upstream.masterUrl({ id: 'a', customUrl: 'http://cdn/live/low/123.m3u8' }, 'high'), 'http://cdn/live/high/123.m3u8');
  assert.equal(upstream.masterUrl({ id: 'b', customUrl: 'http://cdn/live/medium/9.m3u8?q=1' }, 'high'), 'http://cdn/live/high/9.m3u8?q=1');
  assert.equal(upstream.masterUrl({ id: 'c', customUrl: 'http://cdn/live/high/9.m3u8' }, 'high'), 'http://cdn/live/high/9.m3u8');
  assert.equal(upstream.masterUrl({ id: 'd', customUrl: 'https://cdn.example/{id}/master.m3u8', providerId: '55' }, 'high'), 'https://cdn.example/55/master.m3u8');
});
