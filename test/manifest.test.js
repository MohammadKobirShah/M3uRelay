import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlan,
  normalizeLanguage,
  parseAttributeList,
  parseMaster,
  parseMediaPlaylist,
  renderMaster,
  renderMediaPlaylist,
  selectAudio,
  selectVariants,
  serializeAttributes,
} from '../lib/manifest.js';
import { resolveUrl } from '../lib/util.js';
import { masterManifest, mediaPlaylist } from '../scripts/mock-origin.js';

const AUDIO = [
  { name: 'English', lang: 'eng', default: 'YES' },
  { name: 'Hindi', lang: 'hin', default: 'NO' },
  { name: 'Bengali', lang: 'ben', default: 'NO' },
  { name: 'Tamil', lang: 'tam', default: 'NO' },
];

const RUNGS = [
  [256, 144, 200_000],
  [426, 240, 350_000],
  [640, 360, 700_000],
  [854, 480, 1_200_000],
  [1024, 576, 1_800_000],
  [1280, 720, 2_800_000],
  [1920, 1080, 5_000_000],
];

function manifest({ rungs = RUNGS, audio = AUDIO, resolution = true } = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const track of audio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${track.name}",LANGUAGE="${track.lang}",DEFAULT=${track.default},AUTOSELECT=YES,URI="audio/${track.lang}.m3u8"`,
    );
  }
  lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",URI="subs/eng.m3u8"');
  for (const [width, height, bandwidth] of rungs) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"${resolution ? `,RESOLUTION=${width}x${height}` : ''}`,
    );
    lines.push(`v/${height}p.m3u8`);
  }
  lines.push('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180,URI="iframe.m3u8"');
  return lines.join('\n');
}

test('attribute lists round-trip quoted values containing commas', () => {
  const entries = parseAttributeList('BANDWIDTH=3220000,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=1280x720');
  assert.equal(entries.length, 3);
  assert.equal(entries[1].value, 'avc1.640020,mp4a.40.2');
  assert.match(serializeAttributes(entries), /CODECS="avc1\.640020,mp4a\.40\.2"/);
});

test('quality filter keeps exactly 720p then 1080p and deletes the rest', () => {
  const parsed = parseMaster(manifest(), 'http://origin/live/high/x.m3u8');
  assert.equal(parsed.variants.length, 7);

  const result = selectVariants(parsed.variants);
  assert.deepEqual(
    result.variants.map((variant) => variant.key),
    ['720', '1080'],
  );
  assert.equal(result.variants[0].height, 720);
  assert.equal(result.variants[1].height, 1080);
  assert.equal(result.dropped, 5);
  assert.ok(result.ignored.every((variant) => ![720, 1080].includes(variant.resolution?.height ?? -1)));
});

test('4K rungs are never forwarded and a lone 1080p rung is kept', () => {
  const parsed = parseMaster(
    manifest({
      rungs: [
        [1920, 1080, 5_000_000],
        [2560, 1440, 9_000_000],
        [3840, 2160, 16_000_000],
      ],
    }),
    'http://o/m.m3u8',
  );
  const result = selectVariants(parsed.variants);
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].key, '1080');
});

test('SD channel without any 720/1080 rung keeps the best available rung, not 240p', () => {
  const parsed = parseMaster(manifest({ rungs: RUNGS.slice(0, 5) }), 'http://o/m.m3u8');
  const result = selectVariants(parsed.variants);
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].key, 'best');
  assert.equal(result.variants[0].height, 576);
  assert.equal(result.variants[0].fallback, true);
});

test('resolution-less manifests fall back to the bandwidth heuristic', () => {
  const parsed = parseMaster(
    manifest({
      rungs: [
        [0, 0, 1_200_000],
        [0, 0, 2_800_000],
        [0, 0, 5_000_000],
      ],
      resolution: false,
    }),
    'http://o/m.m3u8',
  );
  const result = selectVariants(parsed.variants);
  assert.deepEqual(
    result.variants.map((variant) => variant.key),
    ['720', '1080'],
  );
});

