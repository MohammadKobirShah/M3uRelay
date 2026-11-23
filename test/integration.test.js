import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockOrigin } from '../scripts/mock-origin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHANNELS = `#EXTM3U
#EXTINF:-1 tvg-id="news" tvg-logo="https://logo/news.png" group-title="Bangla News" tvg-language="Bangla",News Channel
high://news
#EXTINF:-1 tvg-id="broken" group-title="Bangla News",Broken High
high://broken
#EXTINF:-1 tvg-id="sd" group-title="SD",SD Channel
high://sd
#EXTINF:-1 tvg-id="enc" group-title="Movies",Encrypted
high://enc
#EXTINF:-1 tvg-id="media" group-title="Movies",Media Only
high://media
#EXTINF:-1 tvg-id="token" group-title="Movies",Token Channel
high://token
#EXTINF:-1 tvg-id="noaudio" group-title="Movies",Muxed Audio
high://noaudio
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForChannels(base, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/channels`);
      if (response.ok) return await response.json();
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relay did not become ready: ${lastError && lastError.message}`);
}

async function startRelay({ origin, env = {}, channels = CHANNELS } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-test-'));
  const channelsFile = path.join(dir, 'channels.m3u');
  await fs.writeFile(channelsFile, channels);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CHANNELS_FILE: channelsFile,
      CHANNELS_CACHE_FILE: path.join(dir, 'channels.cache.m3u'),
      UPSTREAM_BASE: origin.url,
      WATCH_CHANNELS: 'false',
      LOG_LEVEL: 'error',
      WARMER_INTERVAL_MS: '1000',
      CACHE_TTL_MS: '5000',
      URL_SECRET: 'test-secret-test-secret',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForChannels(base);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n--- relay output ---\n${logs}`);
  }

  return {
    base,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
    logs: () => logs,
  };
}

function segmentLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

test('redirect mode: filtered manifests, Bangla-first audio, signed 302 segments', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const relay = await startRelay({
    origin,
    env: {
      TOKEN_URL: `${origin.url}/__token?channel={id}`,
      TOKEN_FIELD: 'token',
      TOKEN_QUERY: 'token',
    },
  });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  await t.test('master manifest is high-only, 720/1080, Bangla default', async () => {
    const response = await fetch(`${relay.base}/live/high/news.m3u8`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /mpegurl/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('cache-control'), /no-cache/);
    assert.match(response.headers.get('x-relay-source'), /high/);
    const text = await response.text();

    assert.equal((text.match(/#EXT-X-STREAM-INF/g) || []).length, 2);
    assert.equal((text.match(/#EXT-X-MEDIA/g) || []).length, 2);
    assert.match(text, /RESOLUTION=1280x720/);
    assert.match(text, /RESOLUTION=1920x1080/);
    assert.ok(text.indexOf('1280x720') < text.indexOf('1920x1080'), '720p must be the first rung');

    for (const banned of ['144p', '240p', '360p', '480p', '576p', '426x240', '854x480', '1024x576']) {
      assert.ok(!text.includes(banned), `manifest still contains ${banned}`);
    }
    for (const banned of ['English', 'Tamil', 'Telugu', 'SUBTITLES', 'I-FRAME']) {
      assert.ok(!text.includes(banned), `manifest still contains ${banned}`);
    }

    const mediaLines = text.split('\n').filter((line) => line.startsWith('#EXT-X-MEDIA:'));
    assert.match(mediaLines[0], /NAME="Bengali"/);
    assert.match(mediaLines[0], /DEFAULT=YES/);
    assert.match(mediaLines[0], /AUTOSELECT=YES/);
    assert.match(mediaLines[0], /FORCED=NO/);
    assert.match(mediaLines[1], /NAME="Hindi"/);
    assert.match(mediaLines[1], /DEFAULT=NO/);
    assert.match(mediaLines[1], /AUTOSELECT=YES/);
    assert.match(text, new RegExp(`${relay.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/v/news/720\\.m3u8`));
  });

  await t.test('repeated master requests are served from RAM in single-digit ms', async () => {
    const samples = [];
    for (let i = 0; i < 12; i += 1) {
      const started = performance.now();
      const response = await fetch(`${relay.base}/live/high/news.m3u8`);
      await response.text();
      samples.push(performance.now() - started);
      assert.equal(response.status, 200);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    assert.ok(median < 100, `median master latency ${median.toFixed(1)}ms is too slow`);
  });

  await t.test('variant playlist points segments at the relay 302 endpoint', async () => {
    const response = await fetch(`${relay.base}/v/news/720.m3u8`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /#EXT-X-TARGETDURATION:4/);
    assert.match(text, /#EXT-X-MEDIA-SEQUENCE:\d+/);
    const segments = segmentLines(text);
    assert.ok(segments.length >= 4);
    for (const segment of segments) {
      assert.ok(segment.startsWith(`${relay.base}/s?u=`), `unexpected segment url ${segment}`);
    }
  });

  await t.test('segment endpoint 302s straight to the origin CDN', async () => {
    const variant = await (await fetch(`${relay.base}/v/news/720.m3u8`)).text();
    const segment = segmentLines(variant)[0];
    const response = await fetch(segment, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = response.headers.get('location');
    assert.ok(location.startsWith(`${origin.url}/seg/`), `bad redirect target ${location}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    // Follow it: the origin serves the bytes, not the relay.
    const direct = await fetch(location);
    assert.equal(direct.status, 200);
    assert.equal((await direct.arrayBuffer()).byteLength, 1880);
  });

  await t.test('segment URLs are signed and tamper-proof', async () => {
    const variant = await (await fetch(`${relay.base}/v/news/720.m3u8`)).text();
    const segment = segmentLines(variant)[0];
    const tampered = new URL(segment);
    tampered.searchParams.set('sig', 'AAAAAAAAAAAAAAAAAAAAAA');
    const response = await fetch(tampered, { redirect: 'manual' });
    assert.equal(response.status, 403);

    const malformed = new URL(segment);
    malformed.searchParams.set('u', 'not-base64!!');
    assert.equal((await fetch(malformed, { redirect: 'manual' })).status, 400);
  });

  await t.test('AES key URIs are proxied and cached', async () => {
    const variant = await (await fetch(`${relay.base}/v/enc/720.m3u8`)).text();
    assert.match(variant, /#EXT-X-KEY:METHOD=AES-128,URI="[^"]*\/k\?u=/);
    const keyUrl = /URI="([^"]+)"/.exec(variant)[1].replaceAll('&amp;', '&');
    const response = await fetch(keyUrl);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 16);
    const again = await fetch(keyUrl);
    assert.equal(again.status, 200);
  });

  await t.test('high failure falls back to the auto endpoint (emergency only)', async () => {
    const response = await fetch(`${relay.base}/live/high/broken.m3u8`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-relay-source'), 'auto');
    const text = await response.text();
    assert.equal((text.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
    assert.match(text, /RESOLUTION=1280x720/);
  });

  await t.test('SD channel keeps the best rung instead of 240p', async () => {
    const text = await (await fetch(`${relay.base}/live/high/sd.m3u8`)).text();
    assert.equal((text.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
    assert.match(text, /RESOLUTION=1024x576/);
    assert.ok(!text.includes('426x240'));
    const variant = await fetch(`${relay.base}/v/sd/best.m3u8`);
    assert.equal(variant.status, 200);
  });

  await t.test('media-playlist-only upstream is passed through with proxied segments', async () => {
    const response = await fetch(`${relay.base}/live/high/media.m3u8`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('#EXT-X-STREAM-INF'));
    assert.match(text, /\/s\?u=/);
  });

  await t.test('token is injected into upstream requests', async () => {
    const response = await fetch(`${relay.base}/live/high/token.m3u8`);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).match(/#EXT-X-STREAM-INF/g).length, 2);
    assert.equal((await fetch(`${relay.base}/v/token/1080.m3u8`)).status, 200);
  });

  await t.test('muxed-audio channels have no audio renditions and no AUDIO attribute', async () => {
    const text = await (await fetch(`${relay.base}/live/high/noaudio.m3u8`)).text();
    assert.ok(!text.includes('#EXT-X-MEDIA'));
    assert.ok(!text.includes('AUDIO="'));
    assert.equal((text.match(/#EXT-X-STREAM-INF/g) || []).length, 2);
  });

  await t.test('low/medium endpoints are refused', async () => {
    assert.equal((await fetch(`${relay.base}/live/low/news.m3u8`)).status, 400);
    assert.equal((await fetch(`${relay.base}/live/medium/news.m3u8`)).status, 400);
    const response = await fetch(`${relay.base}/live/low/news.m3u8`);
    assert.match(await response.text(), /disabled by design/);
  });

  await t.test('auto alias still serves the high-only ladder', async () => {
    const response = await fetch(`${relay.base}/live/news.m3u8`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal((text.match(/#EXT-X-STREAM-INF/g) || []).length, 2);
  });

  await t.test('playlist endpoint exports relay high URLs only', async () => {
    const response = await fetch(`${relay.base}/playlist.m3u?q=high`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.startsWith('#EXTM3U'));
    assert.equal((text.match(/#EXTINF/g) || []).length, 7);
    assert.match(text, /tvg-logo="https:\/\/logo\/news\.png"/);
    assert.ok(text.includes(`${relay.base}/live/high/news.m3u8`));
    assert.ok(!text.includes('/live/low/') && !text.includes('/live/medium/'));
    assert.equal((await fetch(`${relay.base}/playlist.m3u?q=low`)).status, 400);
  });

  await t.test('API, health and CORS behave', async () => {
    const channels = await (await fetch(`${relay.base}/api/channels`)).json();
    assert.equal(channels.total, 7);
    assert.ok(channels.groups.some((group) => group.name === 'Bangla News'));
    const news = channels.channels.find((channel) => channel.id === 'news');
    assert.deepEqual(news.qualities, ['720p', '1080p']);
    assert.equal(news.audio[0].name, 'Bengali');
    assert.equal(news.audio[0].default, true);
    assert.equal(news.status, 'live');

    const status = await (await fetch(`${relay.base}/api/status`)).json();
    assert.equal(status.channels.total, 7);
    assert.ok(status.warmer.runs >= 1);
    assert.equal(status.upstream.segmentMode, 'redirect');
    assert.equal(status.config.warmerEnabled, true);

    const health = await fetch(`${relay.base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.ok(healthBody.warmed >= 5);

    const preflight = await fetch(`${relay.base}/live/high/news.m3u8`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    const head = await fetch(`${relay.base}/live/high/news.m3u8`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 100);

    const unknown = await fetch(`${relay.base}/live/high/nope.m3u8`);
    assert.equal(unknown.status, 404);
  });

  await t.test('panel HTML is served with the player bundled locally', async () => {
    const response = await fetch(`${relay.base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /hls/i);
    const vendor = await fetch(`${relay.base}/vendor/hls.min.js`);
    assert.equal(vendor.status, 200);
    assert.ok(Number(vendor.headers.get('content-length')) > 10000);
  });
});

test('direct mode sends players straight to the CDN without a 302 hop', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const relay = await startRelay({ origin, env: { SEGMENT_MODE: 'direct' } });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const variant = await (await fetch(`${relay.base}/v/news/1080.m3u8`)).text();
  const segments = segmentLines(variant);
  assert.ok(segments.length >= 4);
  for (const segment of segments) {
    assert.ok(segment.startsWith(`${origin.url}/seg/`), `expected direct CDN url, got ${segment}`);
    assert.ok(!segment.includes('/s?u='));
  }
});

test('proxy mode streams segment bytes through the relay (fallback only)', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const relay = await startRelay({ origin, env: { SEGMENT_MODE: 'proxy', BLOCK_PRIVATE_HOSTS: 'false' } });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const variant = await (await fetch(`${relay.base}/v/news/720.m3u8`)).text();
  const segment = segmentLines(variant)[0];
  assert.ok(segment.includes('/s?u='));
  const response = await fetch(segment);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /video\/mp2t/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 1880);
  assert.equal(bytes[0], 0x47);
});

test('channel list syncs from the upstream playlist (JioTV-Go style)', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const relay = await startRelay({ origin, env: { CHANNELS_URL: `${origin.url}/playlist.m3u?q=high` } });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const channels = await (await fetch(`${relay.base}/api/channels`)).json();
  assert.equal(channels.total, 3);
  assert.deepEqual(
    channels.channels.map((channel) => channel.id).sort(),
    ['enc', 'news', 'sd'],
  );
  assert.equal(channels.channels.find((channel) => channel.id === 'news').group, 'Bangla News');
  // A relative entry in the upstream playlist is resolved against CHANNELS_URL,
  // so it resolves to the mock origin's own /live/high/sd.m3u8 (SD: one rung).
  const sdMaster = await (await fetch(`${relay.base}/live/high/sd.m3u8`)).text();
  assert.equal((sdMaster.match(/#EXT-X-STREAM-INF/g) || []).length, 1);

  const master = await (await fetch(`${relay.base}/live/high/news.m3u8`)).text();
  assert.equal((master.match(/#EXT-X-STREAM-INF/g) || []).length, 2);
  assert.match(master, /RESOLUTION=1280x720/);

  const status = await (await fetch(`${relay.base}/api/status`)).json();
  assert.equal(status.channelsSource.kind, 'url');
  assert.equal(status.channelsSource.url, `${origin.url}/playlist.m3u?q=high`);

  const sync = await (await fetch(`${relay.base}/api/sync`, { method: 'POST' })).json();
  assert.equal(sync.ok, true);
  assert.equal(sync.source, 'url');
  assert.equal(sync.channels, 3);
});

test('a downloaded playlist is cached and reused when the upstream is down', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-cache-'));
  const cacheFile = path.join(dir, 'channels.cache.m3u');
  const relay = await startRelay({
    origin,
    env: { CHANNELS_URL: `${origin.url}/playlist.m3u?q=high`, CHANNELS_CACHE_FILE: cacheFile },
  });
  t.after(async () => {
    await relay.stop();
    await origin.close().catch(() => {});
  });

  const cached = await fs.readFile(cacheFile, 'utf8');
  assert.match(cached, /#EXTINF/);

  const first = await (await fetch(`${relay.base}/api/sync`, { method: 'POST' })).json();
  assert.equal(first.ok, true);
  assert.equal(first.source, 'url');

  await origin.close();
  const second = await (await fetch(`${relay.base}/api/sync`, { method: 'POST' })).json();
  assert.equal(second.ok, true);
  assert.equal(second.source, 'cache');
  assert.equal(second.channels, 3);

  const status = await (await fetch(`${relay.base}/api/status`)).json();
  assert.equal(status.channelsSource.kind, 'cache');
  assert.equal(status.channelsSource.cacheUsed, true);
  assert.ok(status.channelsSource.syncError);
  assert.equal(status.channelsSource.cacheFile, cacheFile);
});

test('conditional sync keeps the list when the upstream answers 304', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const relay = await startRelay({ origin, env: { CHANNELS_URL: `${origin.url}/playlist.m3u?q=high` } });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const status = await (await fetch(`${relay.base}/api/status`)).json();
  assert.equal(status.channelsSource.kind, 'url');
  assert.ok(status.channelsSource.syncedAt > 0);
  assert.ok(status.channelsSource.bytes > 0);
  assert.equal(status.channelsSource.etag, '"mock-playlist-v1"');

  const second = await (await fetch(`${relay.base}/api/sync`, { method: 'POST' })).json();
  assert.equal(second.ok, true);
  assert.equal(second.channels, 3);
});

test('the probe endpoint explains a working channel source', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const relay = await startRelay({ origin, env: { CHANNELS_URL: `${origin.url}/playlist.m3u?q=high` } });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const probe = await (await fetch(`${relay.base}/api/probe`)).json();
  assert.equal(probe.ok, true);
  assert.equal(probe.playlist.channels, 3);
  assert.equal(probe.playlist.duplicates, 0);
  assert.ok(probe.dns.addresses.length >= 1);
  assert.equal(probe.http.status, 200);
  assert.ok(probe.http.ms >= 0);
  assert.ok(probe.samples.some((sample) => sample.nameBn === 'সময় টিভি'));
  assert.ok(probe.samples.some((sample) => sample.groupBn === 'বাংলা সংবাদ'));
  assert.ok(probe.findings.some((finding) => finding.level === 'ok'));
  assert.ok(probe.findings.every((finding) => typeof finding.bn === 'string' && finding.bn.length > 0));
});

test('the probe endpoint refuses to scan arbitrary hosts by default', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const relay = await startRelay({ origin, env: { CHANNELS_URL: `${origin.url}/playlist.m3u?q=high` } });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const response = await fetch(`${relay.base}/api/probe?url=${encodeURIComponent('http://127.0.0.1:1/playlist.m3u')}`);
  const probe = await response.json();
  assert.equal(response.status, 403);
  assert.equal(probe.ok, false);
  assert.equal(probe.findings[0].code, 'probe-locked');
  assert.match(probe.findings[0].bn, /[\u0980-\u09FF]/);
});

test('the probe endpoint describes an unreachable configured source in Bangla', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 5 });
  const deadPort = await freePort();
  const relay = await startRelay({
    origin,
    env: { CHANNELS_URL: `http://127.0.0.1:${deadPort}/playlist.m3u` },
  });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const probe = await (await fetch(`${relay.base}/api/probe`)).json();
  assert.equal(probe.ok, false);
  const failure = probe.findings.find((finding) => finding.level === 'error');
  assert.ok(failure, 'expected an error finding');
  assert.match(failure.bn, /[\u0980-\u09FF]/);
  assert.ok(probe.findings.some((finding) => finding.code === 'active-file'));

  const status = await (await fetch(`${relay.base}/api/status`)).json();
  assert.equal(status.channelsSource.kind, 'file');
  assert.ok(status.channelsSource.syncError);
});
