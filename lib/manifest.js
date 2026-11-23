/**
 * HLS manifest engine — pure functions, no I/O.
 *
 * Responsibilities (see README / PRD):
 *  - keep only the 720p + 1080p rungs of a master playlist (high-only ladder)
 *  - keep only Bangla + Hindi audio renditions, Bangla default
 *  - rewrite every URI so variants/audio go through the relay and segments stay
 *    direct-to-CDN (302) or direct URLs
 *  - preserve EXT-X-VERSION / TARGETDURATION / MEDIA-SEQUENCE / KEY / MAP / PDT
 */

import { resolveUrl } from './util.js';

export const DEFAULT_TIERS = [
  { key: '720', label: '720p', width: 1280, height: 720 },
  { key: '1080', label: '1080p', width: 1920, height: 1080 },
];

export const DEFAULT_AUDIO_PREFERENCE = ['ben', 'hin'];

const URI_TAG_RE = /^#EXT-X-(?:KEY|SESSION-KEY|MAP|PART|PRELOAD-HINT|RENDITION-REPORT):/i;

/* ------------------------------------------------------------------ */
/* attribute lists                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse an HLS attribute list into ordered entries, preserving whether each
 * value was quoted (needed to round-trip CODECS="avc1.4d401f,mp4a.40.2").
 */
export function parseAttributeList(input) {
  const text = String(input ?? '');
  const entries = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && (text[i] === ',' || text[i] === ' ' || text[i] === '\t')) i += 1;
    if (i >= n) break;
    let eq = i;
    while (eq < n && text[eq] !== '=') eq += 1;
    if (eq >= n) break;
    const key = text.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i += 1;
      const start = i;
      while (i < n && text[i] !== '"') i += 1;
      value = text.slice(start, i);
      if (i < n) i += 1;
    } else {
      const start = i;
      while (i < n && text[i] !== ',') i += 1;
      value = text.slice(start, i).trim();
    }
    if (key) entries.push({ key, value, quoted });
  }
  return entries;
}

export function parseAttributes(input) {
  const out = {};
  for (const entry of parseAttributeList(input)) out[entry.key] = entry.value;
  return out;
}

export function serializeAttributes(entries) {
  return entries
    .map(({ key, value, quoted }) => {
      const needsQuotes = quoted || /[",\s]/.test(String(value));
      return needsQuotes ? `${key}="${value}"` : `${key}=${value}`;
    })
    .join(',');
}

export function attrValue(entries, key) {
  const found = (entries || []).find((entry) => entry.key === key);
  return found ? found.value : undefined;
}

export function setAttribute(entries, key, value, quoted = false) {
  const found = entries.find((entry) => entry.key === key);
  if (found) {
    found.value = String(value);
    found.quoted = quoted;
  } else {
    entries.push({ key, value: String(value), quoted });
  }
  return entries;
}

export function deleteAttribute(entries, key) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].key === key) entries.splice(i, 1);
  }
  return entries;
}