test('audio filter keeps Bangla default + Hindi backup and deletes the rest', () => {
  const parsed = parseMaster(manifest(), 'http://o/m.m3u8');
  const quality = selectVariants(parsed.variants);
  const audio = selectAudio(parsed.audio, quality.variants);

  assert.equal(audio.tracks.length, 2);
  const bangla = audio.tracks.find((track) => track.lang === 'ben');
  const hindi = audio.tracks.find((track) => track.lang === 'hin');
  assert.ok(bangla && hindi);
  assert.equal(bangla.default, true);
  assert.equal(bangla.autoselect, true);
  assert.equal(hindi.default, false);
  assert.equal(hindi.autoselect, true);
  assert.equal(audio.defaultLang, 'ben');
  assert.equal(audio.dropped, 2);
  assert.ok(!audio.tracks.some((track) => ['eng', 'tam'].includes(track.lang)));
});

test('Hindi becomes the default when there is no Bangla; otherwise first available', () => {
  const plan = buildPlan(
    manifest({ audio: [{ name: 'Hindi', lang: 'hin', default: 'YES' }, { name: 'English', lang: 'eng', default: 'NO' }] }),
    'http://o/m.m3u8',
  );
  assert.equal(plan.meta.defaultLang, 'hin');
  assert.equal(plan.audio.length, 1);
  assert.equal(plan.audio[0].default, true);

  const onlyEnglish = buildPlan(
    manifest({ audio: [{ name: 'English', lang: 'eng', default: 'YES' }] }),
    'http://o/m.m3u8',
  );
  assert.equal(onlyEnglish.audio.length, 1);
  assert.equal(onlyEnglish.audio[0].default, true);
  assert.equal(onlyEnglish.meta.defaultLang, 'eng');
});

test('language detection understands names, tags and aliases', () => {
  const track = (attrs) => ({ attrs: Object.entries(attrs).map(([key, value]) => ({ key, value, quoted: true })) });
  assert.equal(normalizeLanguage(track({ NAME: 'Bangla Audio' })), 'ben');
  assert.equal(normalizeLanguage(track({ LANGUAGE: 'bn' })), 'ben');
  assert.equal(normalizeLanguage(track({ LANGUAGE: 'ben' })), 'ben');
  assert.equal(normalizeLanguage(track({ NAME: 'Bengali' })), 'ben');
  assert.equal(normalizeLanguage(track({ LANGUAGE: 'hi' })), 'hin');
  assert.equal(normalizeLanguage(track({ NAME: 'Hindi' })), 'hin');
  assert.equal(normalizeLanguage(track({ LANGUAGE: 'tam' })), 'other');
});

