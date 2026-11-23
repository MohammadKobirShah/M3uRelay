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

## বাংলা — দ্রুত শুরু

```bash
cp .env.example .env      # CHANNELS_URL ইতিমধ্যেই আপনার সার্ভারে সেট করা
docker compose up -d
```

ব্রাউজারে `http://সার্ভার-IP:3000` খুলুন।

- **প্যানেল বাংলায়** — ডিফল্ট ভাষা বাংলা, উপরে `EN` বাটনে এক ট্যাপে ইংরেজি (পছন্দ
  `localStorage`-এ থাকে)।
- **চ্যানেল লিস্ট নিজে থেকেই আসে** আপনার JioTV Go সার্ভার থেকে:
  `CHANNELS_URL=https://tv.home.mangalvedhe.in/playlist.m3u?q=high`। সার্ভারে পৌঁছানো
  না গেলে রিলে `channels.m3u` ফাইলটি ব্যবহার করে (বুট লগে কারণ দেখায়)।
  নতুন চ্যানেল যোগ হলে `docker compose restart relay` অথবা
  `curl -X POST http://সার্ভার-IP:3000/api/sync`।
- **অডিও** — বাংলা ডিফল্ট, হিন্দি ব্যাকআপ; **কোয়ালিটি** — শুধু 720p (শুরু) আর 1080p।
- **ব্যান্ডউইথ** — ভিডিও সেগমেন্ট কখনো সার্ভার দিয়ে যায় না, প্লেয়ার সরাসরি CDN
  থেকে 302 রিডাইরেক্টে নেয়। ১০০ চ্যানেল চালালেও সেগমেন্ট ট্রাফিক 0 Mbps।
- **চ্যানেলের নাম বাংলায়** — সময় টিভি, দীপ্ত টিভি, স্টার জলসা… (ম্যাপে থাকা ~৯০টি
  চ্যানেল)। সার্চ বাংলায়ও কাজ করে — `সময়` বা `সময়টিভি` লিখলেই Somoy TV আসে।
  গ্রুপ চিপগুলোও বাংলায়: বাংলা সংবাদ, বাংলা বিনোদন, খেলাধুলা…
- **শুধু বাংলা, ইংরেজি, হিন্দি** — `CHANNEL_LANGUAGES=Bengali,Bangla,English,Hindi`
  (ডিফল্ট)। আপনার ১০৫৩ চ্যানেলের মধ্যে **৫৬৮টি** থাকে: হিন্দি ৩২০, ইংরেজি ১৯৯,
  বাংলা ৪৯। তামিল/তেলুগু/মালায়ালাম ইত্যাদি বাদ যায়। সব ভাষা চাইলে মানটি খালি রাখুন।
- **সব HLS** — রেপোতে দেওয়া `channels.m3u`-তে ওই **৫৬৮টি চ্যানেলই**
  `/live/high/<id>.m3u8` ফরম্যাটে (৪৩৮টি DASH এন্ট্রিও রূপান্তরিত)। রিলের নিজের
  `/playlist.m3u?q=high`-ও সব HLS লিংক দেয়, একটিও MPD নয়।
- **HLS বনাম DASH** — JioTV Go DRM চ্যানেলগুলো `/live/mpd/<id>?q=high` (DASH/Widevine)
  হিসেবে দেয়, বাকিগুলো `/live/high/<id>.m3u8`। এই রিলে HLS-only, তাই MPD এন্ট্রির
  জন্য **HLS সংস্করণ** (`/live/high/<id>.m3u8`) চেষ্টা করে; যেগুলোর HLS নেই সেগুলো
  কার্ডে `DASH` ব্যাজ নিয়ে বন্ধ দেখায়। সার্ভারে `JIOTV_DRM=false` দিলে প্লেলিস্টেই
  সব HLS লিংক আসবে, তখন সব চ্যানেল চলবে।
- **“উৎস” বাটন** — হেডারে `উৎস` চাপলেই দেখা যায় লিস্ট কোথা থেকে আসছে, শেষ সিঙ্ক কখন,
  কতটি চ্যানেল, কী এরর। সেখানে **সংযোগ পরীক্ষা** চাপলে DNS/IP, HTTP স্ট্যাটাস,
  রেসপন্স টাইম আর প্লেলিস্টের গঠন বাংলায় দেখায় — সার্ভারে পৌঁছাচ্ছে কি না সেটাই
  এখানে বোঝা যায়। **এখনই সিঙ্ক** নতুন চ্যানেল সঙ্গে সঙ্গে আনবে।

> প্যানেল/প্লেলিস্ট লিংক: `http://সার্ভার-IP:3000/`, `…/playlist.m3u?q=high`,
> `…/api/status`। VLC / TiviMate-এ প্লেলিস্ট লিংক বসিয়ে টিভিতেও চালানো যায়।

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

