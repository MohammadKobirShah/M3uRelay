# MY IPTV PRO — manifest-only HLS relay

Personal live TV for 100+ channels, built for **ultra-fast start**, not low latency.

```
                 ┌──────────────────────────────┐
   24/7 warmer → │ fetch /live/high/<id>.m3u8   │  every 2s, manifests only (1–2 KB)
                 │ filter 720p/1080p + Bangla   │
                 └──────────────┬───────────────┘
                                │ filtered master (RAM)
   click ───────────────────────▼─────────────────────────────
         GET /live/high/<id>.m3u8   →  200 in ~1 ms (no origin fetch)
         GET /v/<id>/720.m3u8       →  rewritten variant playlist
         GET /s?u=…                 →  302 ─────────────▶ origin CDN
                                                        (segments never hit the relay)
```

- **High-only**: the relay only ever asks the upstream for `/live/high/<id>.m3u8`.
  `low` / `medium` / `auto` endpoints are refused by the relay's own routes, and the
  single emergency fallback is `/live/<id>.m3u8` when `high` fails.
- **720p + 1080p only**: 144p…576p (and 4K) rungs are deleted from the master.
  720p is always first, so `startLevel: 0` means “start at 720p”.
- **Bangla first**: only Bangla + Hindi audio renditions survive, Bangla is
  `DEFAULT=YES`, Hindi is `AUTOSELECT=YES` backup. Everything else is deleted.
- **0 Mbps for video**: segments are 302-redirected to the CDN (or emitted as direct
  CDN URLs). The relay never downloads a media segment in the default mode.
- **No FFmpeg, no transcoding, no re-encode.** One small Node.js service, no npm
  dependencies, one `docker compose up -d`.

---

## Quick start

### 1. Production (your own upstream)

```bash
git clone https://github.com/MohammadKobirShah/M3uRelay.git
cd M3uRelay
cp .env.example .env          # set UPSTREAM_BASE to your JioTV-Go style server
docker compose up -d
```

Open `http://SERVER-IP:3000`.

`UPSTREAM_BASE` is the server that already speaks the JioTV-Go style endpoints
(`/live/high/<id>.m3u8`). If your channels already have absolute `https://…m3u8`
URLs, you can skip `UPSTREAM_BASE` completely.

### 2. Offline demo (no upstream needed)

```bash
npm run demo        # http://localhost:3000
```

Starts a mock JioTV-style origin serving a **real 16-second test-pattern HLS loop**
(360p/720p/1080p + Bangla/Hindi/English audio tracks) plus the relay and panel.
Use it to see the filtering, the Bangla-default audio and the click-to-play timing
without any provider credentials. In demo mode segments are proxied because the
mock CDN is not publicly reachable — production uses `SEGMENT_MODE=redirect`
(0 bytes through the server).

```bash
docker compose --profile demo up -d   # same demo inside Docker, on :3001
```

### 3. Point it at your own channel list

```bash
node scripts/import-m3u.js provider.m3u channels.m3u --force
# /live/low/, /live/medium/ and /live/auto/ URLs are rewritten to /live/high/
# /live/high/<id>.m3u8 becomes high://<id>  (token always refreshed by the warmer)
```

The repo ships `channels.m3u` with 150 Bangla-first channels in the relay's format:

```m3u
#EXTINF:-1 tvg-id="btv-national" tvg-name="BTV National" group-title="Bangla Entertainment" tvg-language="Bangla",BTV National
high://btv-national
```

`high://<id>` → `<UPSTREAM_BASE>/live/high/<id>.m3u8`. Absolute URLs and `{id}`
templates are also accepted. Editing `channels.m3u` on disk hot-reloads the list
(no restart, `WATCH_CHANNELS=true`).

---

## The panel

`http://SERVER-IP/` — single HTML file, vanilla JS, HLS.js (bundled locally, CDN fallback).