test('rendered master has two audio renditions, two variants and relay URLs', () => {
  const plan = buildPlan(manifest(), 'http://o/live/high/x.m3u8');
  const text = renderMaster(plan, { urlFor: (key) => `/v/x/${key}.m3u8` });
  const lines = text.trim().split('\n');

  const streamInf = lines.filter((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  assert.equal(streamInf.length, 2);
  assert.match(streamInf[0], /RESOLUTION=1280x720/);
  assert.match(streamInf[1], /RESOLUTION=1920x1080/);

  const media = lines.filter((line) => line.startsWith('#EXT-X-MEDIA:'));
  assert.equal(media.length, 2);
  assert.match(media[0], /NAME="Bengali"/);
  assert.match(media[0], /DEFAULT=YES,AUTOSELECT=YES/);
  assert.match(media[0], /FORCED=NO/);
  assert.match(media[0], /URI="\/v\/x\/a-ben1\.m3u8"/);
  assert.match(media[1], /NAME="Hindi"/);
  assert.match(media[1], /DEFAULT=NO,AUTOSELECT=YES/);

  const uriLines = lines.filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(uriLines, ['/v/x/720.m3u8', '/v/x/1080.m3u8']);

  assert.ok(!text.includes('I-FRAME'));
  assert.ok(!text.includes('SUBTITLES'));
  assert.ok(lines.every((line) => !/English|Tamil|Telugu/.test(line)));
});

test('audio group referenced by a variant is never left empty', () => {
  const raw = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="e.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a2",NAME="Bengali",LANGUAGE="ben",DEFAULT=YES,URI="b.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,AUDIO="a1"',
    '720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="a2"',
    '1080.m3u8',
  ].join('\n');
  const plan = buildPlan(raw, 'http://o/m.m3u8');
  const groups = new Set(plan.audio.map((track) => track.groupId));
  assert.ok(groups.has('a1'));
  assert.ok(groups.has('a2'));
  const text = renderMaster(plan, { urlFor: (key) => `/v/x/${key}.m3u8` });
  // Both variants keep their AUDIO attribute because both groups still exist.
  assert.equal((text.match(/AUDIO="a1"/g) || []).length, 1);
  assert.equal((text.match(/AUDIO="a2"/g) || []).length, 1);
});

test('media playlist rewrite resolves relative URLs, proxies keys and keeps timing tags', () => {
  const raw = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:42',
    '#EXT-X-DISCONTINUITY-SEQUENCE:1',
    '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
    '#EXT-X-KEY:METHOD=AES-128,URI="../keys/k1.bin",IV=0x01',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.000,',
    'seg1.ts',
    '#EXTINF:6.000,',
    'seg2.ts',
  ].join('\n');

  const parsed = parseMediaPlaylist(raw, 'http://origin/live/high/x/720/index.m3u8');
  assert.equal(parsed.meta.targetDuration, 6);
  assert.equal(parsed.meta.mediaSequence, 42);
  assert.equal(parsed.meta.segmentCount, 2);

  const text = renderMediaPlaylist(parsed, {
    segment: (url) => `/s?u=${encodeURIComponent(url)}`,
    key: (url) => `/k?u=${encodeURIComponent(url)}`,
    map: (url) => `/s?u=${encodeURIComponent(url)}`,
  });

  assert.match(text, /#EXT-X-TARGETDURATION:6/);
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:42/);
  assert.match(text, /#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z/);
  assert.match(text, /#EXT-X-KEY:METHOD=AES-128,URI="\/k\?u=http%3A%2F%2Forigin%2Flive%2Fhigh%2Fx%2Fkeys%2Fk1\.bin",IV=0x01/);
  assert.match(text, /#EXT-X-MAP:URI="\/s\?u=http%3A%2F%2Forigin%2Flive%2Fhigh%2Fx%2F720%2Finit\.mp4"/);
  assert.match(text, /\/s\?u=http%3A%2F%2Forigin%2Flive%2Fhigh%2Fx%2F720%2Fseg1\.ts/);
  assert.match(text, /#EXTINF:6\.000/);
});

test('resolveUrl handles relative, absolute and dot-segment URLs', () => {
  const base = 'http://origin/live/high/ch/index.m3u8';
  assert.equal(resolveUrl('seg1.ts', base), 'http://origin/live/high/ch/seg1.ts');
  assert.equal(resolveUrl('../seg/1.ts', base), 'http://origin/live/high/seg/1.ts');
  assert.equal(resolveUrl('/abs/1.ts', base), 'http://origin/abs/1.ts');
  assert.equal(resolveUrl('https://cdn.example/1.ts', base), 'https://cdn.example/1.ts');
  assert.equal(resolveUrl('http://cdn.example/a/../1.ts', base), 'http://cdn.example/1.ts');
  assert.equal(resolveUrl('data:text/plain;base64,AA==', base), 'data:text/plain;base64,AA==');
});

test('a media-playlist-only channel is served as a single source rendition', () => {
  const plan = buildPlan(mediaPlaylist('media', '720p'), 'http://o/live/high/media.m3u8');
  assert.equal(plan.type, 'media');
  assert.equal(plan.variants.length, 1);
  assert.equal(plan.variants[0].key, 'best');
  assert.ok(plan.media.items.some((item) => item.kind === 'segment'));
});

test('mock master manifest is cleaned end to end', () => {
  const plan = buildPlan(masterManifest('demo'), 'http://mock/live/high/demo.m3u8');
  assert.equal(plan.variants.length, 2);
  assert.equal(plan.audio.length, 2);
  assert.equal(plan.audio[0].lang, 'ben');
  assert.equal(plan.dropped.variants, 5);
});
