#!/usr/bin/env node
/**
 * Mock JioTV-style origin used for tests and for `npm run demo`.
 *
 * It serves deliberately messy manifests: eight quality rungs (144p..1080p),
 * five audio languages, I-frame variants, encryption keys and relative segment
 * URLs — everything the relay is supposed to clean up.
 *
 * Special channel ids:
 *   broken   -> /live/high 500s, /live/ auto works   (fallback test)
 *   sd       -> only 240p/360p/576p rungs            (fallback keeps best rung)
 *   hdonly   -> only 1080p
 *   nores    -> variants with no RESOLUTION attribute
 *   media    -> master endpoint returns a media playlist
 *   enc      -> variant playlist carries an AES-128 key
 *   slow     -> 2.5s delay on the master
 *   token    -> requires ?token=mock-token
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIO_TRACKS = [
  { name: 'English', lang: 'eng', default: 'YES' },
  { name: 'Hindi', lang: 'hin', default: 'NO' },
  { name: 'Bengali', lang: 'ben', default: 'NO' },
  { name: 'Tamil', lang: 'tam', default: 'NO' },
  { name: 'Telugu', lang: 'tel', default: 'NO' },
];

const ALL_RUNGS = [
  { height: 144, width: 256, bandwidth: 200_000, codecs: 'avc1.42c00d,mp4a.40.2' },
  { height: 240, width: 426, bandwidth: 350_000, codecs: 'avc1.42c015,mp4a.40.2' },
  { height: 360, width: 640, bandwidth: 700_000, codecs: 'avc1.4d401e,mp4a.40.2' },
  { height: 480, width: 854, bandwidth: 1_200_000, codecs: 'avc1.4d401f,mp4a.40.2' },
  { height: 576, width: 1024, bandwidth: 1_800_000, codecs: 'avc1.4d401f,mp4a.40.2' },
  { height: 720, width: 1280, bandwidth: 2_800_000, codecs: 'avc1.640020,mp4a.40.2' },
  { height: 1080, width: 1920, bandwidth: 5_000_000, codecs: 'avc1.640028,mp4a.40.2' },
];

const stats = { master: 0, variant: 0, segment: 0, key: 0 };

const CONTENT_TYPES = {
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.json': 'application/json',
};

/** Real media for the offline demo: a 16s test-pattern loop at 360/720/1080p. */
function loadDemoMedia(mediaDir) {
  if (!mediaDir) return null;
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(mediaDir, 'manifest.json'), 'utf8'));
    const audioDir = path.join(mediaDir, 'audio');
    const audioSegments =
      Number(spec.audioSegments) ||
      (fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter((file) => file.endsWith('.ts')).length : 0);
    return {
      dir: mediaDir,
      segments: Number(spec.segments) || 8,
      seconds: Number(spec.segmentDuration) || 2,
      audioSegments,
    };
  } catch {
    return null;
  }
}

function demoMaster() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const track of [
    { name: 'English', lang: 'eng', def: 'YES' },
    { name: 'Hindi', lang: 'hin', def: 'NO' },
    { name: 'Bengali', lang: 'ben', def: 'NO' },
    { name: 'Tamil', lang: 'tam', def: 'NO' },
  ]) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${track.name}",LANGUAGE="${track.lang}",` +
        `DEFAULT=${track.def},AUTOSELECT=YES,URI="/demo/audio/${track.lang}.m3u8"`,
    );
  }
  lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",URI="/demo/subs/eng.m3u8"');
  for (const rung of [
    { height: 240, width: 426, quality: '360p', bandwidth: 400_000 },
    { height: 360, width: 640, quality: '360p', bandwidth: 800_000 },
    { height: 720, width: 1280, quality: '720p', bandwidth: 2_400_000 },
    { height: 1080, width: 1920, quality: '1080p', bandwidth: 4_200_000 },
  ]) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(rung.bandwidth * 1.2)},AVERAGE-BANDWIDTH=${rung.bandwidth},` +
        `RESOLUTION=${rung.width}x${rung.height},CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",FRAME-RATE=12.000`,
    );
    lines.push(`/demo/live/${rung.quality}.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}

function demoMediaPlaylist(demo, quality) {
  const sequence = Math.floor(Date.now() / (demo.seconds * 1000));
  const count = Math.max(1, demo.segments);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(demo.seconds)}`,
    `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
    '#EXT-X-DISCONTINUITY-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  for (let i = 0; i < 6; i += 1) {
    lines.push(`#EXTINF:${demo.seconds.toFixed(3)},`);
    lines.push(`/demo/media/${quality}/seg${(sequence + i) % count}.ts`);
  }
  return `${lines.join('\n')}\n`;
}

