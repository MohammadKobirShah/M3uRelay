/**
 * Parse an M3U/M3U8 channel list.
 *
 * Supported URL forms on the line after #EXTINF:
 *   high://101            -> provider channel id (relay builds /live/high/101.m3u8)
 *   auto://101            -> same, high endpoint still wins
 *   https://host/x.m3u8   -> absolute master manifest, used verbatim
 *   https://host/{id}.m3u8-> template, {id} replaced from tvg-id (or name slug)
 *   /live/high/x.m3u8     -> relative, resolved against options.baseUrl
 *   101                   -> bare provider id
 *
 * #EXTVLCOPT:http-user-agent= / http-referrer= / http-origin= / http-cookie= are
 * captured as upstream headers (needed by some CDNs).
 */

import { banglaGroupName } from './bangla.js';

const PROVIDER_SCHEME_RE = /^(high|auto|jio|jiotv|provider):\/\//i;

function findSeparator(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) return i;
  }
  return line.lastIndexOf(',');
}

export function slugify(value, fallback = 'channel') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

/** Channel ids end up in URL paths, so keep them to an unreserved alphabet. */
function sanitizeId(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._~-]/g, '');
  return cleaned || fallback;
}

function parseExtinf(line) {
  const body = line.slice(line.toUpperCase().startsWith('#EXTINF:') ? 8 : 0).trim();
  const sep = findSeparator(body);
  const head = sep === -1 ? body : body.slice(0, sep);
  const name = sep === -1 ? '' : body.slice(sep + 1).trim();
  const attrsPart = head.replace(/^-?\d+(\.\d+)?/, '').trim();
  const attrs = {};
  // Reuse the HLS attribute parser shape: key="value" pairs separated by spaces.
  const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match;
  while ((match = re.exec(attrsPart))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return { attrs, name };
}

function parseVlcOpt(line) {
  const body = line.replace(/^#EXTVLCOPT:/i, '').trim();
  const eq = body.indexOf('=');
  if (eq === -1) return null;
  const option = body.slice(0, eq).trim().toLowerCase();
  const value = body.slice(eq + 1).trim();
  switch (option) {
    case 'http-user-agent':
      return ['user-agent', value];
    case 'http-referrer':
    case 'http-referer':
    case 'http-referrer-uri':
      return ['referer', value];
    case 'http-origin':
      return ['origin', value];
    case 'http-cookie':
      return ['cookie', value];
    default:
      return null;
  }
}

export function parseChannelList(text, options = {}) {
  const defaultGroup = options.defaultGroup || 'Other';
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const channels = [];
  const duplicates = [];
  const seen = new Set();
  let pending = null;
  let pendingHeaders = {};
  let pendingGroup = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#EXTINF:/i.test(line)) {
      pending = parseExtinf(line);
      pendingHeaders = {};
      pendingGroup = null;
      continue;
    }
    if (/^#EXTGRP:/i.test(line)) {
      pendingGroup = line.replace(/^#EXTGRP:/i, '').trim();
      continue;
    }
    if (/^#EXTVLCOPT:/i.test(line)) {
      const parsed = parseVlcOpt(line);
      if (parsed) pendingHeaders[parsed[0]] = parsed[1];
      continue;
    }
    if (line.startsWith('#')) continue; // #EXTM3U, #KODIPROP, comments

    const info = pending || { attrs: {}, name: '' };
    pending = null;

    const attrs = info.attrs || {};
    let sourceUrl = null;
    let providerId = null;
    const url = line;

    if (PROVIDER_SCHEME_RE.test(url)) {
      providerId = url.replace(PROVIDER_SCHEME_RE, '').replace(/\/+$/, '');
    } else if (/^https?:\/\//i.test(url)) {
      sourceUrl = url;
    } else if (options.baseUrl && /^[./]/.test(url) && !/\s/.test(url)) {
      try {
        sourceUrl = new URL(url, options.baseUrl).toString();
      } catch {
        continue;
      }
    } else if (/^\{id\}$/.test(url) || !/\s/.test(url)) {
      providerId = url;
    } else {
      continue; // unparseable line — skip rather than crash boot
    }

    const tvgId = (attrs['tvg-id'] || '').trim();
    const name = (info.name || attrs['tvg-name'] || tvgId || providerId || 'Unknown').trim();
    const explicitId = tvgId || providerId;
    const id = explicitId
      ? sanitizeId(explicitId, `ch-${channels.length + 1}`)
      : slugify(name, `ch-${channels.length + 1}`);

    if (seen.has(id)) {
      duplicates.push({ id, name });
      continue;
    }
    seen.add(id);

    // JioTV-Go marks DRM channels as DASH: /live/mpd/<id>?q=high
    let dash = false;
    let dashId = null;
    if (sourceUrl) {
      const mpd = /\/live\/mpd\/([^/?#]+)/i.exec(sourceUrl);
      if (mpd) {
        dash = true;
        try {
          dashId = decodeURIComponent(mpd[1]);
        } catch {
          dashId = mpd[1];
        }
        if (!providerId) providerId = dashId;
      }
    }

    const rawUrl = sourceUrl || '';
    channels.push({
      id,
      name,
      logo: attrs['tvg-logo'] || attrs['logo'] || '',
      group: (attrs['group-title'] || pendingGroup || defaultGroup).trim() || defaultGroup,
      language: attrs['tvg-language'] || attrs['language'] || '',
      number: Number(attrs['tvg-chno'] || attrs['channel-number'] || 0) || null,
      providerId: providerId || (rawUrl.includes('{id}') ? tvgId || null : null),
      customUrl: sourceUrl,
      dash,
      dashId,
      headers: pendingHeaders,
      original: {
        name,
        url,
      },
      order: channels.length,
    });
  }

  return { channels, duplicates };
}

export function channelById(channels, id) {
  if (!id) return null;
  const decoded = safeDecode(id);
  return (
    channels.find((channel) => channel.id === id) ||
    channels.find((channel) => channel.id === decoded) ||
    null
  );
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function groupSummary(channels) {
  const counts = new Map();
  for (const channel of channels) counts.set(channel.group, (counts.get(channel.group) || 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, labelBn: banglaGroupName(name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const LANGUAGE_ALIASES = new Map([
  ['bangla', 'bangla'],
  ['bengali', 'bangla'],
  ['bn', 'bangla'],
  ['ben', 'bangla'],
  ['hindi', 'hindi'],
  ['hin', 'hindi'],
  ['hi', 'hindi'],
  ['english', 'english'],
  ['eng', 'english'],
  ['en', 'english'],
  ['tamil', 'tamil'],
  ['tam', 'tamil'],
  ['ta', 'tamil'],
  ['telugu', 'telugu'],
  ['tel', 'telugu'],
  ['te', 'telugu'],
  ['kannada', 'kannada'],
  ['kan', 'kannada'],
  ['malayalam', 'malayalam'],
  ['mal', 'malayalam'],
  ['marathi', 'marathi'],
  ['mar', 'marathi'],
  ['punjabi', 'punjabi'],
  ['pan', 'punjabi'],
  ['gujarati', 'gujarati'],
  ['guj', 'gujarati'],
  ['odia', 'odia'],
  ['oriya', 'odia'],
  ['ori', 'odia'],
  ['urdu', 'urdu'],
  ['urd', 'urdu'],
  ['bhojpuri', 'bhojpuri'],
  ['assamese', 'assamese'],
  ['nepali', 'nepali'],
  ['french', 'french'],
]);

/** Canonical, comparable form of a channel language ("Bengali" -> "bangla"). */
export function languageKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return LANGUAGE_ALIASES.get(raw) || raw;
}

/**
 * Keep only channels whose language is in `allowed` (any spelling).
 * Channels with no language at all are dropped while the filter is active.
 */
export function filterByLanguages(channels, allowed) {
  const keys = new Set((allowed || []).map(languageKey).filter(Boolean));
  if (!keys.size) return { channels, removed: [] };
  const kept = [];
  const removed = [];
  for (const channel of channels) {
    const key = languageKey(channel.language);
    if (key && keys.has(key)) kept.push(channel);
    else removed.push(channel);
  }
  return { channels: kept, removed };
}
