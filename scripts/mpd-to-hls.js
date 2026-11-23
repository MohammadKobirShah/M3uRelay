#!/usr/bin/env node
/**
 * Convert an MPD/DASH playlist into an HLS playlist.
 *
 *   node scripts/mpd-to-hls.js "JioTv GO.m3u" -o channels.hls.m3u
 *   curl -s 'https://host/playlist.m3u?q=high' | node scripts/mpd-to-hls.js - -o channels.m3u
 *   node scripts/mpd-to-hls.js provider.m3u > converted.m3u
 *
 * What it does
 *   • /live/mpd/<id>?q=high  → /live/high/<id>.m3u8   (JioTV-Go DRM channels)
 *   • /live/dash/<id>.mpd    → /live/high/<id>.m3u8
 *   • .../movie/index.mpd    → .../movie/index.m3u8
 *   • .../dash/<name>/manifest.mpd → .../high/<name>.m3u8
 *   • HLS URLs are kept verbatim, #KODIPROP (Widevine keys) lines are removed,
 *     #EXTINF / #EXTGRP / #EXTVLCOPT and the #EXTM3U header are preserved.
 *
 * Nothing is re-encoded: an MPD cannot be turned into HLS bytes without a
 * transcoder (the PRD forbids FFmpeg), so this maps each channel to the HLS
 * endpoint the same source publishes. Use `--check` to only report.
 */

import fs from 'node:fs/promises';
import { isMpdUrl, mpdToHls } from '../lib/mpd.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const outIndex = argv.findIndex((arg) => arg === '-o' || arg === '--out');
const positional = argv.filter((arg, index) => {
  if (arg === '-o' || arg === '--out' || arg === '--base') return false;
  if (outIndex >= 0 && index === outIndex + 1) return false;
  if (argv.indexOf('--base') >= 0 && index === argv.indexOf('--base') + 1) return false;
  return !arg.startsWith('--');
});

const input = positional[0];
const output = value('-o') || value('--out');
const base = value('--base');
const checkOnly = flag('--check');
const quiet = flag('--quiet');

if (!input) {
  console.error(`usage: node scripts/mpd-to-hls.js <input.m3u | - | https://…> [-o out.m3u] [--base https://relay] [--check] [--quiet]

  input      a playlist file, "-" for stdin, or an http(s) URL
  -o, --out  write the converted playlist here (default: stdout)
  --base     rewrite the scheme+host of every URL (e.g. behind a proxy)
  --check    only print the report, write nothing
  --quiet    no summary on stderr`);
  process.exit(1);
}

async function readInput(target) {
  if (target === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (/^https?:\/\//i.test(target)) {
    const response = await fetch(target, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${target}`);
    return await response.text();
  }
  return await fs.readFile(target, 'utf8');
}

function rewriteBase(url, newBase) {
  if (!newBase || !/^https?:\/\//i.test(newBase)) return url;
  try {
    const from = new URL(url);
    const to = new URL(newBase);
    from.protocol = to.protocol;
    from.host = to.host;
    return from.toString();
  } catch {
    return url;
  }
}

const text = await readInput(input);
const sourceLines = text.split(/\r?\n/);

let header = '#EXTM3U';
const blocks = [];
let pending = [];
let total = 0;
let converted = 0;
let alreadyHls = 0;
let dropped = 0;
let rebased = 0;
let seenExtinf = false;

const flush = () => {
  if (pending.length) pending = [];
};

for (const raw of sourceLines) {
  const line = raw.trim();
  if (!line) continue;

  if (!seenExtinf && /^#EXTM3U/i.test(line)) {
    header = line; // keeps x-tvg-url and friends
    continue;
  }

  if (/^#KODIPROP:/i.test(line)) continue; // Widevine/DASH keys are useless for HLS
  if (/^#EXT-X-|^#EXTINF:/i.test(line) === false && line.startsWith('#EXTM3U')) continue;

  if (/^#EXTINF:/i.test(line)) {
    seenExtinf = true;
    flush();
    pending = [line];
    continue;
  }
  if (/^#EXTGRP:|^#EXTVLCOPT:|^#EXTHTTP:/i.test(line)) {
    if (pending.length) pending.push(line);
    continue;
  }
  if (line.startsWith('#')) continue; // comments, unsupported directives

  // ---- a URL line closes the current block ----
  total += 1;
  let url = line;
  let kind = 'hls';

  if (isMpdUrl(url)) {
    const hls = mpdToHls(url);
    if (!hls || isMpdUrl(hls)) {
      dropped += 1;
      kind = 'dropped';
    } else {
      converted += 1;
      url = hls;
      kind = 'converted';
    }
  } else if (!/\.m3u8?(?:[?#]|$)/i.test(url)) {
    // Unknown manifest type (not MPD, not .m3u8) — keep it, players decide.
    kind = 'other';
  } else {
    alreadyHls += 1;
  }

  if (base) {
    const next = rewriteBase(url, base);
    if (next !== url) {
      url = next;
      rebased += 1;
    }
  }

  if (kind !== 'dropped') {
    const info = pending.find((entry) => /^#EXTINF:/i.test(entry)) || '#EXTINF:-1,Unknown';
    const extras = pending.filter((entry) => !/^#EXTINF:/i.test(entry));
    blocks.push([info, ...extras, url].join('\n'));
  }
  pending = [];
}

const listed = blocks.join('\n');
const out = [
  header,
  `# converted to HLS from ${input === '-' ? 'stdin' : input} on ${new Date().toISOString()} by scripts/mpd-to-hls.js`,
  `# ${blocks.length} channels · ${converted} MPD mapped to HLS · ${alreadyHls} already HLS${
    dropped ? ` · ${dropped} unconvertible DASH dropped` : ''
  }${rebased ? ` · ${rebased} URLs rebased to ${base}` : ''}`,
  listed,
  '',
].join('\n');

if (checkOnly) {
  if (!quiet) {
    console.error(
      `checked ${total} entries: ${converted} MPD → HLS, ${alreadyHls} already HLS, ${
        total - converted - alreadyHls - dropped
      } other, ${dropped} dropped`,
    );
  }
} else if (output) {
  await fs.writeFile(output, out);
  if (!quiet) {
    console.error(
      `wrote ${output}: ${blocks.length} channels, ${converted} MPD → HLS, ${alreadyHls} already HLS${
        dropped ? `, ${dropped} dropped` : ''
      }`,
    );
    console.error(`next: CHANNELS_FILE=${output} (or CHANNELS_URL=<where you serve it>) then restart the relay`);
  }
} else {
  process.stdout.write(out);
  if (!quiet) {
    console.error(
      `converted ${total} entries: ${converted} MPD → HLS, ${alreadyHls} already HLS${dropped ? `, ${dropped} dropped` : ''}`,
    );
  }
}
