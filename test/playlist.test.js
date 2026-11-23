import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlaylist, playlistEtag, PlaylistFile } from '../lib/playlist.js';
import { Relay } from '../lib/relay.js';
import { loadConfig } from '../lib/config.js';
import { startMockOrigin } from '../scripts/mock-origin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHANNELS = `#EXTM3U
#EXTINF:-1 tvg-id="news" tvg-logo="https://logo/news.png" group-title="Bangla News" tvg-language="Bangla",Somoy TV
high://news
#EXTINF:-1 tvg-id="movies" group-title="Bangla Movies" tvg-language="Bangla",Deepto TV
high://movies
#EXTINF:-1 tvg-id="sports" group-title="Sports" tvg-language="Hindi",Star Sports 1 Hindi
high://sports
`;

const SAMPLE = [
  { id: 'news', name: 'Somoy TV', group: 'Bangla News', language: 'Bangla', logo: 'https://logo/n.png', order: 0 },
  { id: 'movies', name: 'Deepto TV', group: 'Bangla Movies', language: 'Bangla', order: 1 },
];

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('buildPlaylist renders a player-ready M3U with absolute relay URLs', () => {
  const text = buildPlaylist(SAMPLE, { origin: 'https://relay.example/', updatedAt: Date.UTC(2026, 10, 23, 10, 0, 0) });
  const lines = text.trimEnd().split('\n');

  assert.equal(lines[0], '#EXTM3U');
  assert.match(lines[1], /^# MY IPTV PRO — 2 channels · updated 2026-11-23T10:00:00.000Z$/);
  assert.equal(lines.filter((line) => line.startsWith('#EXTINF')).length, 2);
  assert.match(lines[3], /^#EXTINF:-1 tvg-id="news" tvg-name="Somoy TV" tvg-logo="https:\/\/logo\/n.png" group-title="Bangla News" tvg-language="Bangla" tvg-chno="1",Somoy TV$/);
  assert.equal(lines[4], 'https://relay.example/live/high/news.m3u8');
  assert.equal(lines[6], 'https://relay.example/live/high/movies.m3u8');
  // trailing slash of the origin is normalised away, newline at EOF for players
  assert.ok(!text.includes('example//'), 'origin must not keep a trailing slash');
  assert.ok(text.endsWith('\n'));
});

test('buildPlaylist escapes quotes, never leaks a raw & and skips empty fields', () => {
  const text = buildPlaylist(
    [{ id: 'a b&c', name: 'Tom & Jerry "HD"', group: 'Kids & Fun', language: '', logo: '', order: 4 }],
    { origin: 'http://relay.local' },
  );
  const extinf = text.split('\n').find((line) => line.startsWith('#EXTINF'));
  assert.match(extinf, /tvg-id="a b&amp;c"/, 'ids/labels are escaped');
  assert.match(extinf, /tvg-name="Tom &amp; Jerry &quot;HD&quot;"/);
  assert.match(extinf, /group-title="Kids &amp; Fun"/);
  assert.match(extinf, /tvg-chno="5"/);
  assert.ok(!extinf.includes('tvg-language'), 'empty language attribute should be dropped');
  assert.ok(!extinf.includes('tvg-logo'), 'empty logo attribute should be dropped');
  assert.ok(text.includes('/live/high/a%20b%26c.m3u8'), 'channel ids must be URL-encoded');
  // the display title is plain text: players show it literally
  assert.ok(extinf.endsWith(',Tom & Jerry "HD"'), extinf);
});

test('buildPlaylist never lets a newline split a channel in two', () => {
  const text = buildPlaylist([
    { id: 'x', name: 'Line\nBreak\r\nTV\u0007', group: 'G', order: 0 },
    { id: 'y', name: '', order: 1 },
  ], { origin: 'http://r' });
  assert.equal((text.match(/#EXTINF/g) || []).length, 2);
  assert.ok(text.includes(',Line Break TV'), text);
  assert.ok(!text.includes('\u0007'));
  assert.ok(text.includes(',y\n'), 'a nameless channel falls back to its id');
  assert.equal(text.split('\n').filter((line) => line && !line.startsWith('#')).length, 2);
});

test('buildPlaylist handles an empty list and a missing origin', () => {
  const text = buildPlaylist([], {});
  assert.equal(text.split('\n')[0], '#EXTM3U');
  assert.equal(text.split('\n').filter((line) => line.startsWith('#EXTINF')).length, 0);
  assert.equal(buildPlaylist([], {}).match(/live\/high/g), null);
});

test('playlistEtag changes whenever the rendered playlist changes', () => {
  const a = playlistEtag(SAMPLE, { origin: 'http://a', updatedAt: 1000 });
  assert.equal(a, playlistEtag(SAMPLE, { origin: 'http://a', updatedAt: 1000 }));
  assert.notEqual(a, playlistEtag(SAMPLE, { origin: 'http://a', updatedAt: 2000 }));
  assert.notEqual(a, playlistEtag(SAMPLE.slice(1), { origin: 'http://a', updatedAt: 1000 }));
  assert.match(a, /^W\/"pl-\d+-\d+-\d+"$/);
});

test('PlaylistFile writes atomically into a directory that does not exist yet', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-playlist-'));
  const file = path.join(root, 'deep', 'nested', 'channels.m3u');
  const playlist = new PlaylistFile({
    config: { playlistFile: file, playlistRefreshMs: 60000 },
    logger: silentLogger,
    root,
    getChannels: () => SAMPLE,
    getUpdatedAt: () => 1234,
    origin: () => 'https://relay.example',
  });

  assert.equal(playlist.state.file, file);
  const written = await playlist.write();
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal(written, onDisk);
  assert.equal(onDisk, buildPlaylist(SAMPLE, { origin: 'https://relay.example', updatedAt: 1234 }));
  assert.equal((onDisk.match(/#EXTINF/g) || []).length, 2);
  // no tmp file is left behind and nothing half-written is visible
  const left = (await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(left, []);

  const snapshot = playlist.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.channels, 2);
  assert.equal(snapshot.bytes, Buffer.byteLength(onDisk));
  assert.equal(snapshot.refreshMs, 60000);
  assert.equal(snapshot.origin, 'https://relay.example');
  assert.equal(snapshot.error, null);
  assert.ok(snapshot.generatedAt > 0);

  await fs.rm(root, { recursive: true, force: true });
});

test('PlaylistFile keeps the last good file when the channel list is empty and can be disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-playlist-'));
  const file = path.join(root, 'list.m3u');
  let channels = SAMPLE;
  const playlist = new PlaylistFile({
    config: { playlistFile: file, playlistRefreshMs: 0 },
    logger: silentLogger,
    root,
    getChannels: () => channels,
    getUpdatedAt: () => 5,
  });

  await playlist.write();
  assert.match(await fs.readFile(file, 'utf8'), /Somoy TV/);

  channels = [{ id: 'news', name: 'Somoy TV', order: 0 }];
  await playlist.write();
  assert.equal(playlist.snapshot().channels, 1);
  assert.equal((await fs.readFile(file, 'utf8')).match(/#EXTINF/g).length, 1);

  const disabled = new PlaylistFile({
    config: { playlistFile: '', playlistRefreshMs: 0 },
    logger: silentLogger,
    root,
    getChannels: () => SAMPLE,
  });
  assert.equal(await disabled.write(), null);
  disabled.start(60000);
  assert.equal(disabled.timer, null);
  assert.equal(disabled.snapshot().enabled, false);

  // start() writes immediately and stop() clears the timer
  playlist.start(0);
  assert.ok(playlist.state.generatedAt > 0);
  assert.equal(playlist.timer, null, 'refresh 0 means write once, no interval');
  playlist.start(60000);
  assert.ok(playlist.timer, 'an interval should be scheduled for refresh > 0');
  playlist.stop();
  assert.equal(playlist.timer, null);

  await fs.rm(root, { recursive: true, force: true });
});

/**
 * `chmod 0555` only blocks writes for an unprivileged process. When the suite
 * runs as root nothing is unwritable, so those tests skip instead of lying.
 */
async function lockDir(dir) {
  const probe = path.join(dir, 'probe.txt');
  await fs.chmod(dir, 0o555);
  try {
    await fs.writeFile(probe, 'x');
    await fs.chmod(dir, 0o755);
    await fs.rm(probe, { force: true });
    return false;
  } catch {
    return true;
  }
}

test('PlaylistFile falls back to a writable path when PLAYLIST_FILE is read-only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-ro-'));
  const locked = path.join(root, 'app');
  await fs.mkdir(locked);
  const warnings = [];
  const logger = { ...silentLogger, warn: (message) => warnings.push(message) };
  const configured = path.join(locked, 'channels.generated.m3u');
  const playlist = new PlaylistFile({
    config: { playlistFile: configured, playlistRefreshMs: 60000 },
    logger,
    root,
    getChannels: () => SAMPLE,
    getUpdatedAt: () => 7,
    origin: () => 'https://relay.example',
  });

  if (!(await lockDir(locked)) || !(await lockDir(locked))) {
    t.diagnostic('skipped: running as root, every directory is writable');
    await fs.rm(root, { recursive: true, force: true });
    t.skip('cannot make a directory read-only as root');
    return;
  }

  const text = await playlist.write();
  const snapshot = playlist.snapshot();
  assert.ok(text, 'a writable fallback must produce the playlist');
  assert.equal(snapshot.configuredFile, configured);
  assert.equal(snapshot.fallback, true);
  assert.equal(snapshot.file, path.join(root, '.cache', 'channels.generated.m3u'));
  assert.equal(snapshot.error, null);
  assert.match(snapshot.warning, /not writable/);
  assert.match(snapshot.warning, /PLAYLIST_FILE/);
  assert.equal(await fs.readFile(snapshot.file, 'utf8'), text);
  assert.equal(snapshot.channels, 2);

  // the warning is logged once, not on every refresh
  await playlist.write();
  const matches = warnings.filter((line) => line.includes('not writable'));
  assert.equal(matches.length, 1, `expected one warning, got ${warnings.length}: ${warnings.join(' | ')}`);

  await fs.chmod(locked, 0o755);
  await fs.rm(root, { recursive: true, force: true });
});

test('PlaylistFile reports an error instead of crashing when nothing is writable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-ro-'));
  const locked = path.join(root, 'app');
  await fs.mkdir(locked);
  if (!(await lockDir(locked))) {
    t.diagnostic('skipped: running as root, every directory is writable');
    await fs.rm(root, { recursive: true, force: true });
    t.skip('cannot make a directory read-only as root');
    return;
  }
  const warnings = [];
  const playlist = new PlaylistFile({
    config: { playlistFile: path.join(locked, 'list.m3u'), playlistRefreshMs: 0 },
    logger: { ...silentLogger, warn: (message) => warnings.push(message) },
    root: locked, // .cache fallback also lands in the read-only tree…
    getChannels: () => SAMPLE,
  });
  // …and the temp-dir candidate is redirected to the same locked tree
  playlist.candidates = playlist.candidates.map((file) => {
    if (file.startsWith(os.tmpdir()) && file.includes('m3urelay-')) return path.join(locked, path.basename(file));
    return file;
  });

  assert.equal(await playlist.write(), null);
  const snapshot = playlist.snapshot();
  assert.match(snapshot.error, /EACCES|EPERM|EROFS/);
  assert.equal(snapshot.generatedAt, null);
  assert.equal(warnings.length, 1, 'a permanent failure is logged once');
  assert.match(warnings[0], /PLAYLIST_FILE/);

  await playlist.write();
  assert.equal(warnings.length, 1, 'the interval must not spam the log');
  await fs.chmod(locked, 0o755);
  await fs.rm(root, { recursive: true, force: true });
});

test('PlaylistFile never blanks a good file when the channel list is empty', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-empty-'));
  const file = path.join(root, 'list.m3u');
  let channels = SAMPLE;
  const playlist = new PlaylistFile({
    config: { playlistFile: file, playlistRefreshMs: 0 },
    logger: silentLogger,
    root,
    getChannels: () => channels,
  });
  await playlist.write();
  const good = await fs.readFile(file, 'utf8');

  channels = []; // e.g. a failed sync or a boot before the list is loaded
  await playlist.write();
  assert.equal(await fs.readFile(file, 'utf8'), good);
  assert.equal(playlist.snapshot().channels, 2);

  await fs.rm(root, { recursive: true, force: true });
});

test('channel cache falls back to the temp dir and ignores empty lists', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-cache-'));
  const locked = path.join(root, 'app');
  await fs.mkdir(locked);
  if (!(await lockDir(locked))) {
    t.diagnostic('skipped: running as root, every directory is writable');
    await fs.rm(root, { recursive: true, force: true });
    t.skip('cannot make a directory read-only as root');
    return;
  }
  const cacheFile = path.join(locked, 'channels.cache.m3u');
  const fallback = path.join(os.tmpdir(), `m3urelay-${path.basename(cacheFile)}`);
  await fs.rm(fallback, { force: true });

  const warnings = [];
  const relay = new Relay({
    config: loadConfig({ CHANNELS_FILE: path.join(root, 'channels.m3u'), CHANNELS_CACHE_FILE: cacheFile, WATCH_CHANNELS: 'false' }),
    logger: { ...silentLogger, warn: (message) => warnings.push(message) },
    upstream: {},
  });

  await relay.writeCachedPlaylist('');
  assert.equal(relay.cacheFallback, undefined, 'empty text must not be cached at all');

  const text = '#EXTM3U\n#EXTINF:-1,News\nhigh://news\n';
  await relay.writeCachedPlaylist(text);
  assert.equal(relay.cacheFallback, fallback);
  assert.equal(await fs.readFile(fallback, 'utf8'), text);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CHANNELS_CACHE_FILE/);

  await relay.writeCachedPlaylist(text);
  assert.equal(warnings.length, 1, 'the fallback warning is logged once');

  await fs.rm(fallback, { force: true });
  await fs.chmod(locked, 0o755);
  await fs.rm(root, { recursive: true, force: true });
});

test('PlaylistFile serialises concurrent writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-playlist-'));
  const file = path.join(root, 'list.m3u');
  const playlist = new PlaylistFile({
    config: { playlistFile: file, playlistRefreshMs: 0 },
    logger: silentLogger,
    root,
    getChannels: () => SAMPLE,
  });
  const results = await Promise.all([playlist.write(), playlist.write(), playlist.write()]);
  assert.equal(results.length, 3);
  assert.equal(results[0], results[1]);
  assert.equal((await fs.readFile(file, 'utf8')).match(/#EXTINF/g).length, 2);
  await fs.rm(root, { recursive: true, force: true });
});

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

async function startRelay({ dir, origin }) {
  const channelsFile = path.join(dir, 'channels.m3u');
  await fs.writeFile(channelsFile, CHANNELS);
  const playlistFile = path.join(dir, 'generated', 'nested', 'playlist.m3u');
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CHANNELS_FILE: channelsFile,
      CHANNELS_CACHE_FILE: path.join(dir, 'channels.cache.m3u'),
      PLAYLIST_FILE: playlistFile,
      PLAYLIST_REFRESH_MS: '0',
      WATCH_CHANNELS: 'false',
      LOG_LEVEL: 'error',
      WARMER_INTERVAL_MS: '1000',
      CACHE_TTL_MS: '5000',
      URL_SECRET: 'test-secret-test-secret',
      UPSTREAM_BASE: origin,
      PUBLIC_URL: 'https://relay.example',
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
    playlistFile,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
    logs: () => logs,
  };
}

test('generated playlist: HTTP download, ETag/304 and the file on disk agree', async (t) => {
  const origin = await startMockOrigin({ latencyMs: 1 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-playlist-'));
  const relay = await startRelay({ dir, origin: origin.url });
  t.after(async () => {
    await relay.stop();
    await origin.close();
  });

  const first = await fetch(`${relay.base}/playlist.m3u`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /mpegurl/);
  assert.equal(first.headers.get('access-control-allow-origin'), '*');
  assert.match(first.headers.get('cache-control'), /no-cache/);
  assert.match(first.headers.get('content-disposition'), /^inline; filename="my-iptv\.m3u"$/);
  const etag = first.headers.get('etag');
  assert.match(etag, /^W\/"pl-3-\d+-\d+"$/);
  const body = await first.text();
  assert.equal((body.match(/#EXTINF/g) || []).length, 3);
  assert.match(body, /^# MY IPTV PRO — 3 channels · updated /m);
  for (const line of body.split('\n').filter((line) => line && !line.startsWith('#'))) {
    assert.ok(line.startsWith('https://relay.example/live/high/'), `bad playlist url ${line}`);
  }
  assert.match(body, /group-title="Bangla News"/);

  await t.test('a conditional request returns 304 with no body', async () => {
    const response = await fetch(`${relay.base}/playlist.m3u`, { headers: { 'if-none-match': etag } });
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('etag'), etag);
    assert.match(response.headers.get('cache-control'), /no-cache/);
  });

  await t.test('?download=1 switches to an attachment', async () => {
    const response = await fetch(`${relay.base}/playlist.m3u?download=1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="my-iptv\.m3u"$/);
    assert.equal(await response.text(), body);
  });

  await t.test('low/medium quality stays forbidden', async () => {
    for (const quality of ['low', 'medium']) {
      const response = await fetch(`${relay.base}/playlist.m3u?q=${quality}`);
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.match(payload.error, /disabled by design/);
    }
  });

  await t.test('the generated file matches what HTTP serves and lives in a new directory', async () => {
    const onDisk = await fs.readFile(relay.playlistFile, 'utf8');
    assert.equal(onDisk, body);
    assert.equal((onDisk.match(/#EXTINF/g) || []).length, 3);
    const siblings = await fs.readdir(path.dirname(relay.playlistFile));
    assert.deepEqual(siblings, ['playlist.m3u']);
  });

  await t.test('/api/status exposes the playlist state', async () => {
    const status = await (await fetch(`${relay.base}/api/status`)).json();
    assert.equal(status.playlist.enabled, true);
    assert.equal(status.playlist.channels, 3);
    assert.equal(status.playlist.bytes, Buffer.byteLength(body));
    assert.equal(status.playlist.refreshMs, 0);
    assert.equal(status.playlist.origin, 'https://relay.example');
    assert.equal(status.playlist.error, null);
    assert.ok(status.playlist.generatedAt > 0);
  });

  await t.test('a sync rewrites the file and invalidates the playlist ETag', async () => {
    await fs.writeFile(path.join(dir, 'channels.m3u'), `${CHANNELS}#EXTINF:-1 tvg-id="kids" group-title="Kids",Kids TV\nhigh://kids\n`);
    const sync = await (await fetch(`${relay.base}/api/sync`)).json();
    assert.equal(sync.ok, true);
    assert.equal(sync.channels, 4);
    const next = await fetch(`${relay.base}/playlist.m3u`);
    assert.equal(next.status, 200);
    assert.notEqual(next.headers.get('etag'), etag);
    const text = await next.text();
    assert.equal((text.match(/#EXTINF/g) || []).length, 4);
    assert.equal(await fs.readFile(relay.playlistFile, 'utf8'), text);
  });

  await t.test('the lite channel view is much smaller but keeps ETag semantics', async () => {
    const full = await fetch(`${relay.base}/api/channels`);
    const lite = await fetch(`${relay.base}/api/channels?view=lite`);
    assert.equal(full.status, 200);
    assert.equal(lite.status, 200);
    assert.match(lite.headers.get('etag'), /^W\/"ch-lite-\d+-\d+"$/);
    assert.notEqual(lite.headers.get('etag'), full.headers.get('etag'));
    const fullBody = await full.json();
    const liteBody = await lite.json();
    assert.equal(liteBody.view, 'lite');
    assert.equal(liteBody.total, fullBody.total);
    assert.equal(liteBody.groups.length, fullBody.groups.length);
    assert.ok(JSON.stringify(liteBody).length < JSON.stringify(fullBody).length);
    const liteChannel = liteBody.channels.find((channel) => channel.id === 'news');
    for (const key of ['id', 'name', 'group', 'status']) {
      assert.ok(key in liteChannel, `lite view is missing ${key}`);
    }
    assert.equal(liteChannel.url, undefined, 'lite view must not ship manifests urls');
    assert.ok(liteChannel.qualities.length >= 1);

    const conditional = await fetch(`${relay.base}/api/channels?view=lite`, {
      headers: { 'if-none-match': lite.headers.get('etag') },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), '');
  });
});
