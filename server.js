#!/usr/bin/env node
/**
 * MY IPTV PRO — manifest-only HLS relay.
 *
 *   client ── master.m3u8 ──▶ relay (RAM cache, 720p+1080p, Bangla-first)
 *   client ── variant.m3u8 ─▶ relay (rewritten, segments point at the CDN)
 *   client ── segment ─────▶ 302 ─▶ origin CDN (0 bytes through this process)
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { Upstream } from './lib/upstream.js';
import { Relay } from './lib/relay.js';
import {
  buildPlan,
  describePlan,
  renderMaster,
  renderMediaPlaylist,
  sanitizeManifest,
} from './lib/manifest.js';
import { groupSummary } from './lib/channels.js';
import {
  b64urlDecode,
  b64urlEncode,
  escapeXml,
  isHttpUrl,
  isPrivateHost,
  requestOrigin,
  signUrl,
  verifyUrl,
} from './lib/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : HERE;

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel, format: config.logFormat });
const upstream = new Upstream(config, logger.child('upstream'));
const relay = new Relay({ config, logger: logger.child('relay'), upstream });

/* ------------------------------------------------------------------ */
/* static assets                                                       */
/* ------------------------------------------------------------------ */

function loadStatic(filePath) {
  const raw = fs.readFileSync(filePath);
  return {
    raw,
    gzip: zlib.gzipSync(raw, { level: 9 }),
    mtimeMs: fs.statSync(filePath).mtimeMs,
    size: raw.length,
  };
}