export function cloneEntries(entries) {
  return (entries || []).map(({ key, value, quoted }) => ({ key, value, quoted }));
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

export function sanitizeManifest(text) {
  let out = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const start = out.indexOf('#EXTM3U');
  if (start > 0) out = out.slice(start);
  if (!/#EXTM3U/.test(out)) throw new Error('response is not an HLS manifest');
  if (out.length < 12) throw new Error('manifest is empty');
  return out;
}

export function parseResolution(value) {
  const match = /^(\d{2,5})\s*[xX*]\s*(\d{2,5})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function tagOf(line) {
  const colon = line.indexOf(':');
  return (colon === -1 ? line : line.slice(0, colon)).toUpperCase();
}

/**
 * Parse a master (multivariant) playlist.
 * Returns variants (with resolved absolute URIs), audio/subtitle renditions,
 * session keys and the presentation-level tags worth preserving.
 */
export function parseMaster(text, baseUrl) {
  const lines = String(text ?? '').split('\n');
  const variants = [];
  const audio = [];
  const subtitles = [];
  const sessionKeys = [];
  let version = null;
  let independentSegments = false;
  let start = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line[0] !== '#') continue;
    const tag = tagOf(line);

    if (tag === '#EXT-X-VERSION') {
      version = Number(line.slice(line.indexOf(':') + 1)) || null;
    } else if (tag === '#EXT-X-INDEPENDENT-SEGMENTS') {
      independentSegments = true;
    } else if (tag === '#EXT-X-START') {
      start = line;
    } else if (tag === '#EXT-X-STREAM-INF') {
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      let uri = null;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (candidate[0] === '#') {
          if (tagOf(candidate) === '#EXT-X-STREAM-INF') break;
          continue;
        }
        uri = candidate;
        break;
      }
      if (uri) {
        variants.push({ attrs, uri: resolveUrl(uri, baseUrl), index: variants.length });
        i = j;
      }
    } else if (tag === '#EXT-X-MEDIA') {
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      const type = (attrValue(attrs, 'TYPE') || 'AUDIO').toUpperCase();
      const uri = attrValue(attrs, 'URI');
      const track = { type, attrs, uri: uri ? resolveUrl(uri, baseUrl) : null };
      if (type === 'AUDIO') audio.push(track);
      else if (type === 'SUBTITLES') subtitles.push(track);
    } else if (tag === '#EXT-X-SESSION-KEY') {
      sessionKeys.push(parseAttributeList(line.slice(line.indexOf(':') + 1)));
    }
  }

  return { variants, audio, subtitles, sessionKeys, version, independentSegments, start };
}

/**
 * Parse a media playlist into cacheable "items" so it can be re-rendered per
 * request (URLs carry the requesting origin without poisoning the cache).
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text ?? '').split('\n');
  const items = [];
  const meta = {
    targetDuration: null,
    mediaSequence: 0,
    discontinuitySequence: 0,
    version: null,
    playlistType: null,
    endList: false,
    independentSegments: false,
    segmentCount: 0,
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line[0] === '#') {
      const tag = tagOf(line);
      if (tag === '#EXT-X-TARGETDURATION') meta.targetDuration = Number(line.slice(line.indexOf(':') + 1)) || null;
      else if (tag === '#EXT-X-MEDIA-SEQUENCE') meta.mediaSequence = Number(line.slice(line.indexOf(':') + 1)) || 0;
      else if (tag === '#EXT-X-DISCONTINUITY-SEQUENCE')
        meta.discontinuitySequence = Number(line.slice(line.indexOf(':') + 1)) || 0;
      else if (tag === '#EXT-X-VERSION') meta.version = Number(line.slice(line.indexOf(':') + 1)) || null;
      else if (tag === '#EXT-X-PLAYLIST-TYPE') meta.playlistType = line.slice(line.indexOf(':') + 1).trim();
      else if (tag === '#EXT-X-ENDLIST') meta.endList = true;
      else if (tag === '#EXT-X-INDEPENDENT-SEGMENTS') meta.independentSegments = true;

      if (URI_TAG_RE.test(line)) {
        const entries = parseAttributeList(line.slice(line.indexOf(':') + 1));
        const uri = attrValue(entries, 'URI');
        if (uri) {
          items.push({
            kind: 'uri',
            tag: line.slice(0, line.indexOf(':')).toUpperCase(),
            entries,
            url: resolveUrl(uri, baseUrl),
          });
          continue;
        }
      }
      items.push({ kind: 'raw', text: line });
      continue;
    }
    meta.segmentCount += 1;
    items.push({ kind: 'segment', url: resolveUrl(line, baseUrl) });
  }

  return { items, meta };
}

/* ------------------------------------------------------------------ */
/* quality filtering                                                   */
/* ------------------------------------------------------------------ */

function pickForTier(candidates) {
  return candidates
    .slice()
    .sort((a, b) => Number(b.h264) - Number(a.h264) || b.bandwidth - a.bandwidth)[0];
}

function labelForVariant(variant) {
  if (variant.resolution && variant.resolution.height) return `${variant.resolution.height}p`;
  if (variant.bandwidth) return `${Math.round(variant.bandwidth / 1000)}k`;
  return 'source';
}

