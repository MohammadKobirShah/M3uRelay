import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isMpdUrl, mpdChannelId, mpdToHls } from '../lib/mpd.js';
import { parseChannelList } from '../lib/channels.js';
import { Upstream } from '../lib/upstream.js';
import { loadConfig } from '../lib/config.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'mpd-to-hls.js');

const MIXED = `#EXTM3U x-tvg-url="https://host/epg.xml.gz"
#EXTINF:-1 tvg-id="143" tvg-name="CNBC TV18 Prime" group-title="Business" tvg-language="English", CNBC TV18 Prime
#KODIPROP:inputstream=inputstream.adaptive
#KODIPROP:inputstream.adaptive.manifest_type=mpd
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://host/live/key/143?q=high
https://host/live/mpd/143?q=high
#EXTINF:-1 tvg-id="144" tvg-name="Colors HD" group-title="Entertainment" tvg-language="Hindi", Colors HD
https://host/live/high/144.m3u8
#EXTINF:-1 tvg-id="movie" tvg-name="Movie Channel", Movie Channel
https://cdn.example.com/vod/movie/index.mpd?token=abc
#EXTINF:-1 tvg-id="dashfold" tvg-name="Dash Folder", Dash Folder
https://cdn.example.com/dash/ch9/manifest.mpd
`;

test('isMpdUrl recognises the shapes providers publish', () => {
  assert.equal(isMpdUrl('https://h/live/mpd/143?q=high'), true);
  assert.equal(isMpdUrl('https://h/live/dash/143.mpd'), true);
  assert.equal(isMpdUrl('https://cdn/x/index.mpd'), true);
  assert.equal(isMpdUrl('https://cdn/x/index.mpd?token=1'), true);
  assert.equal(isMpdUrl('https://cdn/mpd/ch9'), true);
  assert.equal(isMpdUrl('https://h/live/high/143.m3u8'), false);
  assert.equal(isMpdUrl('https://cdn/x/index.m3u8?token=1'), false);
  assert.equal(isMpdUrl(''), false);
  assert.equal(isMpdUrl(null), false);
});

test('mpdToHls maps every MPD form onto an HLS URL', () => {
  assert.equal(mpdToHls('https://host/live/mpd/143?q=high'), 'https://host/live/high/143.m3u8');
  assert.equal(mpdToHls('https://host/live/mpd/143'), 'https://host/live/high/143.m3u8');
  assert.equal(mpdToHls('https://host/live/dash/143.mpd?q=auto'), 'https://host/live/high/143.m3u8');
  assert.equal(mpdToHls('https://cdn/vod/movie/index.mpd'), 'https://cdn/vod/movie/index.m3u8');
  assert.equal(mpdToHls('https://cdn/vod/movie/index.mpd?token=abc'), 'https://cdn/vod/movie/index.m3u8?token=abc');
  assert.equal(mpdToHls('https://cdn/mpd/ch9'), 'https://cdn/high/ch9.m3u8');
  assert.equal(mpdToHls('https://cdn/dash/ch9/manifest.mpd'), 'https://cdn/high/ch9.m3u8');
  // never touches HLS or unknown URLs
  assert.equal(mpdToHls('https://h/live/high/143.m3u8'), null);
  assert.equal(mpdToHls('https://cdn/stream.m3u8?x=1'), null);
  // the result is always an HLS URL, never another MPD
  for (const url of ['https://h/live/mpd/1', 'https://cdn/a/index.mpd', 'https://cdn/mpd/b', 'https://cdn/dash/c/manifest.mpd']) {
    assert.equal(isMpdUrl(mpdToHls(url)), false, `${url} still looks like DASH`);
  }
});

test('mpdChannelId extracts the provider id only when the URL carries one', () => {
  assert.equal(mpdChannelId('https://h/live/mpd/143?q=high'), '143');
  assert.equal(mpdChannelId('https://h/live/dash/144.mpd'), '144');
  assert.equal(mpdChannelId('https://cdn/vod/index.mpd'), null);
  assert.equal(mpdChannelId('https://h/live/high/143.m3u8'), null);
});

test('channel parsing marks DASH entries and keeps the HLS twin', () => {
  const { channels } = parseChannelList(MIXED);
  assert.equal(channels.length, 4);

  const jio = channels.find((channel) => channel.id === '143');
  assert.equal(jio.dash, true);
  assert.equal(jio.dashId, '143');
  assert.equal(jio.providerId, '143');

  const generic = channels.find((channel) => channel.id === 'movie');
  assert.equal(generic.dash, true, 'a plain .mpd is DASH too');
  assert.equal(generic.providerId, null, 'no id can be invented for a generic .mpd');
  assert.match(generic.customUrl, /\.mpd(?:\?|$)/);

  const hls = channels.find((channel) => channel.id === '144');
  assert.equal(hls.dash, false);
});

