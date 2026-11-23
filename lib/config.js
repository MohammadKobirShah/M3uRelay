import crypto from 'node:crypto';
import { parseJsonEnv } from './util.js';

function num(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed === '' ? fallback : trimmed;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on|enabled)$/i.test(String(value).trim());
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * All runtime knobs in one place. Every value has a sane default so
 * `docker compose up -d` works with a single UPSTREAM_BASE.
 */
export function loadConfig(env = process.env) {
  const segmentMode = str(env.SEGMENT_MODE, 'redirect').toLowerCase();
  const config = {
    port: num(env.PORT, 3000, { min: 1, max: 65535 }),
    host: str(env.HOST, '0.0.0.0'),
    publicUrl: str(env.PUBLIC_URL, '').replace(/\/$/, ''),
    logLevel: str(env.LOG_LEVEL, 'info').toLowerCase(),
    logFormat: str(env.LOG_FORMAT, 'text').toLowerCase(),

    channelsFile: str(env.CHANNELS_FILE, 'channels.m3u'),
    watchChannels: bool(env.WATCH_CHANNELS, true),

    upstreamBase: str(env.UPSTREAM_BASE, '').replace(/\/$/, ''),
    upstreamHighPath: str(env.UPSTREAM_HIGH_PATH, '/live/high/{id}.m3u8'),
    upstreamAutoPath: str(env.UPSTREAM_AUTO_PATH, '/live/{id}.m3u8'),
    allowAutoFallback: bool(env.ALLOW_AUTO_FALLBACK, true),
    upstreamHeaders: parseJsonEnv(env.UPSTREAM_HEADERS, {}),
    upstreamUserAgent: str(env.UPSTREAM_UA, 'M3uRelay/1.0 (manifest-only relay; high-only)'),
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 1500, { min: 250, max: 20000 }),
    upstreamMaxBytes: num(env.UPSTREAM_MAX_BYTES, 512 * 1024, { min: 4096 }),

    tokenUrl: str(env.TOKEN_URL, ''),
    tokenField: str(env.TOKEN_FIELD, 'token'),
    tokenHeader: str(env.TOKEN_HEADER, ''),
    tokenHeaderFormat: str(env.TOKEN_HEADER_FORMAT, 'Bearer {token}'),
    tokenQuery: str(env.TOKEN_QUERY, ''),
    tokenTtlMs: num(env.TOKEN_TTL_MS, 5 * 60 * 1000, { min: 5000 }),
    tokenTimeoutMs: num(env.TOKEN_TIMEOUT_MS, 4000, { min: 250, max: 30000 }),
    tokenAppendSegments: bool(env.TOKEN_APPEND_SEGMENTS, false),

    warmerEnabled: bool(env.WARMER_ENABLED, true),
    warmerIntervalMs: num(env.WARMER_INTERVAL_MS, 2000, { min: 250, max: 120000 }),
    warmerConcurrency: num(env.WARMER_CONCURRENCY, 24, { min: 1, max: 128 }),
    warmerOnStart: bool(env.WARMER_ON_START, true),
    cacheTtlMs: num(env.CACHE_TTL_MS, 2500, { min: 100 }),
    staleServeMs: num(env.STALE_SERVE_MS, 15000, { min: 0 }),
    hotWarmMs: num(env.HOT_WARM_MS, 60000, { min: 0 }),
    hotWarmLimit: num(env.HOT_WARM_LIMIT, 40, { min: 0, max: 1000 }),
    mediaCacheTtlMs: num(env.MEDIA_CACHE_TTL_MS, 1200, { min: 0 }),
    mediaTimeoutMs: num(env.MEDIA_TIMEOUT_MS, 2500, { min: 250, max: 30000 }),
    healthWarmRatio: num(env.HEALTH_WARM_RATIO, 0.5, { min: 0, max: 1 }),

    segmentMode: ['redirect', 'direct', 'proxy'].includes(segmentMode) ? segmentMode : 'redirect',
    segmentTimeoutMs: num(env.SEGMENT_TIMEOUT_MS, 12000, { min: 1000, max: 60000 }),
    segmentProxyMaxBytes: num(env.SEGMENT_PROXY_MAX_BYTES, 16 * 1024 * 1024, { min: 64 * 1024 }),
    blockPrivateHosts: bool(env.BLOCK_PRIVATE_HOSTS, true),
    keyCacheMs: num(env.KEY_CACHE_MS, 6 * 60 * 60 * 1000, { min: 1000 }),
    keyMaxBytes: num(env.KEY_MAX_BYTES, 64 * 1024, { min: 16 }),

    urlSecret: str(env.URL_SECRET, '') || crypto.randomBytes(24).toString('base64url'),
    allowOrigin: str(env.ALLOW_ORIGIN, '*'),
    playlistQuality: str(env.PLAYLIST_QUALITY, 'high').toLowerCase(),
    excludedGroups: list(env.EXCLUDED_GROUPS),
    demoMode: bool(env.DEMO_MODE, false),
  };

  config.apiBase = config.publicUrl;
  return config;
}