/**
 * High-only ladder: exactly one 720p rung (first = start level) and one 1080p
 * rung when the origin offers them. Everything else is deleted. If the origin
 * has no 720/1080 rung at all we keep the single best available rung instead of
 * handing the player the blurry low rung it would otherwise auto-select.
 */
export function selectVariants(variants, options = {}) {
  const tiers = options.tiers || DEFAULT_TIERS;
  const maxHeight = Math.max(...tiers.map((tier) => tier.height));
  const buckets = new Map(tiers.map((tier) => [tier.key, []]));
  const unclassified = [];

  const decorated = variants.map((variant, index) => {
    const entries = variant.attrs || [];
    const codecs = attrValue(entries, 'CODECS') || '';
    return {
      ...variant,
      index,
      resolution: parseResolution(attrValue(entries, 'RESOLUTION')),
      bandwidth: Number(attrValue(entries, 'AVERAGE-BANDWIDTH') || attrValue(entries, 'BANDWIDTH')) || 0,
      codecs,
      h264: !codecs || /avc1|avc3/i.test(codecs),
      audioGroup: attrValue(entries, 'AUDIO') || null,
    };
  });

  const hasAnyResolution = decorated.some((variant) => variant.resolution && variant.resolution.height);
  const ignored = [];

  for (const variant of decorated) {
    const height = variant.resolution && variant.resolution.height;
    if (height) {
      if (height > maxHeight) {
        ignored.push(variant); // 1440p / 2160p — never send those
        continue;
      }
      const tier = tiers.find((candidate) => candidate.height === height);
      if (tier) buckets.get(tier.key).push(variant);
      else if (height < tiers[0].height) ignored.push(variant); // 144p..576p
      continue;
    }
    if (!hasAnyResolution) {
      unclassified.push(variant);
    } else {
      ignored.push(variant);
    }
  }

  // Resolution-less manifests: infer the rung from the declared bandwidth.
  if (unclassified.length) {
    for (const variant of unclassified) {
      const tierKey = variant.bandwidth > 3_200_000 ? tiers[tiers.length - 1].key : tiers[0].key;
      buckets.get(tierKey).push(variant);
    }
  }

  const chosen = [];
  for (const tier of tiers) {
    const candidates = buckets.get(tier.key);
    if (!candidates.length) continue;
    const best = pickForTier(candidates);
    chosen.push({
      ...best,
      key: tier.key,
      label: tier.label,
      width: best.resolution ? best.resolution.width : tier.width,
      height: best.resolution ? best.resolution.height : tier.height,
      inferredResolution: !best.resolution,
      fallback: false,
    });
    for (const other of candidates) if (other !== best) ignored.push(other);
  }

  if (!chosen.length && decorated.length) {
    // No 720/1080 rung anywhere: keep the single highest rung available.
    const best = decorated
      .slice()
      .sort(
        (a, b) =>
          Number(b.h264) - Number(a.h264) ||
          (b.resolution ? b.resolution.height : 0) - (a.resolution ? a.resolution.height : 0) ||
          b.bandwidth - a.bandwidth,
      )[0];
    chosen.push({
      ...best,
      key: 'best',
      label: labelForVariant(best),
      width: best.resolution ? best.resolution.width : undefined,
      height: best.resolution ? best.resolution.height : undefined,
      fallback: true,
    });
    for (const other of decorated) if (other !== best) ignored.push(other);
  }

  return {
    variants: chosen,
    dropped: variants.length - chosen.length,
    ignored,
    total: variants.length,
  };
}

/* ------------------------------------------------------------------ */
/* audio filtering                                                     */
/* ------------------------------------------------------------------ */

export function normalizeLanguage(track) {
  const entries = track.attrs || [];
  const haystack = [attrValue(entries, 'LANGUAGE'), attrValue(entries, 'NAME'), attrValue(entries, 'GROUP-ID')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\b(ben|bn|bengali|bangla|bangla audio)\b/.test(haystack)) return 'ben';
  if (/\b(hin|hi|hindi)\b/.test(haystack)) return 'hin';
  if (/\b(eng|en|english)\b/.test(haystack)) return 'eng';
  return 'other';
}

function audioKey(lang, name, counters) {
  const base = `a-${lang === 'other' ? 'x' : lang}`;
  const next = (counters.get(base) || 0) + 1;
  counters.set(base, next);
  return `${base}${next}`;
}

