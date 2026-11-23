#!/usr/bin/env node
/**
 * One-command offline demo: mock origin (real 16s test-pattern HLS) + relay + panel.
 *
 *   npm run demo            -> http://localhost:3000
 *
 * Segments are proxied in demo mode only because the mock CDN is not publicly
 * reachable. Production runs with SEGMENT_MODE=redirect (0 bytes through here).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockOrigin } from './mock-origin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = path.join(ROOT, 'demo', 'media');
const originPort = Number(process.env.MOCK_ORIGIN_PORT || 8088);

const origin = await startMockOrigin({
  port: originPort,
  host: '127.0.0.1',
  latencyMs: Number(process.env.MOCK_LATENCY_MS || 25),
  mediaDir,
});

process.env.UPSTREAM_BASE = process.env.UPSTREAM_BASE || origin.url;
process.env.CHANNELS_FILE = process.env.CHANNELS_FILE || 'channels.demo.m3u';
process.env.PORT = process.env.PORT || '3000';
process.env.SEGMENT_MODE = process.env.SEGMENT_MODE || 'proxy';
if (process.env.BLOCK_PRIVATE_HOSTS === undefined) process.env.BLOCK_PRIVATE_HOSTS = 'false';
process.env.DEMO_MODE = 'true';
if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'info';

const banner = [
  '',
  '  ┌─────────────────────────────────────────────────────────────┐',
  '  │  MY IPTV PRO — offline demo                                 │',
  '  ├─────────────────────────────────────────────────────────────┤',
  `  │  panel    http://localhost:${String(process.env.PORT).padEnd(34)}│`,
  '  │  playlist http://localhost:' + process.env.PORT + '/playlist.m3u?q=high' + ' '.repeat(Math.max(0, 19 - String(process.env.PORT).length)) + '│',
  '  │  upstream mock origin (real test-pattern HLS)               │',
  '  │  segments proxied in demo mode (production = redirect)      │',
  '  └─────────────────────────────────────────────────────────────┘',
  '',
].join('\n');

process.stdout.write(banner);
await import('../server.js');
process.on('exit', () => origin.server.close());