**Channel list from your own JioTV-Go server** — set `CHANNELS_URL` and the relay
reads the list at boot (and every `CHANNELS_REFRESH_MS`, or on `POST /api/sync`):

```bash
CHANNELS_URL=https://tv.home.mangalvedhe.in/playlist.m3u?q=high
```

Both `…/playlist.m3u` and `…/playlist.m3u?q=high` work; the relay itself always
streams via `/live/high/<id>.m3u8`. `channels.m3u` is only the fallback when the
URL is unreachable, so the panel keeps working offline. Playlist URLs without a
quality segment (`/live/<id>.m3u8`) are promoted to `/live/high/<id>.m3u8`, with
the original kept as the emergency fallback (`HIGH_FIRST_CUSTOM_URLS=true`).

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
# default: provider ids (high://<id>) — compact, always rebuilt from UPSTREAM_BASE
node scripts/import-m3u.js provider.m3u channels.m3u --force

# --absolute: keep every URL verbatim, so the list needs no UPSTREAM_BASE
# --languages: drop every other language (names or ISO codes)
node scripts/import-m3u.js "JioTv GO.m3u" channels.m3u --force --absolute \
  --languages=Bengali,Bangla,English,Hindi
```

The importer rewrites `/live/low|medium|auto/` to `/live/high/`, maps JioTV-Go
DASH entries (`/live/mpd/<id>?q=high`) to their HLS endpoint, and drops
`#KODIPROP` blocks. `--absolute` writes the full `/live/high/<id>.m3u8` URL for
every channel, which is what the repo's own list uses.

`channels.m3u` in this repo is the **converted copy of a real JioTV-Go export**:
**568 channels** (Bangla 49, English 199, Hindi 320) in 12 groups, every stream a
high-only HLS URL — 438 DASH entries were mapped to `/live/high/<id>.m3u8` and the
485 other-language channels were dropped.

```m3u
#EXTINF:-1 tvg-id="143" tvg-name="CNBC TV18 Prime" tvg-logo="https://…/CNBCTV18Prime1.png" group-title="Business" tvg-language="English",CNBC TV18 Prime
https://tv.home.mangalvedhe.in/live/high/143.m3u8
```

`high://<id>` (→ `<UPSTREAM_BASE>/live/high/<id>.m3u8`), absolute URLs and `{id}`
templates are all accepted. Editing `channels.m3u` on disk hot-reloads the list
(no restart, `WATCH_CHANNELS=true`).

---

## The panel

`http://SERVER-IP/` — single HTML file, vanilla JS, HLS.js (bundled locally, CDN fallback).

| Feature | Notes |
| --- | --- |
| 568 channels | loaded from `/api/channels` in one request, < 1 s |
| Live search | `/` focuses the search box |
| Category chips | built from `group-title`, Bangla groups first |
| Favorites | `localStorage`, star on each card |
| Last channel auto-play | restores on load, shows a Resume button if autoplay is blocked |
| Language | Bangla by default, `EN` toggle in the header (`m3ip.lang`) |
| Bangla names | ~90 popular channels get a Bangla title and group label; unknown names keep the source text |
| Bangla search | matches the Bangla name, the English name, the id and the group — with or without spaces |
| Source sheet | header **উৎস** button: active source, last sync, channel count, last error, **Sync now** |
| Connection probe | inside the sheet: DNS, IP, HTTP status, response time, playlist shape and Bangla findings |
| DASH badge | cards whose upstream entry is DASH/Widevine show a `DASH` chip (the relay is trying their HLS twin) |
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

## JioTV-Go: HLS and DASH

JioTV-Go publishes two kinds of URLs in `/playlist.m3u?q=high`:

| Upstream entry | What it is | What the relay does |
| --- | --- | --- |
| `https://host/live/high/<id>.m3u8` | plain HLS, already high-only | fetched as-is |
| `https://host/live/mpd/<id>?q=high` | DASH + Widevine (`#KODIPROP` blocks) | rewrites to `https://host/live/high/<id>.m3u8` and tries that (`DASH_TO_HLS=true`) |

A DRM-marked channel usually still has an HLS endpoint, so the rewrite recovers
many of them; the ones without HLS simply show **DOWN** with a `DASH` badge.
If you want a pure HLS playlist, run JioTV-Go with `JIOTV_DRM=false` (its own
env var) — then every entry is `/live/high/<id>.m3u8`.

```bash
# see exactly what your server publishes, before touching the relay
curl -s 'http://SERVER:5001/playlist.m3u?q=high' | grep -c '/live/mpd/'
curl -s 'http://SERVER:5001/playlist.m3u?q=high' | grep -c '/live/high/'
```