/**
 * Bangla first, Hindi as backup, everything else deleted. Every audio group
 * referenced by a kept variant keeps at least one rendition so a player can
 * never end up pointing at a group that no longer exists.
 */
export function selectAudio(tracks, keptVariants, options = {}) {
  const preference = options.preference || DEFAULT_AUDIO_PREFERENCE;
  const maxPerGroup = options.maxTracksPerGroup || 2;
  const groups = new Map();
  for (const track of tracks) {
    const groupId = attrValue(track.attrs, 'GROUP-ID') || '';
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(track);
  }

  const referenced = new Set(keptVariants.map((variant) => variant.audioGroup).filter(Boolean));
  let groupIds = [...groups.keys()].filter((groupId) => referenced.size === 0 || referenced.has(groupId));
  if (!groupIds.length) groupIds = [...groups.keys()];

  const presentLangs = new Set(tracks.map(normalizeLanguage));
  const wanted = preference.filter((lang) => presentLangs.has(lang));
  const selected = [];
  const dropped = [];
  const counters = new Map();

  for (const groupId of groupIds) {
    const groupTracks = groups.get(groupId) || [];
    if (!groupTracks.length) continue;
    let picked = wanted
      .map((lang) => groupTracks.find((track) => normalizeLanguage(track) === lang))
      .filter(Boolean);
    if (!picked.length) {
      const fallback = groupTracks.find((track) => wanted.includes(normalizeLanguage(track))) || groupTracks[0];
      picked = [fallback];
    }
    picked = picked.filter((track, index) => picked.indexOf(track) === index).slice(0, Math.max(1, maxPerGroup));

    picked.forEach((track, index) => {
      const lang = normalizeLanguage(track);
      selected.push({
        key: audioKey(lang, attrValue(track.attrs, 'NAME'), counters),
        groupId,
        lang,
        name: attrValue(track.attrs, 'NAME') || attrValue(track.attrs, 'LANGUAGE') || 'Audio',
        uri: track.uri,
        attrs: track.attrs,
        default: index === 0,
        autoselect: true,
      });
    });
    for (const track of groupTracks) if (!picked.includes(track)) dropped.push(track);
  }

  // Guarantee exactly one default rendition per group.
  const perGroup = new Map();
  for (const track of selected) {
    if (!perGroup.has(track.groupId)) perGroup.set(track.groupId, track);
  }
  for (const track of selected) track.default = perGroup.get(track.groupId) === track;

  const defaultTrack = selected.find((track) => track.lang === 'ben') || selected[0] || null;
  return {
    tracks: selected,
    dropped: dropped.length,
    preference: wanted,
    defaultLang: defaultTrack ? defaultTrack.lang : null,
    defaultName: defaultTrack ? defaultTrack.name : null,
  };
}

/* ------------------------------------------------------------------ */
/* plan + rendering                                                    */
/* ------------------------------------------------------------------ */

/**
 * Turn a raw master/media playlist into the compact plan the relay caches.
 */
export function buildPlan(text, sourceUrl, options = {}) {
  const clean = sanitizeManifest(text);
  const master = parseMaster(clean, sourceUrl);

  if (!master.variants.length) {
    const media = parseMediaPlaylist(clean, sourceUrl);
    return {
      type: 'media',
      source: sourceUrl,
      version: master.version,
      independentSegments: master.independentSegments,
      variants: [
        {
          key: 'best',
          label: 'source',
          uri: sourceUrl,
          attrs: [],
          audioGroup: null,
          bandwidth: 0,
          fallback: true,
        },
      ],
      audio: [],
      sessionKeys: [],
      dropped: { variants: 0, audio: 0 },
      total: { variants: 0, audio: 0 },
      media,
    };
  }

  const quality = selectVariants(master.variants, options);
  const audio = selectAudio(master.audio, quality.variants, options);

  return {
    type: 'master',
    source: sourceUrl,
    version: master.version || 3,
    independentSegments: master.independentSegments,
    start: master.start,
    variants: quality.variants,
    audio: audio.tracks,
    sessionKeys: master.sessionKeys,
    dropped: { variants: quality.dropped, audio: audio.dropped },
    total: { variants: master.variants.length, audio: master.audio.length },
    meta: {
      defaultLang: audio.defaultLang,
      defaultAudio: audio.defaultName,
      preference: audio.preference,
    },
  };
}

