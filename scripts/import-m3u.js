#!/usr/bin/env node
/**
 * Convert any provider playlist into the relay's channel list.
 *
 *   node scripts/import-m3u.js provider.m3u [channels.m3u] [--force] [--absolute]
 *
 * - /live/low/, /live/medium/ and /live/auto/ URLs are rewritten to /live/high/
 * - JioTV-Go DRM entries (/live/mpd/<id>?q=high) are mapped to their HLS twin
 * - JioTV-Go style /live/high/<id>.m3u8 URLs become `high://<id>` (id-based,
 *   so the token always stays fresh in the warmer)
 * - anything else is kept as an absolute URL
 * - --absolute keeps every HLS URL verbatim instead of collapsing it to
 *   `high://<id>` (needs no UPSTREAM_BASE, handy for a mixed playlist)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseChannelList } from '../lib/channels.js';

const flags = new Set(['--force', '--absolute']);
const args = process.argv.slice(2).filter((arg) => !flags.has(arg));
const force = process.argv.includes('--force');
const absolute = process.argv.includes('--absolute');
const input = args[0];
const output = args[1] || 'channels.m3u';

if (!input) {
  console.error('usage: node scripts/import-m3u.js <provider.m3u> [channels.m3u] [--force] [--absolute]');
  process.exit(1);
}

const text = await fs.readFile(input, 'utf8');
const { channels, duplicates } = parseChannelList(text);

if (!channels.length) {
  console.error(`no channels found in ${input}`);
  process.exit(1);
}

if (!force) {
  try {
    await fs.access(output);
    console.error(`${output} already exists — pass --force to overwrite`);
    process.exit(1);
  } catch {
    /* does not exist, fine */
  }
}

// Only provider-style single-segment URLs are converted to ids; anything else
// (CDN folders, dash URLs, query-signed links) stays a verbatim absolute URL.
const ID_PATTERNS = [
  /\/live\/(?:high|auto|low|medium)\/([^/?#]+?)(?:\.m3u8?)?(?:[?#]|$)/i,
  /\/live\/([^/?#]+?)(?:\.m3u8?)?(?:[?#]|$)/i,
  /[?&](?:channel|channelId|id)=([^&]+)/i,
];

function normalize(url) {
  return String(url || '')
    .replace(/\/live\/(low|medium|auto)\//i, '/live/high/')
    .replace(/\/live\/(low|medium|auto)(?=[/?#]|$)/i, '/live/high')
    // DASH/Widevine entry -> the HLS endpoint that JioTV-Go also serves.
    .replace(/\/live\/mpd\/([^/?#]+)(?:\?[^#]*)?/i, '/live/high/$1.m3u8');
}

let fromIds = 0;
let fromUrls = 0;
let rewritten = 0;
let dashMapped = 0;

const lines = [
  '#EXTM3U',
  `# Imported from ${path.basename(input)} on ${new Date().toISOString()} by scripts/import-m3u.js`,
  absolute
    ? '# every stream URL below is the HLS /live/high/<id>.m3u8 endpoint (DASH entries converted)'
    : '# high://<id> channels always resolve to <UPSTREAM_BASE>/live/high/<id>.m3u8',
  '',
];

for (const channel of channels) {
  let providerId = channel.providerId || null;
  let customUrl = channel.customUrl || null;

  if (customUrl) {
    const normalized = normalize(customUrl);
    if (normalized !== customUrl) {
      if (/\/live\/mpd\//i.test(customUrl)) dashMapped += 1;
      else rewritten += 1;
    }
    customUrl = normalized;
    if (!providerId) {
      for (const pattern of ID_PATTERNS) {
        const match = pattern.exec(customUrl);
        if (match && match[1] && !/^https?:$/i.test(match[1])) {
          providerId = decodeURIComponent(match[1]);
          break;
        }
      }
    }
    // A URL that still carries a quality path is best handled by id.
    if (providerId && /\/live\//i.test(customUrl) && !absolute) customUrl = null;
  }

  if (!providerId && !customUrl) continue;

  const attrs = [`tvg-id="${channel.id}"`, `tvg-name="${escapeAttr(channel.name)}"`];
  if (channel.logo) attrs.push(`tvg-logo="${escapeAttr(channel.logo)}"`);
  if (channel.group) attrs.push(`group-title="${escapeAttr(channel.group)}"`);
  if (channel.language) attrs.push(`tvg-language="${escapeAttr(channel.language)}"`);
  lines.push(`#EXTINF:-1 ${attrs.join(' ')},${channel.name}`);
  if (absolute && customUrl && isHls(customUrl)) {
    lines.push(customUrl);
    fromUrls += 1;
  } else if (providerId) {
    lines.push(`high://${providerId}`);
    fromIds += 1;
  } else {
    lines.push(customUrl);
    fromUrls += 1;
  }
}

await fs.writeFile(output, `${lines.join('\n')}\n`);

function isHls(url) {
  return /\/live\/high\/[^/?#]+\.m3u8?(?:[?#]|$)/i.test(url) || /\.m3u8?(?:[?#]|$)/i.test(url);
}

console.log(`imported ${fromIds + fromUrls} channels into ${output}`);
console.log(`  ${fromIds} id-based (high://…)   ${fromUrls} absolute URL`);
if (rewritten) console.log(`  ${rewritten} low/medium/auto URLs rewritten to /live/high/`);
if (dashMapped) console.log(`  ${dashMapped} DRM (DASH) channels mapped to their HLS endpoint`);
if (absolute) console.log('  --absolute: every stream URL is a full HLS URL (no UPSTREAM_BASE needed)');
if (duplicates.length) console.log(`  ${duplicates.length} duplicate channel ids skipped`);
console.log('next: set UPSTREAM_BASE (if using high:// ids) and restart the relay');

function escapeAttr(value) {
  return String(value || '').replace(/"/g, "'");
}