`SKIP_DASH=true` hides DASH-marked channels from the panel/playlist entirely
instead of trying their HLS twin.

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
| `GET /api/status` | warmer, cache and counter telemetry, including `channelsSource` |
| `GET /api/probe[?url=…]` | DNS + HTTP + playlist diagnostics for the channel source (the panel's “সংযোগ পরীক্ষা”) |
| `GET /api/debug/channel?id=<id>` | fetches the origin live and shows exactly what was kept/dropped |
| `POST /api/reload` | re-read `CHANNELS_FILE` / re-sync `CHANNELS_URL` |
| `POST /api/sync` | same as `/api/reload`, returns the active source + channel count |
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
| `CHANNELS_URL` | — | fetch the list from your JioTV-Go server (takes precedence; file is the fallback) |
| `CHANNELS_REFRESH_MS` | `0` | re-sync interval for `CHANNELS_URL` (0 = boot only / `/api/sync`) |
| `CHANNELS_CACHE_FILE` | `channels.cache.m3u` | last good playlist, reused when the server is unreachable (empty disables) |
| `CHANNELS_URL_TIMEOUT_MS` | `8000` | timeout for the channel-list fetch |
| `CHANNELS_URL_HEADERS` | — | JSON headers for the channel-list fetch |
| `HIGH_FIRST_CUSTOM_URLS` | `true` | promote `/live/<id>.m3u8` to `/live/high/<id>.m3u8` |
| `DASH_TO_HLS` | `true` | map JioTV-Go `/live/mpd/<id>` (DASH/Widevine) entries to `/live/high/<id>.m3u8` |
| `SKIP_DASH` | `false` | drop DASH-marked channels instead of trying their HLS twin |
| `CHANNEL_LANGUAGES` | *(all)* | keep only these channel languages (`Bengali,Bangla,English,Hindi`); empty = everything |
| `PROBE_ALLOW_ANY_URL` | `false` | let `/api/probe?url=` check hosts other than the configured source |
| `WARMER_ENABLED` / `WARMER_INTERVAL_MS` / `WARMER_CONCURRENCY` | `true` / `2000` / `24` | warmer loop |
| `CACHE_TTL_MS` / `STALE_SERVE_MS` | `2500` / `15000` | fresh window + stale-while-revalidate window |
| `MEDIA_CACHE_TTL_MS` | `1200` | variant playlist micro-cache |
| `HOT_WARM_MS` / `HOT_WARM_LIMIT` | `60000` / `40` | pre-warm playlists of channels being watched |
| `SEGMENT_MODE` | `redirect` | `redirect` (0 Mbps) · `direct` · `proxy` |
| `WATCH_CHANNELS` | `true` | reload the list when the file changes |
| `EXCLUDED_GROUPS` | — | comma-separated group names to hide from the panel/playlist |
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
| Test suite | 59 tests, ~1.8 s (`npm test`) |

HLS.js still decides when to jump to 1080p (ABR), because transcoding is off and
the relay must not lie about the bitrate. The start is pinned to 720p, which is
what removes the ABR ladder-decision delay from the click path.

---

## Verified end to end

```bash
npm test
# 59 tests: manifest filtering, audio policy, URL rewriting, 302 signing,
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
| Panel shows the **old** list or none | Open **উৎস** → **সংযোগ পরীক্ষা**. It reports DNS failures, HTTP errors, non-M3U responses and timeouts in Bangla. Inside Docker a LAN name needs an `extra_hosts` entry or host networking. |
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
lib/upstream.js         high-first upstream client, DASH→HLS mapping, tokens, timeouts
lib/channels.js         M3U channel list parser
lib/bangla.js           Bangla channel names, group labels, search aliases
lib/probe.js            channel-source diagnostics (DNS/HTTP/playlist)
lib/config.js           env → config
lib/util.js             base64url, HMAC, URL helpers, concurrency
panel/index.html        the whole UI (single file, HLS.js bundled in panel/vendor)
channels.m3u            568 Bangla/English/Hindi channels, high-only HLS (from JioTv GO.m3u)
channels.demo.m3u       24-channel demo list
scripts/demo.js         mock origin + relay for `npm run demo`
scripts/mock-origin.js  JioTV-style mock origin (messy manifests, special cases)
scripts/import-m3u.js   provider playlist → channels.m3u (--absolute keeps HLS URLs)
scripts/build-demo-media.sh  regenerates demo/media (needs ffmpeg, demo only)
test/                   unit + end-to-end HTTP tests
```

## Notes

- Use this only with sources you are entitled to access. The relay does not break
  DRM, does not store video, and does not implement any provider authentication
  beyond the optional token hook you configure.
- The channel list is fetched with a conditional GET; a 304 keeps the current list.
  Every successful fetch is written to `CHANNELS_CACHE_FILE`, so a restart during a
  network outage still opens the panel with the last known channels.
- “Ultra fast start” is achieved by caching the manifest and removing rungs, not
  by lowering latency; video may be a few seconds behind live by design
  (`maxBufferLength: 2`).

Licensed under Apache-2.0.