function demoAudioPlaylist(demo, lang) {
  const sequence = Math.floor(Date.now() / (demo.seconds * 1000));
  const count = Math.max(1, demo.audioSegments);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(demo.seconds)}`,
    `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  for (let i = 0; i < 6; i += 1) {
    lines.push(`#EXTINF:${demo.seconds.toFixed(3)},`);
    lines.push(`/demo/media/audio/seg${(sequence + i) % count}.ts`);
  }
  return `${lines.join('\n')}\n`;
}

export function masterManifest(id, { rungs = ALL_RUNGS, audio = true, resolution = true } = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

  if (audio) {
    for (const track of AUDIO_TRACKS) {
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="${track.name}",LANGUAGE="${track.lang}",` +
          `DEFAULT=${track.default},AUTOSELECT=${track.default === 'YES' ? 'YES' : 'NO'},URI="/audio/${id}/${track.lang}.m3u8"`,
      );
    }
    lines.push(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=NO,URI="/subs/eng.m3u8"',
    );
  }

  rungs.forEach((rung, index) => {
    const attrs = [
      `BANDWIDTH=${Math.round(rung.bandwidth * 1.15)}`,
      `AVERAGE-BANDWIDTH=${rung.bandwidth}`,
      `CODECS="${rung.codecs}"`,
    ];
    if (resolution) attrs.push(`RESOLUTION=${rung.width}x${rung.height}`);
    if (audio) attrs.push('AUDIO="audio-aac"');
    attrs.push('FRAME-RATE=25.000');
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`);
    lines.push(`/v/${id}/${rung.height}p.m3u8${index === 0 ? '?rung=low' : ''}`);
  });

  lines.push('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,RESOLUTION=320x180,URI="/iframe/' + id + '.m3u8"');
  return `${lines.join('\n')}\n`;
}