/**
 * Render the filtered master playlist. `urlFor(key)` returns the relay URL for a
 * variant or audio rendition (usually /v/<channel>/<key>.m3u8).
 */
export function renderMaster(plan, { urlFor, keyUrl } = {}) {
  const lines = ['#EXTM3U'];
  if (plan.version) lines.push(`#EXT-X-VERSION:${plan.version}`);
  if (plan.independentSegments) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (plan.start) lines.push(plan.start);

  const keptGroups = new Set();
  for (const track of plan.audio || []) {
    const entries = cloneEntries(track.attrs);
    setAttribute(entries, 'DEFAULT', track.default ? 'YES' : 'NO');
    setAttribute(entries, 'AUTOSELECT', track.autoselect ? 'YES' : 'NO');
    setAttribute(entries, 'FORCED', 'NO');
    if (track.uri && urlFor) setAttribute(entries, 'URI', urlFor(track.key), true);
    else deleteAttribute(entries, 'URI');
    lines.push(`#EXT-X-MEDIA:${serializeAttributes(entries)}`);
    keptGroups.add(track.groupId);
  }

  for (const entries of plan.sessionKeys || []) {
    const clone = cloneEntries(entries);
    const uri = attrValue(clone, 'URI');
    if (uri) setAttribute(clone, 'URI', keyUrl ? keyUrl(uri) : uri, true);
    lines.push(`#EXT-X-SESSION-KEY:${serializeAttributes(clone)}`);
  }

  for (const variant of plan.variants) {
    const entries = cloneEntries(variant.attrs);
    if (variant.width && variant.height) setAttribute(entries, 'RESOLUTION', `${variant.width}x${variant.height}`);
    if (!variant.audioGroup || !keptGroups.has(variant.audioGroup)) deleteAttribute(entries, 'AUDIO');
    deleteAttribute(entries, 'SUBTITLES');
    deleteAttribute(entries, 'CLOSED-CAPTIONS');
    lines.push(`#EXT-X-STREAM-INF:${serializeAttributes(entries)}`);
    lines.push(urlFor ? urlFor(variant.key) : variant.uri);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render a parsed media playlist with rewritten URI lines.
 * Handlers receive the absolute origin URL and return the URL the player sees.
 */
export function renderMediaPlaylist(parsed, handlers = {}) {
  const out = [];
  for (const item of parsed.items) {
    if (item.kind === 'raw') {
      out.push(item.text);
      continue;
    }
    if (item.kind === 'segment') {
      out.push(handlers.segment ? handlers.segment(item.url) : item.url);
      continue;
    }
    const tag = item.tag.toUpperCase();
    const handler =
      tag === '#EXT-X-KEY' || tag === '#EXT-X-SESSION-KEY'
        ? handlers.key
        : tag === '#EXT-X-MAP'
          ? handlers.map || handlers.segment
          : handlers.part || handlers.segment;
    const entries = item.entries.map((entry) =>
      entry.key === 'URI'
        ? { ...entry, value: handler ? handler(item.url) : item.url, quoted: true }
        : entry,
    );
    out.push(`${item.tag}:${serializeAttributes(entries)}`);
  }
  return `${out.join('\n')}\n`;
}

/** Compact description used by the API/panel badges. */
export function describePlan(plan) {
  if (!plan) return null;
  return {
    type: plan.type,
    variants: (plan.variants || []).map((variant) => ({
      key: variant.key,
      label: variant.label,
      width: variant.width,
      height: variant.height,
      bandwidth: variant.bandwidth,
      fallback: Boolean(variant.fallback),
    })),
    audio: (plan.audio || []).map((track) => ({
      key: track.key,
      name: track.name,
      lang: track.lang,
      default: Boolean(track.default),
    })),
    defaultAudio: plan.meta ? plan.meta.defaultAudio : null,
    dropped: plan.dropped,
    total: plan.total,
  };
}