test('the upstream never fetches an MPD: it requests the HLS twin', () => {
  const upstream = new Upstream(loadConfig({ UPSTREAM_BASE: 'https://host', DASH_TO_HLS: 'true' }), null);
  const candidates = (customUrl) => upstream.customUrlCandidates({ id: 'x', providerId: 'x', customUrl });

  assert.deepEqual(candidates('https://host/live/mpd/143?q=high'), ['https://host/live/high/143.m3u8']);
  assert.deepEqual(candidates('https://cdn/vod/movie/index.mpd'), ['https://cdn/vod/movie/index.m3u8']);

  const off = new Upstream(loadConfig({ UPSTREAM_BASE: 'https://host', DASH_TO_HLS: 'false' }), null);
  assert.deepEqual(off.customUrlCandidates({ id: 'x', customUrl: 'https://host/live/mpd/143' }), []);

  const master = upstream.masterUrl({ id: '143', providerId: '143', customUrl: 'https://host/live/mpd/143?q=high' });
  assert.equal(master, 'https://host/live/high/143.m3u8');
});

test('mpd-to-hls writes an HLS-only playlist and drops Widevine lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-mpd-'));
  const input = path.join(dir, 'provider.m3u');
  const output = path.join(dir, 'hls.m3u');
  await fs.writeFile(input, MIXED);

  const { stderr } = await run(process.execPath, [SCRIPT, input, '-o', output], { cwd: ROOT });
  const text = await fs.readFile(output, 'utf8');

  assert.match(stderr, /3 MPD → HLS|MPD → HLS/);
  assert.equal((text.match(/#EXTINF/g) || []).length, 4);
  assert.ok(!/\.mpd/.test(text), 'the converted playlist must not contain an MPD URL');
  assert.ok(!/KODIPROP/.test(text), 'DASH/Widevine directives are removed');
  assert.ok(text.startsWith('#EXTM3U x-tvg-url="https://host/epg.xml.gz"'), 'the header survives');
  assert.match(text, /^# 4 channels · 3 MPD mapped to HLS · 1 already HLS$/m);
  for (const line of text.split('\n').filter((line) => line && !line.startsWith('#'))) {
    assert.match(line, /\.m3u8(?:\?|$)/, `not HLS: ${line}`);
  }
  assert.match(text, /https:\/\/host\/live\/high\/143\.m3u8\n/);
  assert.match(text, /https:\/\/host\/live\/high\/144\.m3u8\n/);
  assert.match(text, /https:\/\/cdn\.example\.com\/vod\/movie\/index\.m3u8\?token=abc\n/);
  assert.match(text, /https:\/\/cdn\.example\.com\/high\/ch9\.m3u8\n/);

  // stdout mode + --check (writes nothing)
  const stdout = await run(process.execPath, [SCRIPT, input], { cwd: ROOT });
  const stamp = (value) => value.replace(/ on \d{4}-\d{2}-\d{2}T[\d:.]+Z by /, ' on <date> by ');
  assert.equal(stamp(stdout.stdout), stamp(text), 'stdout and -o must produce the same playlist');
  const check = await run(process.execPath, [SCRIPT, input, '--check', '-o', path.join(dir, 'never.m3u')], { cwd: ROOT });
  assert.match(check.stderr, /3 MPD → HLS/);
  await assert.rejects(fs.access(path.join(dir, 'never.m3u')), /ENOENT/);

  await fs.rm(dir, { recursive: true, force: true });
});

test('mpd-to-hls can rebase hosts and read from stdin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3urelay-mpd-'));
  const input = path.join(dir, 'provider.m3u');
  await fs.writeFile(input, '#EXTM3U\n#EXTINF:-1,Live\nhttps://origin/live/mpd/143?q=high\n');

  const { stdout } = await run(process.execPath, [SCRIPT, input, '--base', 'https://relay.example:3000'], { cwd: ROOT });
  assert.match(stdout, /https:\/\/relay\.example:3000\/live\/high\/143\.m3u8\n/);
  assert.match(stdout, /MPD mapped to HLS/);

  // stdin: convert through a shell pipe (the documented usage)
  const piped = await execFileAsyncThroughPipe('#EXTM3U\n#EXTINF:-1,One\nhttps://origin/live/mpd/7?q=high\n');
  assert.match(piped, /https:\/\/origin\/live\/high\/7\.m3u8\n/);

  await fs.rm(dir, { recursive: true, force: true });
});

function execFileAsyncThroughPipe(text) {
  return new Promise((resolve, reject) => {
    const child = execFile('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} -`], { cwd: ROOT }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.end(text);
  });
}