| Feature | Notes |
| --- | --- |
| 150 channels | loaded from `/api/channels` in one request, < 1 s |
| Live search | `/` focuses the search box |
| Category chips | built from `group-title`, Bangla groups first |
| Favorites | `localStorage`, star on each card |
| Last channel auto-play | restores on load, shows a Resume button if autoplay is blocked |
| Quality switch | Auto (720p start, upgrades to 1080p) / 720p / 1080p |
| Audio switch | Bangla default, Hindi backup |
| Picture-in-Picture | button appears where supported |
| Auto reconnect | `startLoad()` → media recovery → full re-init with backoff |
| Live telemetry | “⚡ 412 ms start”, buffer ahead, current level bitrate |
| Copy M3U | `http://host/playlist.m3u?q=high` for VLC / TiviMate / OTT Navigator |

Player config is the PRD's fast-start profile: `maxBufferLength: 2`,
`maxMaxBufferLength: 4`, `startLevel: 0`, `capLevelToPlayerSize: false`,
`lowLatencyMode: false`, `testBandwidth: false`,
`manifestLoadingMaxRetry: 20` with a 500 ms delay.

---

## How each PRD rule is enforced

| Requirement | Implementation | Test |
| --- | --- | --- |
| Never fetch `/live/low`, `/live/medium`, `/live/auto` | `upstreamHighPath` is the only warmer path; `/live/low|medium/*` routes return **400**; `/live/auto/*` is a relay alias for the high ladder | `integration: low/medium endpoints are refused` |
| Emergency fallback only | `fetchMaster()` tries `high`, then `auto`, and reports `X-Relay-Source` | `high failure falls back to auto` |
| Only 720p + 1080p in output | `selectVariants()` buckets by height, drops everything else, sorts 720 first, one rung per tier | `quality filter keeps exactly 720p then 1080p` |
| SD channel must not be blurry | if no 720/1080 rung exists, the single **best** rung is kept (e.g. 576p), never 240p | `SD channel keeps the best rung instead of 240p` |
| Bangla default, Hindi backup | `selectAudio()` rewrites `DEFAULT`/`AUTOSELECT`/`FORCED`, drops other languages | `audio filter keeps Bangla default + Hindi backup` |
| Delete other languages / subtitles | subtitle renditions and their `SUBTITLES` attribute are removed | `rendered master has two audio renditions…` |
| Preserve ABR + audio + keys + timing tags | `renderMaster` / `renderMediaPlaylist` keep `EXT-X-KEY`, `EXT-X-MAP`, `TARGETDURATION`, `MEDIA-SEQUENCE`, `PDT`, `DISCONTINUITY` | `media playlist rewrite…` |
| Warmer every 2 s, manifests only | `Relay.warmTick()` with bounded concurrency, RAM cache, TTL 2.5 s, stale-while-revalidate | `repeated master requests… single-digit ms` |
| Segments direct to CDN | variant playlists rewritten to `/s?u=…&sig=…` → **302** (default), `direct` or `proxy` modes available | `segment endpoint 302s straight to the origin CDN` |
| No FFmpeg / no re-encode | zero ffmpeg calls in the service, no segment bytes touched in redirect mode | — |
| One command deploy | `docker compose up -d` | — |

---

## API

| Route | What it does |
| --- | --- |
| `GET /` | panel |
| `GET /playlist.m3u?q=high` | M3U of all channels, relay high URLs only (`q=low/medium` → 400) |
| `GET /live/high/<id>.m3u8` | filtered master from RAM (the fast path) |
| `GET /live/<id>.m3u8` | compatibility alias for the same high ladder |
| `GET /v/<id>/720.m3u8` · `/1080.m3u8` · `/best.m3u8` | rewritten variant / audio playlist |
| `GET /s?u=<b64url>&c=<id>&sig=<hmac>` | 302 to the CDN (or streamed in `proxy` mode) |
| `GET /k?u=…&sig=…` | AES-128 key proxy (cached in RAM) |
| `GET /api/channels` | channel JSON with live status, ladder, audio tracks |
| `GET /api/channels/<id>` | one channel + parsed filter plan |
| `GET /api/status` | warmer, cache and counter telemetry (open the panel footer link) |
| `GET /api/debug/channel?id=<id>` | fetches the origin live and shows exactly what was kept/dropped |
| `POST /api/reload` | re-read `CHANNELS_FILE` |
| `GET /health` | 200 when ≥ 50 % of channels are warm (`HEALTH_WARM_RATIO`) |