const staticFiles = new Map();
function staticEntry(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  let entry = staticFiles.get(absolute);
  try {
    const stat = fs.statSync(absolute);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      entry = loadStatic(absolute);
      staticFiles.set(absolute, entry);
    }
    return entry;
  } catch {
    return entry || null;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* response helpers                                                    */
/* ------------------------------------------------------------------ */

const CORS = {
  'access-control-allow-origin': config.allowOrigin,
  'access-control-allow-methods': 'GET,HEAD,OPTIONS',
  'access-control-allow-headers': 'Range,Origin,Accept,Content-Type,Authorization,X-Requested-With',
  'access-control-expose-headers': 'Content-Length,Content-Range,Date,X-Relay-Cache,X-Relay-Latency',
  'access-control-max-age': '86400',
};

function baseHeaders(extra = {}) {
  return {
    ...CORS,
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function send(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const accept = String(req.headers['accept-encoding'] || '');
  const isText = typeof body !== 'object' || Buffer.isBuffer(body);
  const headersOut = baseHeaders(headers);
  if (req.method === 'HEAD') {
    headersOut['content-length'] = String(buf.length);
    res.writeHead(status, headersOut);
    res.end();
    return;
  }
  const contentType = String(headersOut['content-type'] || '');
  const compressible = /^(text\/|application\/(json|javascript|xml|x-mpegurl|vnd\.apple\.mpegurl)|image\/svg)/.test(contentType);
  if (isText && compressible && buf.length > 512 && /\bgzip\b/.test(accept) && !headersOut['content-encoding']) {
    const zipped = zlib.gzipSync(buf);
    res.writeHead(status, { ...headersOut, 'content-encoding': 'gzip', 'content-length': String(zipped.length), vary: 'accept-encoding' });
    res.end(zipped);
    return;
  }
  headersOut['content-length'] = String(buf.length);
  res.writeHead(status, headersOut);
  res.end(buf);
}

function sendJson(req, res, status, payload, headers = {}) {
  send(req, res, status, JSON.stringify(payload), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
}

function sendManifest(req, res, text, meta = {}) {
  send(req, res, 200, text, {
    'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
    ...meta,
  });
}

function errorStatus(error) {
  if (!error) return 502;
  if (error.name === 'RelayError' && error.status) return error.status;
  if (error.status === 404) return 404;
  if (error.status === 400) return 400;
  if (error.kind === 'config') return 500;
  return 502;
}

function sendError(req, res, error) {
  const status = errorStatus(error);
  const message = (error && error.message ? error.message : 'relay error').slice(0, 300);
  sendJson(req, res, status, { error: message, code: (error && (error.kind || error.name)) || 'error' }, { 'retry-after': '1' });
  logger.debug(`request failed: ${message}`);
}

/* ------------------------------------------------------------------ */
/* URL builders (origin-aware, signed)                                 */
/* ------------------------------------------------------------------ */

function signPayload(url, channelId) {
  return channelId ? `${channelId}|${url}` : url;
}

function buildUrlBuilders(origin, channel) {
  const channelPath = `/v/${encodeURIComponent(channel.id)}`;
  const variantUrl = (key) => `${origin}${channelPath}/${encodeURIComponent(key)}.m3u8`;

  const segmentUrl = (absolute) => {
    const target = upstream.applySegmentAuth(absolute, channel);
    if (config.segmentMode === 'direct') return target;
    const signature = signUrl(config.urlSecret, signPayload(target, channel.id));
    return `${origin}/s?u=${b64urlEncode(target)}&c=${encodeURIComponent(channel.id)}&sig=${signature}`;
  };

  const keyUrl = (absolute) => {
    if (!isHttpUrl(absolute)) return absolute;
    const signature = signUrl(config.urlSecret, signPayload(absolute, channel.id));
    return `${origin}/k?u=${b64urlEncode(absolute)}&c=${encodeURIComponent(channel.id)}&sig=${signature}`;
  };

  return { variantUrl, segmentUrl, keyUrl };
}

function mediaHandlers(builders) {
  return {
    segment: (absolute) => builders.segmentUrl(absolute),
    map: (absolute) => builders.segmentUrl(absolute),
    key: (absolute) => builders.keyUrl(absolute),
    part: (absolute) => builders.segmentUrl(absolute),
  };
}

/* ------------------------------------------------------------------ */
/* route handlers                                                      */
/* ------------------------------------------------------------------ */

async function handleMaster(req, res, channelId, origin) {
  const channel = relay.getChannel(channelId);
  if (!channel) {
    sendJson(req, res, 404, { error: 'unknown channel', id: channelId });
    return;
  }
  relay.touch(channel.id);
  relay.counters.playlistRequests += 1;
  const started = performance.now();

  let entry;
  try {
    entry = await relay.getMaster(channel);
  } catch (error) {
    sendError(req, res, error);
    return;
  }
  if (!entry || !entry.plan) {
    sendJson(req, res, 503, { error: 'manifest not ready', id: channel.id }, { 'retry-after': '1' });
    return;
  }

  const builders = buildUrlBuilders(origin, channel);
  let text;
  if (entry.plan.type === 'media') {
    text = renderMediaPlaylist(entry.plan.media, mediaHandlers(builders));
  } else {
    text = renderMaster(entry.plan, {
      urlFor: builders.variantUrl,
      keyUrl: builders.keyUrl,
    });
  }

  const age = Date.now() - entry.fetchedAt;
  sendManifest(req, res, text, {
    'x-relay-cache': age <= config.cacheTtlMs ? 'hit' : 'stale',
    'x-relay-latency': (performance.now() - started).toFixed(2),
    'x-relay-source': entry.endpoint || 'upstream',
    'x-relay-channel': channel.id,
  });
}

async function handleVariant(req, res, channelId, key, origin) {
  const channel = relay.getChannel(channelId);
  if (!channel) {
    sendJson(req, res, 404, { error: 'unknown channel', id: channelId });
    return;
  }
  relay.touch(channel.id);
  const started = performance.now();
  let entry;
  try {
    entry = await relay.getMedia(channel, key);
  } catch (error) {
    sendError(req, res, error);
    return;
  }
  const builders = buildUrlBuilders(origin, channel);
  const text = renderMediaPlaylist({ items: entry.items, meta: entry.meta }, mediaHandlers(builders));
  const age = Date.now() - entry.fetchedAt;
  sendManifest(req, res, text, {
    'x-relay-cache': age <= config.mediaCacheTtlMs ? 'hit' : 'stale',
    'x-relay-latency': (performance.now() - started).toFixed(2),
    'x-relay-channel': channel.id,
    'x-relay-rendition': key,
  });
}

async function handleSegment(req, res, url) {
  const raw = url.searchParams.get('u');
  const signature = url.searchParams.get('sig') || '';
  const channelId = url.searchParams.get('c') || '';
  const target = b64urlDecode(raw || '');
  if (!target || !isHttpUrl(target)) {
    sendJson(req, res, 400, { error: 'invalid segment url' });
    return;
  }
  if (!verifyUrl(config.urlSecret, signPayload(target, channelId), signature)) {
    sendJson(req, res, 403, { error: 'bad signature' });
    return;
  }
  const channel = channelId ? relay.getChannel(channelId) : null;

  if (config.segmentMode !== 'proxy') {
    relay.counters.segmentRedirects += 1;
    res.writeHead(302, baseHeaders({ location: target, 'cache-control': 'no-store' }));
    res.end();
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(req, res, 400, { error: 'invalid segment url' });
    return;
  }
  if (config.blockPrivateHosts && isPrivateHost(parsed.hostname)) {
    sendJson(req, res, 403, { error: 'private host blocked' });
    return;
  }

  relay.counters.segmentProxies += 1;
  const headers = upstream.headersFor(channel);
  if (req.headers.range) headers.range = req.headers.range;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.segmentTimeoutMs);
  try {
    const response = await fetch(target, { headers, redirect: 'follow', signal: controller.signal });
    const outHeaders = baseHeaders({
      'content-type': response.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'no-store',
      'accept-ranges': response.headers.get('accept-ranges') || 'bytes',
    });
    for (const name of ['content-range', 'etag', 'last-modified']) {
      const value = response.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    const length = response.headers.get('content-length');
    if (length && !outHeaders['content-range']) outHeaders['content-length'] = length;
    res.writeHead(response.status, outHeaders);
    if (!response.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    res.on('close', () => {
      if (!res.writableFinished) stream.destroy();
    });
  } catch (error) {
    if (!res.headersSent) sendJson(req, res, 502, { error: 'segment fetch failed' });
    else res.destroy();
  } finally {
    clearTimeout(timer);
  }
}

async function handleKey(req, res, url) {
  const target = b64urlDecode(url.searchParams.get('u') || '');
  const channelId = url.searchParams.get('c') || '';
  const signature = url.searchParams.get('sig') || '';
  if (!target || !isHttpUrl(target)) {
    sendJson(req, res, 400, { error: 'invalid key url' });
    return;
  }
  if (!verifyUrl(config.urlSecret, signPayload(target, channelId), signature)) {
    sendJson(req, res, 403, { error: 'bad signature' });
    return;
  }
  const channel = channelId ? relay.getChannel(channelId) : null;
  try {
    const buffer = await relay.getKey(channel, target);
    send(req, res, 200, buffer, {
      'content-type': 'application/octet-stream',
      'content-length': String(buffer.length),
      'cache-control': 'public, max-age=600',
    });
  } catch (error) {
    sendError(req, res, error);
  }
}

async function handlePlaylist(req, res, url, origin) {
  const quality = (url.searchParams.get('q') || config.playlistQuality || 'high').toLowerCase();
  if (quality === 'low' || quality === 'medium') {
    sendJson(req, res, 400, {
      error: 'low/medium are disabled by design',
      hint: 'this relay is high-only; use /playlist.m3u?q=high',
    });
    return;
  }
  const lines = ['#EXTM3U'];
  for (const channel of relay.channels) {
    const attrs = [];
    attrs.push(`tvg-id="${escapeXml(channel.id)}"`);
    if (channel.logo) attrs.push(`tvg-logo="${escapeXml(channel.logo)}"`);
    if (channel.group) attrs.push(`group-title="${escapeXml(channel.group)}"`);
    if (channel.language) attrs.push(`tvg-language="${escapeXml(channel.language)}"`);
    attrs.push(`tvg-chno="${channel.number || channel.order + 1}"`);
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${channel.name}`);
    lines.push(`${origin}/live/high/${encodeURIComponent(channel.id)}.m3u8`);
  }
  relay.counters.playlistRequests += 1;
  send(req, res, 200, `${lines.join('\n')}\n`, {
    'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'cache-control': 'no-cache',
    'content-disposition': 'inline; filename="playlist.m3u"',
  });
}

function handleChannels(req, res) {
  const channels = relay.channels.map((channel) => relay.channelView(channel));
  sendJson(req, res, 200, {
    generatedAt: Date.now(),
    total: channels.length,
    groups: groupSummary(relay.channels),
    channels,
  });
}

function handleStatus(req, res) {
  sendJson(req, res, 200, relay.snapshot());
}

function handleHealth(req, res) {
  const snapshot = relay.snapshot();
  const total = snapshot.channels.total || 1;
  const ratio = snapshot.channels.warmed / total;
  const ok = snapshot.channels.warmed > 0 && ratio >= config.healthWarmRatio;
  sendJson(req, res, ok ? 200 : 503, {
    ok,
    warmed: snapshot.channels.warmed,
    total: snapshot.channels.total,
    ratio: Number(ratio.toFixed(2)),
    warmerRunning: snapshot.warmer.running,
    uptimeSec: snapshot.server.uptimeSec,
  });
}

function handleChannelDetail(req, res, id) {
  const channel = relay.getChannel(id);
  if (!channel) {
    sendJson(req, res, 404, { error: 'unknown channel', id });
    return;
  }
  const view = relay.channelView(channel);
  const entry = relay.masters.get(channel.id);
  sendJson(req, res, 200, { ...view, plan: entry ? describePlan(entry.plan) : null });
}

async function handleDebugManifest(req, res, id) {
  const channel = relay.getChannel(id);
  if (!channel) {
    sendJson(req, res, 404, { error: 'unknown channel', id });
    return;
  }
  try {
    const fetched = await upstream.fetchMaster(channel);
    const plan = buildPlan(sanitizeManifest(fetched.text), fetched.url);
    sendJson(req, res, 200, {
      channelId: channel.id,
      endpoint: fetched.endpoint,
      source: fetched.url,
      plan: describePlan(plan),
      variants: plan.variants.map((variant) => ({ key: variant.key, uri: variant.uri, height: variant.height })),
      audio: plan.audio.map((track) => ({ key: track.key, name: track.name, lang: track.lang, uri: track.uri })),
    });
  } catch (error) {
    sendError(req, res, error);
  }
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, relativePath, { immutable = false, type } = {}) {
  const entry = staticEntry(relativePath);
  if (!entry) {
    sendJson(req, res, 404, { error: 'not found', path: relativePath });
    return;
  }
  const ext = path.extname(relativePath).toLowerCase();
  const contentType = type || TYPES[ext] || 'application/octet-stream';
  const headers = baseHeaders({
    'content-type': contentType,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (acceptsGzip) {
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(entry.gzip.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : entry.gzip);
    return;
  }
  headers['content-length'] = String(entry.raw.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : entry.raw);
}

async function router(req, res) {
  const started = performance.now();
  const origin = requestOrigin(req, config.publicUrl);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, baseHeaders());
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return;
  }

  let url;
  try {
    url = new URL(req.url || '/', origin);
  } catch {
    sendJson(req, res, 400, { error: 'bad request' });
    return;
  }
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html' || pathname === '/panel' || pathname === '/panel/') {
    serveStatic(req, res, 'panel/index.html');
    return;
  }
  if (pathname === '/panel/index.html') {
    serveStatic(req, res, 'panel/index.html');
    return;
  }
  if (pathname === '/vendor/hls.min.js' || pathname === '/panel/vendor/hls.min.js' || pathname === '/hls.min.js') {
    serveStatic(req, res, 'panel/vendor/hls.min.js', { type: TYPES['.js'] });
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204, baseHeaders());
    res.end();
    return;
  }
  if (pathname === '/health' || pathname === '/healthz' || pathname === '/api/health') {
    handleHealth(req, res);
    return;
  }
  if (pathname === '/api/channels') {
    handleChannels(req, res);
    return;
  }
  if (pathname === '/api/status') {
    handleStatus(req, res);
    return;
  }
  if (pathname === '/api/reload' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      await relay.loadChannels();
      sendJson(req, res, 200, { ok: true, channels: relay.channels.length });
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message });
    }
    return;
  }
  if (pathname === '/api/debug/channel' || pathname.startsWith('/api/debug/channel/')) {
    const id = url.searchParams.get('id') || pathname.replace('/api/debug/channel/', '');
    await handleDebugManifest(req, res, decodeURIComponent(id));
    return;
  }
  if (pathname === '/api/channels/' || pathname.startsWith('/api/channels/')) {
    handleChannelDetail(req, res, decodeURIComponent(pathname.replace('/api/channels/', '')));
    return;
  }
  if (pathname === '/playlist.m3u' || pathname === '/playlist.m3u8' || pathname === '/playlist') {
    await handlePlaylist(req, res, url, origin);
    return;
  }
  if (pathname === '/s' || pathname === '/segment') {
    await handleSegment(req, res, url);
    return;
  }
  if (pathname === '/k' || pathname === '/key') {
    await handleKey(req, res, url);
    return;
  }

  const variantMatch = /^\/v\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (variantMatch) {
    const channelId = decodeURIComponent(variantMatch[1]);
    let key = variantMatch[2];
    if (/\.m3u8?$/i.test(key)) key = key.replace(/\.m3u8?$/i, '');
    await handleVariant(req, res, channelId, decodeURIComponent(key), origin);
    return;
  }

  const liveMatch = /^\/live\/(?:(high|auto|low|medium)\/)?(.+)$/i.exec(pathname);
  if (liveMatch) {
    const quality = (liveMatch[1] || 'high').toLowerCase();
    let channelId = liveMatch[2];
    if (/\.m3u8?$/i.test(channelId)) channelId = channelId.replace(/\.m3u8?$/i, '');
    channelId = decodeURIComponent(channelId);
    if (quality === 'low' || quality === 'medium') {
      sendJson(req, res, 400, {
        error: 'low/medium endpoints are disabled by design',
        hint: `use /live/high/${encodeURIComponent(channelId)}.m3u8`,
      });
      return;
    }
    await handleMaster(req, res, channelId, origin);
    return;
  }

  sendJson(req, res, 404, { error: 'not found', path: pathname });
  logger.debug(`404 ${pathname} (${(performance.now() - started).toFixed(1)}ms)`);
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  router(req, res).catch((error) => {
    logger.error('unhandled request error', error);
    if (!res.headersSent) sendError(req, res, error);
    else res.destroy();
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

async function main() {
  try {
    await relay.loadChannels();
  } catch (error) {
    relay.channelFileError = error.message;
    logger.error(`cannot load channel list: ${error.message}`);
    logger.error('serving the panel anyway — fix CHANNELS_FILE or mount channels.m3u, then POST /api/reload');
  }
  relay.watchChannels();

  if (!config.upstreamBase && !relay.channels.some((channel) => channel.customUrl)) {
    logger.warn('UPSTREAM_BASE is not set and channels.m3u has no absolute URLs — playback will fail until you set it');
  }
  if (config.segmentMode === 'proxy') {
    logger.warn('SEGMENT_MODE=proxy: segments flow through this server (bandwidth is no longer 0)');
  }

  relay.start();

  server.listen(config.port, config.host, () => {
    const shown = config.publicUrl || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
    logger.info(`panel      ${shown}/`);
    logger.info(`playlist   ${shown}/playlist.m3u?q=high`);
    logger.info(`manifest   ${shown}/live/high/<channel>.m3u8`);
    logger.info(`channels   ${relay.channels.length} from ${config.channelsFile}`);
    if (config.upstreamBase) logger.info(`upstream   ${config.upstreamBase}${config.upstreamHighPath}`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);
    server.close();
    await relay.stop();
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => logger.error('unhandled rejection', error));
}

main().catch((error) => {
  logger.error('fatal startup error', error);
  process.exit(1);
});

export { server, relay, config, router, buildPlan, renderMaster };