export function mediaPlaylist(id, quality, { encrypted = false, segmentHost = '' } = {}) {
  const sequence = Math.floor(Date.now() / 4000) % 100000;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
    '#EXT-X-DISCONTINUITY-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  if (encrypted) {
    lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="/key/${id}.bin",IV=0x00000000000000000000000000000001`);
  }
  for (let i = 0; i < 6; i += 1) {
    lines.push('#EXTINF:4.000,');
    const relative = `../../seg/${id}/${quality}/${sequence + i}.ts`;
    const absolute = `${segmentHost}seg/${id}/${quality}/${sequence + i}.ts`;
    lines.push(i === 2 ? absolute : relative);
    if (i === 3) lines.push('#EXT-X-DISCONTINUITY');
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

function send(res, status, body, type = 'application/vnd.apple.mpegurl') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string, close: () => Promise<void>}>}
 */
export function startMockOrigin({ port = 0, host = '127.0.0.1', latencyMs = 15, mediaDir = null } = {}) {
  const demo = loadDemoMedia(mediaDir);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (latencyMs) await delay(latencyMs);

    if (pathname === '/__stats') {
      send(res, 200, JSON.stringify(stats), 'application/json');
      return;
    }
    if (pathname === '/__token') {
      send(res, 200, JSON.stringify({ token: 'mock-token', channel: url.searchParams.get('channel') }), 'application/json');
      return;
    }
    if (pathname === '/__reset') {
      stats.master = 0;
      stats.variant = 0;
      stats.segment = 0;
      stats.key = 0;
      send(res, 200, '{"ok":true}', 'application/json');
      return;
    }

    if (demo && /^\/demo\/live\/[^/]+\.m3u8$/.test(pathname)) {
      stats.variant += 1;
      const quality = pathname.split('/')[3].replace(/\.m3u8$/, '');
      send(res, 200, demoMediaPlaylist(demo, quality));
      return;
    }
    if (demo && /^\/demo\/audio\/[a-z]{3}\.m3u8$/.test(pathname)) {
      stats.variant += 1;
      send(res, 200, demoAudioPlaylist(demo, pathname.split('/')[3].replace(/\.m3u8$/, '')));
      return;
    }
    if (demo && pathname.startsWith('/demo/media/')) {
      const relative = pathname.replace('/demo/media/', '');
      const target = path.join(demo.dir, relative);
      if (!target.startsWith(path.resolve(demo.dir))) {
        send(res, 403, 'forbidden', 'text/plain');
        return;
      }
      try {
        const body = await fs.promises.readFile(target);
        stats.segment += 1;
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
          'content-length': String(body.length),
          'cache-control': 'public, max-age=4',
          'access-control-allow-origin': '*',
        });
        res.end(body);
      } catch {
        send(res, 404, 'media not found', 'text/plain');
      }
      return;
    }

    const masterMatch = /^\/live\/(?:(high|auto|low|medium)\/)?([^/]+)\.m3u8$/.exec(pathname);
    if (masterMatch) {
      stats.master += 1;
      const quality = masterMatch[1] || 'auto';
      const id = decodeURIComponent(masterMatch[2]);

      if (id === 'token' && url.searchParams.get('token') !== 'mock-token') {
        send(res, 403, '#EXTM3U\n', 'text/plain');
        return;
      }
      if (id === 'slow') await delay(2500);
      if (id === 'broken' && quality === 'high') {
        send(res, 500, 'upstream exploded', 'text/plain');
        return;
      }
      if (id === 'media') {
        send(res, 200, mediaPlaylist(id, '720p'));
        return;
      }
      if (demo) {
        send(res, 200, demoMaster());
        return;
      }

      const opts = { audio: true, resolution: true };
      if (quality === 'low' || quality === 'medium') {
        opts.rungs = ALL_RUNGS.filter((rung) => rung.height <= 360);
      } else if (id === 'sd') {
        opts.rungs = ALL_RUNGS.filter((rung) => [240, 360, 576].includes(rung.height));
      } else if (id === 'hdonly') {
        opts.rungs = ALL_RUNGS.filter((rung) => rung.height === 1080);
      } else if (id === 'nores') {
        opts.resolution = false;
        opts.rungs = ALL_RUNGS.filter((rung) => [480, 720, 1080].includes(rung.height));
      } else if (id === 'noaudio') {
        opts.audio = false;
      } else if (id === 'broken') {
        opts.rungs = ALL_RUNGS.filter((rung) => [480, 720].includes(rung.height));
      }
      send(res, 200, masterManifest(id, opts));
      return;
    }

    const variantMatch = /^\/v\/([^/]+)\/(\d+p)\.m3u8$/.exec(pathname);
    if (variantMatch) {
      stats.variant += 1;
      const id = decodeURIComponent(variantMatch[1]);
      const quality = variantMatch[2];
      const segmentHost = `http://${req.headers.host}/`;
      send(res, 200, mediaPlaylist(id, quality, { encrypted: id === 'enc', segmentHost }));
      return;
    }

    const audioMatch = /^\/audio\/([^/]+)\/([a-z]{3})\.m3u8$/.exec(pathname);
    if (audioMatch) {
      stats.variant += 1;
      send(res, 200, mediaPlaylist(audioMatch[1], `audio-${audioMatch[2]}`));
      return;
    }

    if (/^\/key\/[^/]+\.bin$/.test(pathname)) {
      stats.key += 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(Buffer.from('0123456789abcdef', 'utf8'));
      return;
    }

    if (/^\/seg\/[^/]+\/[^/]+\/\d+\.ts$/.test(pathname)) {
      stats.segment += 1;
      const payload = Buffer.alloc(1880, 0x47);
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': String(payload.length),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(payload);
      return;
    }

    if (pathname === '/iframe/' || pathname.startsWith('/iframe/')) {
      send(res, 200, mediaPlaylist('iframe', '180p'));
      return;
    }

    send(res, 404, 'not found', 'text/plain');
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const port = Number(process.env.MOCK_ORIGIN_PORT || 8088);
  startMockOrigin({ port, host: '0.0.0.0' }).then(({ url }) => {
    process.stdout.write(`mock origin listening on ${url}\n`);
    process.stdout.write(`  master : ${url}/live/high/demo.m3u8\n`);
    process.stdout.write(`  variant: ${url}/v/demo/720p.m3u8\n`);
  });
}