Manifest responses carry `Cache-Control: no-cache`, `Access-Control-Allow-Origin: *`,
`X-Relay-Cache: hit|stale`, `X-Relay-Latency` and `X-Relay-Source: high|auto`.

Segment/key URLs are HMAC-signed (`URL_SECRET`) so `/s` cannot be used as an open
proxy. Set `URL_SECRET` explicitly when running more than one instance.

---

## Configuration

Everything is environment-driven; see `.env.example` for the annotated list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listen address |
| `PUBLIC_URL` | *(derived)* | origin advertised in playlists (reverse proxies) |
| `UPSTREAM_BASE` | — | JioTV-Go style upstream |
| `UPSTREAM_HIGH_PATH` | `/live/high/{id}.m3u8` | **the only warmer path** |
| `UPSTREAM_AUTO_PATH` | `/live/{id}.m3u8` | emergency fallback |
| `ALLOW_AUTO_FALLBACK` | `true` | disable to be strictly high-only |
| `UPSTREAM_HEADERS` | `{}` | JSON headers for every upstream call (referer, origin, cookie…) |
| `TOKEN_URL` / `TOKEN_FIELD` / `TOKEN_HEADER` / `TOKEN_QUERY` | — | per-channel token provider with TTL and forced refresh on 401/403 |
| `TOKEN_APPEND_SEGMENTS` | `false` | append the token to segment URLs (off by default; signed CDN URLs usually break) |
| `CHANNELS_FILE` | `channels.m3u` | channel list (hot-reloaded) |
| `WARMER_ENABLED` / `WARMER_INTERVAL_MS` / `WARMER_CONCURRENCY` | `true` / `2000` / `24` | warmer loop |
| `CACHE_TTL_MS` / `STALE_SERVE_MS` | `2500` / `15000` | fresh window + stale-while-revalidate window |
| `MEDIA_CACHE_TTL_MS` | `1200` | variant playlist micro-cache |
| `HOT_WARM_MS` / `HOT_WARM_LIMIT` | `60000` / `40` | pre-warm playlists of channels being watched |
| `SEGMENT_MODE` | `redirect` | `redirect` (0 Mbps) · `direct` · `proxy` |
| `WATCH_CHANNELS` | `true` | reload the list when the file changes |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `text` | `debug`, `warn`, `error`, or `json` |

### Choosing a segment mode

| Mode | Server bandwidth | When to use |
| --- | --- | --- |
| `redirect` (default) | **0** | CDN URLs work with a plain GET (token in URL). Fastest, cheapest. |
| `direct` | **0** | You want zero relay hops and the CDN accepts the browser directly. |
| `proxy` | full video bitrate | The CDN requires special headers/referer that a browser cannot send through a redirect. Works everywhere, costs bandwidth. |

`proxy` blocks private/loopback targets by default (`BLOCK_PRIVATE_HOSTS=true`) and
forwards `Range` requests.

---

## Measured behaviour (repo test suite + demo)

Measured locally with the 150-channel list, mock upstream at 25 ms latency,
concurrency 24 (`node server.js`, Docker-ready build):

| Metric | Result |
| --- | --- |
| Cached master manifest (150 channels warm) | **median 0.66 ms**, p95 1.77 ms over HTTP |
| Variant playlist, already warm | **1.4–2.1 ms** |
| Variant playlist, first request | ~31 ms (one origin fetch) |
| Warmer round, 150 channels | **199 ms** — 10× inside the 2 s interval |
| Warmer round, 24 channels | 30–55 ms |
| RAM, 150 master manifests + Node runtime | **104 MB RSS** |
| Segment bytes through the relay | 0 in `redirect` / `direct` |
| Output ladder | exactly `720p` then `1080p` (or one best rung for SD-only sources) |
| Output audio | Bangla `DEFAULT=YES` + Hindi `AUTOSELECT=YES`, nothing else |
| Test suite | 38 tests, ~1.3 s (`npm test`) |

HLS.js still decides when to jump to 1080p (ABR), because transcoding is off and
the relay must not lie about the bitrate. The start is pinned to 720p, which is
what removes the ABR ladder-decision delay from the click path.

---

## Verified end to end

```bash
npm test
# 38 tests: manifest filtering, audio policy, URL rewriting, 302 signing,
# direct/proxy modes, token injection, fallback, panel serving.

npm run demo
# open http://localhost:3000, click a channel: real 720p/1080p test pattern
# with Bangla as the default audio track.
```

`curl` proof that no segment touches the relay in redirect mode:

```bash
curl -s http://localhost:3000/v/btv-national/720.m3u8 | head
# http://localhost:3000/s?u=aHR0cHM6…&sig=…
curl -sI 'http://localhost:3000/s?u=…&sig=…' | grep -i location
# location: https://cdn…/segment.ts   ← 302, the player goes to the CDN
```

---

## Deploy notes

**Docker / VPS**

```bash
docker compose up -d
docker compose logs -f relay
curl -s localhost:3000/api/status | jq .channels
```

**Fly.io / Railway / Render** — any host that runs a container works; bandwidth is
near zero with `SEGMENT_MODE=redirect`. Set at least `UPSTREAM_BASE`,
`PUBLIC_URL` (your public host) and `URL_SECRET`. The image exposes `:3000` and a
`/health` endpoint for platform checks. Free tiers with ~256 MB RAM handle 150
channels comfortably; use `WARMER_CONCURRENCY=12` on the smallest instances.

**Reverse proxy** — pass the public host through so manifests advertise reachable
URLs:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_http_version 1.1;
}
```

or simply set `PUBLIC_URL=https://tv.example.com`.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Panel loads, manifests 502 | `UPSTREAM_BASE` wrong, upstream needs headers (`UPSTREAM_HEADERS`) or a token (`TOKEN_URL`). Check `/api/debug/channel?id=<id>`. |
| Manifest fine, video stuck | Segments 403: the CDN needs headers → switch to `SEGMENT_MODE=proxy` (costs bandwidth), or add the token to segment URLs (`TOKEN_APPEND_SEGMENTS=true`) if your CDN signs by query. |
| Channels show **DOWN** | The warmer cannot reach the upstream for that id (wrong id or the channel is offline). `/api/status` shows the last error. |
| Only 720p, no 1080p | The origin's high endpoint has no 1080p rung for that channel — it is not being hidden from you. |
| Autoplay blocked | Browser policy: click Resume. Muted autoplay is intentionally not used. |
| `docker compose up` says channels.m3u is a directory | The bind mount expects the file to exist in the compose directory. Restore it from git. |
| Everything 404s behind a sub-path | Set `PUBLIC_URL` (or serve at the domain root). |

---

## Repository layout

```
server.js               HTTP routes, panel hosting, 302 signing
lib/manifest.js         pure HLS parser → quality/audio filters → renderer
lib/relay.js            RAM caches, 24/7 warmer, hot-channel warming
lib/upstream.js         high-first upstream client, tokens, timeouts
lib/channels.js         M3U channel list parser
lib/config.js           env → config
lib/util.js             base64url, HMAC, URL helpers, concurrency
panel/index.html        the whole UI (single file, HLS.js bundled in panel/vendor)
channels.m3u            150 Bangla-first channels (high:// ids)
channels.demo.m3u       24-channel demo list
scripts/demo.js         mock origin + relay for `npm run demo`
scripts/mock-origin.js  JioTV-style mock origin (messy manifests, special cases)
scripts/import-m3u.js   provider playlist → channels.m3u
scripts/build-demo-media.sh  regenerates demo/media (needs ffmpeg, demo only)
test/                   unit + end-to-end HTTP tests
```

## Notes

- Use this only with sources you are entitled to access. The relay does not break
  DRM, does not store video, and does not implement any provider authentication
  beyond the optional token hook you configure.
- “Ultra fast start” is achieved by caching the manifest and removing rungs, not
  by lowering latency; video may be a few seconds behind live by design
  (`maxBufferLength: 2`).

Licensed under Apache-2.0.
