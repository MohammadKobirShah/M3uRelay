import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { buildPlan, describePlan, parseMediaPlaylist } from './manifest.js';
import { parseChannelList } from './channels.js';
import { mapLimit } from './util.js';

export class RelayError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
  }
}

/**
 * In-memory manifest cache + 24/7 warmer + playback resolvers.
 *
 * Master manifests (1-2 KB) live in RAM and are refreshed on a fixed interval.
 * Variant playlists are fetched on demand (and pre-warmed for channels that are
 * being watched) then rewritten so segments never touch this process.
 */
export class Relay {
  constructor({ config, logger, upstream }) {
    this.cfg = config;
    this.log = logger;
    this.upstream = upstream;

    this.channels = [];
    this.channelsById = new Map();
    this.channelsLoadedAt = 0;
    this.channelFileError = null;
    this.channelSource = 'file';
    this.channelSyncError = null;

    this.masters = new Map();
    this.media = new Map();
    this.keys = new Map();
    this.access = new Map();
    this.inflight = new Map();
    this.planSignatures = new Map();

    this.counters = {
      masterHits: 0,
      masterMisses: 0,
      masterErrors: 0,
      mediaHits: 0,
      mediaMisses: 0,
      mediaErrors: 0,
      keyHits: 0,
      keyErrors: 0,
      segmentRedirects: 0,
      segmentProxies: 0,
      playlistRequests: 0,
    };

    this.warmer = {
      enabled: Boolean(config.warmerEnabled),
      running: false,
      runs: 0,
      skippedRuns: 0,
      lastRunAt: 0,
      lastRunMs: 0,
      lastOkAt: 0,
      lastErrorAt: 0,
      lastErrorMessage: '',
      lastWarmed: 0,
      lastFailed: 0,
    };

    this.timers = [];
    this.stopped = false;
    this.startedAt = Date.now();
  }

  /* ---------------------------------------------------------------- */
  /* channels                                                          */
  /* ---------------------------------------------------------------- */

  async readChannelSource() {
    if (!this.cfg.channelsUrl) {
      this.channelSource = 'file';
      this.channelSyncError = null;
      return { text: await fs.readFile(this.cfg.channelsFile, 'utf8'), source: 'file' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.channelsUrlTimeoutMs);
    try {
      const response = await fetch(this.cfg.channelsUrl, {
        headers: { accept: 'application/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*', ...this.cfg.channelsUrlHeaders },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!/#EXTINF/i.test(text)) throw new Error('playlist has no channels');
      this.channelSource = 'url';
      this.channelSyncError = null;
      return { text, source: 'url' };
    } catch (error) {
      this.channelSyncError = String(error && error.message ? error.message : error);
      this.log.warn(
        `channel list sync failed (${this.channelSyncError}) — falling back to ${this.cfg.channelsFile}`,
      );
      this.channelSource = 'file';
      return { text: await fs.readFile(this.cfg.channelsFile, 'utf8'), source: 'file' };
    } finally {
      clearTimeout(timer);
    }
  }

  async loadChannels() {
    const { text, source } = await this.readChannelSource();
    const parsed = parseChannelList(text, {
      defaultGroup: 'Other',
      // Relative stream URLs in an upstream playlist are resolved against it.
      baseUrl: source === 'url' ? this.cfg.channelsUrl : null,
    });
    const duplicates = parsed.duplicates;
    const excludedGroups = this.cfg.excludedGroups.map((group) => group.toLowerCase());
    const channels = excludedGroups.length
      ? parsed.channels.filter((channel) => !excludedGroups.includes(String(channel.group).toLowerCase()))
      : parsed.channels;
    if (!channels.length) throw new RelayError(`channel list ${this.cfg.channelsFile} has no channels`, 500);
    const excludedCount = parsed.channels.length - channels.length;

    const previous = this.channelsById;
    this.channels = channels;
    this.channelsById = new Map(channels.map((channel) => [channel.id, channel]));
    this.channelsLoadedAt = Date.now();
    this.channelFileError = null;

    // Drop cache entries for channels that disappeared from the list.
    for (const id of this.masters.keys()) if (!this.channelsById.has(id)) this.masters.delete(id);
    for (const cacheKey of this.media.keys()) {
      const id = cacheKey.split('|')[0];
      if (!this.channelsById.has(id)) this.media.delete(cacheKey);
    }

    this.log.info(
      `loaded ${channels.length} channels from ${source === 'url' ? this.cfg.channelsUrl : this.cfg.channelsFile}` +
        (duplicates.length ? ` (ignored ${duplicates.length} duplicates)` : '') +
        (excludedCount ? ` (excluded ${excludedCount} by EXCLUDED_GROUPS)` : '') +
        (previous.size ? ` (was ${previous.size})` : ''),
    );
    return channels;
  }

  watchChannels() {
    if (!this.cfg.watchChannels) return;
    const path = this.cfg.channelsFile;
    try {
      fsSync.watchFile(path, { interval: 3000 }, async (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs) return;
        try {
          await this.loadChannels();
          this.access.clear();
        } catch (error) {
          this.log.warn(`channel list reload failed: ${error.message}`);
        }
      });
    } catch (error) {
      this.log.warn(`cannot watch ${path}: ${error.message}`);
    }
  }

  unwatch() {
    try {
      fsSync.unwatchFile(this.cfg.channelsFile);
    } catch {
      /* ignore */
    }
  }

  getChannel(id) {
    return this.channelsById.get(id) || null;
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  start() {
    this.stopped = false;
    if (!this.cfg.warmerEnabled) {
      this.log.warn('warmer disabled — requests will fetch manifests on demand');
      return;
    }
    const kick = () => {
      this.warmTick().catch((error) => this.log.error('warmer tick failed', error));
    };
    if (this.cfg.warmerOnStart) setTimeout(kick, 0).unref?.();
    const interval = setInterval(kick, this.cfg.warmerIntervalMs);
    interval.unref?.();
    this.timers.push(interval);

    if (this.cfg.channelsRefreshMs > 0) {
      let syncing = false;
      const sync = setInterval(async () => {
        if (syncing) return;
        syncing = true;
        try {
          await this.loadChannels();
          this.access.clear();
        } catch (error) {
          this.log.warn(`channel list refresh failed: ${error.message}`);
        } finally {
          syncing = false;
        }
      }, this.cfg.channelsRefreshMs);
      sync.unref?.();
      this.timers.push(sync);
    }
    this.log.info(
      `warmer started: ${this.channels.length} channels every ${this.cfg.warmerIntervalMs}ms, concurrency ${this.cfg.warmerConcurrency}`,
    );
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.unwatch();
  }

  /* ---------------------------------------------------------------- */
  /* warmer                                                            */
  /* ---------------------------------------------------------------- */

  async warmTick() {
    if (this.stopped) return;
    if (this.warmer.running) {
      this.warmer.skippedRuns += 1;
      return;
    }
    this.warmer.running = true;
    const started = Date.now();
    let warmed = 0;
    let failed = 0;
    try {
      await mapLimit(this.channels, this.cfg.warmerConcurrency, async (channel) => {
        try {
          await this.refreshMaster(channel);
          warmed += 1;
        } catch (error) {
          failed += 1;
          if (this.cfg.logLevel === 'debug') {
            this.log.debug(`warm ${channel.id} (${channel.name}) failed: ${error.message}`);
          }
        }
      });
      this.warmer.runs += 1;
      this.warmer.lastRunAt = started;
      this.warmer.lastRunMs = Date.now() - started;
      this.warmer.lastWarmed = warmed;
      this.warmer.lastFailed = failed;
      if (failed && !warmed) {
        this.log.warn(`warmer round failed for all ${failed} channels`);
      }
    } finally {
      this.warmer.running = false;
    }
    await this.hotWarm().catch((error) => this.log.debug(`hot warm failed: ${error.message}`));
  }

  touch(channelId) {
    if (!this.cfg.hotWarmMs || !this.cfg.hotWarmLimit) return;
    this.access.set(channelId, Date.now());
  }

  /**
   * Keep the playlists of channels someone is watching warm. This is what makes
   * the second and subsequent variant requests sub-100ms.
   */
  async hotWarm() {
    if (!this.cfg.hotWarmMs || !this.cfg.hotWarmLimit || !this.access.size) return;
    const now = Date.now();
    const active = [];
    for (const [id, lastAccess] of this.access) {
      if (now - lastAccess > this.cfg.hotWarmMs) this.access.delete(id);
      else active.push([id, lastAccess]);
    }
    active.sort((a, b) => b[1] - a[1]);
    const slice = active.slice(0, this.cfg.hotWarmLimit);
    if (!slice.length) return;
    await mapLimit(slice, Math.min(6, this.cfg.warmerConcurrency), async ([id]) => {
      const channel = this.channelsById.get(id);
      if (!channel) return;
      const entry = this.masters.get(id);
      if (!entry || !entry.plan) return;
      const target = entry.plan.type === 'media' ? 'best' : entry.plan.variants[0]?.key;
      if (!target) return;
      try {
        await this.refreshMedia(channel, target);
      } catch {
        /* warmer never throws for a hot channel */
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* master manifests                                                  */
  /* ---------------------------------------------------------------- */

  refreshMaster(channel) {
    const key = channel.id;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const started = performance.now();
      try {
        const { text, url, endpoint } = await this.upstream.fetchMaster(channel);
        const plan = buildPlan(text, url);
        const entry = {
          channelId: key,
          plan,
          sourceUrl: url,
          endpoint,
          fetchedAt: Date.now(),
          latencyMs: performance.now() - started,
          error: null,
          errorAt: 0,
          rawText: plan.type === 'media' ? text : null,
        };
        this.masters.set(key, entry);
        if (plan.type === 'media' && plan.media) {
          this.media.set(`${key}|best`, {
            channelId: key,
            key: 'best',
            items: plan.media.items,
            meta: plan.media.meta,
            sourceUrl: url,
            fetchedAt: Date.now(),
            latencyMs: entry.latencyMs,
            inline: true,
          });
        }
        this.pruneMedia(key, plan);
        this.warmer.lastOkAt = Date.now();
        return entry;
      } catch (error) {
        this.counters.masterErrors += 1;
        this.warmer.lastErrorAt = Date.now();
        this.warmer.lastErrorMessage = error.message;
        const previous = this.masters.get(key);
        if (previous) {
          previous.error = error.message;
          previous.errorAt = Date.now();
        }
        throw error;
      }
    })();

    this.inflight.set(key, promise);
    const cleanup = () => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  pruneMedia(channelId, plan) {
    const valid = new Set(['best', ...plan.variants.map((variant) => variant.key), ...plan.audio.map((track) => track.key)]);
    const signature = [...valid].sort().join(',');
    if (this.planSignatures.get(channelId) === signature) return;
    this.planSignatures.set(channelId, signature);
    const prefix = `${channelId}|`;
    for (const cacheKey of this.media.keys()) {
      if (!cacheKey.startsWith(prefix)) continue;
      const key = cacheKey.slice(prefix.length);
      if (!valid.has(key)) this.media.delete(cacheKey);
    }
  }

  /**
   * Fast path: serve from RAM when fresh, stale-while-revalidate when slightly
   * old, and only block on the network when nothing is cached at all.
   */
  async getMaster(channel) {
    const entry = this.masters.get(channel.id);
    const age = entry ? Date.now() - entry.fetchedAt : Infinity;

    if (entry && entry.plan && age <= this.cfg.cacheTtlMs) {
      this.counters.masterHits += 1;
      return entry;
    }
    if (entry && entry.plan && age <= Math.max(this.cfg.staleServeMs, this.cfg.cacheTtlMs)) {
      this.counters.masterHits += 1;
      this.refreshMaster(channel).catch(() => {});
      return entry;
    }
    this.counters.masterMisses += 1;
    try {
      return await this.refreshMaster(channel);
    } catch (error) {
      if (entry && entry.plan) {
        this.counters.masterHits += 1;
        return entry;
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------- */
  /* media playlists                                                   */
  /* ---------------------------------------------------------------- */

  resolveMediaTarget(entry, key) {
    const plan = entry.plan;
    if (!plan) return null;
    if (key === 'best') {
      if (plan.type === 'media') return { url: entry.sourceUrl, inlineText: entry.rawText };
      const first = plan.variants[0];
      if (first) return { url: first.uri, label: first.label };
      return null;
    }
    const variant = plan.variants.find((candidate) => candidate.key === key);
    if (variant) return { url: variant.uri, label: variant.label };
    const audio = plan.audio.find((candidate) => candidate.key === key);
    if (audio && audio.uri) return { url: audio.uri, label: audio.name, audio: true };
    // Language-stable fallback: a-<lang><n> keys survive rendition reordering.
    const langMatch = /^a-(ben|hin)x?(\d+)?$/.exec(key);
    if (langMatch) {
      const wanted = plan.audio.find((candidate) => candidate.lang === langMatch[1]);
      if (wanted && wanted.uri) return { url: wanted.uri, label: wanted.name, audio: true };
    }
    return null;
  }

  refreshMedia(channel, key) {
    const cacheKey = `${channel.id}|${key}`;
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const promise = (async () => {
      const started = performance.now();
      try {
        const master = await this.getMaster(channel);
        let target = this.resolveMediaTarget(master, key);
        if (!target) throw new RelayError(`unknown rendition "${key}" for channel ${channel.id}`, 404);

        let text = target.inlineText;
        let sourceUrl = target.url;
        if (!text) {
          try {
            const fetched = await this.upstream.fetchPlaylist(target.url, channel);
            text = fetched.text;
            sourceUrl = fetched.url || target.url;
          } catch (error) {
            if (error.status === 401 || error.status === 403) {
              // Signed variant URL expired: re-resolve against a fresh master.
              const fresh = await this.refreshMaster(channel);
              target = this.resolveMediaTarget(fresh, key);
              if (!target || !target.url) throw error;
              const fetched = await this.upstream.fetchPlaylist(target.url, channel);
              text = fetched.text;
              sourceUrl = fetched.url || target.url;
            } else {
              throw error;
            }
          }
        }

        const parsed = parseMediaPlaylist(text, sourceUrl);
        const entry = {
          channelId: channel.id,
          key,
          items: parsed.items,
          meta: parsed.meta,
          sourceUrl,
          fetchedAt: Date.now(),
          latencyMs: performance.now() - started,
          inline: false,
        };
        this.media.set(cacheKey, entry);
        return entry;
      } catch (error) {
        this.counters.mediaErrors += 1;
        throw error;
      }
    })();

    this.inflight.set(cacheKey, promise);
    const cleanup = () => {
      if (this.inflight.get(cacheKey) === promise) this.inflight.delete(cacheKey);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async getMedia(channel, key) {
    const cacheKey = `${channel.id}|${key}`;
    const entry = this.media.get(cacheKey);
    const age = entry ? Date.now() - entry.fetchedAt : Infinity;
    if (entry && entry.items && age <= this.cfg.mediaCacheTtlMs) {
      this.counters.mediaHits += 1;
      return entry;
    }
    const staleWindow = Math.min(this.cfg.staleServeMs, (entry?.meta?.targetDuration || 6) * 1200);
    if (entry && entry.items && age <= staleWindow) {
      this.counters.mediaHits += 1;
      this.refreshMedia(channel, key).catch(() => {});
      return entry;
    }
    this.counters.mediaMisses += 1;
    try {
      return await this.refreshMedia(channel, key);
    } catch (error) {
      if (entry && entry.items) {
        this.counters.mediaHits += 1;
        return entry;
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------- */
  /* encryption keys                                                   */
  /* ---------------------------------------------------------------- */

  async getKey(channel, url) {
    const cached = this.keys.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      this.counters.keyHits += 1;
      return cached.buffer;
    }
    const inflightKey = `key|${url}`;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const buffer = await this.upstream.fetchBytes(url, {
          channel,
          maxBytes: this.cfg.keyMaxBytes,
          timeoutMs: this.cfg.mediaTimeoutMs,
        });
        this.keys.set(url, { buffer, expiresAt: Date.now() + this.cfg.keyCacheMs });
        if (this.keys.size > 256) {
          const oldest = this.keys.keys().next().value;
          if (oldest !== undefined) this.keys.delete(oldest);
        }
        return buffer;
      } catch (error) {
        this.counters.keyErrors += 1;
        throw error;
      }
    })();
    this.inflight.set(inflightKey, promise);
    const cleanup = () => this.inflight.delete(inflightKey);
    promise.then(cleanup, cleanup);
    return promise;
  }

  /* ---------------------------------------------------------------- */
  /* views                                                             */
  /* ---------------------------------------------------------------- */

  channelView(channel) {
    const entry = this.masters.get(channel.id);
    const plan = entry ? entry.plan : null;
    const age = entry ? Date.now() - entry.fetchedAt : null;
    let status = 'pending';
    if (plan) {
      if (entry.error && age > this.cfg.cacheTtlMs * 2) status = 'stale';
      else status = 'live';
    } else if (entry && entry.error) {
      status = 'error';
    }
    return {
      id: channel.id,
      name: channel.name,
      logo: channel.logo || '',
      group: channel.group,
      language: channel.language || '',
      number: channel.number,
      url: `/live/high/${encodeURIComponent(channel.id)}.m3u8`,
      status,
      endpoint: entry ? entry.endpoint : null,
      latencyMs: entry ? Math.round(entry.latencyMs) : null,
      updatedAt: entry ? entry.fetchedAt : null,
      staleMs: age,
      error: entry && entry.error ? String(entry.error).slice(0, 200) : null,
      qualities: plan ? plan.variants.map((variant) => variant.label) : [],
      audio: plan
        ? plan.audio.map((track) => ({ name: track.name, lang: track.lang, default: Boolean(track.default) }))
        : [],
      defaultAudio: plan && plan.meta ? plan.meta.defaultAudio : null,
      dropped: plan ? plan.dropped : null,
      source: plan ? plan.type : null,
    };
  }

  snapshot() {
    const now = Date.now();
    let warmed = 0;
    let errored = 0;
    let stale = 0;
    for (const channel of this.channels) {
      const entry = this.masters.get(channel.id);
      if (!entry || !entry.plan) {
        errored += 1;
        continue;
      }
      warmed += 1;
      if (entry.error || now - entry.fetchedAt > this.cfg.cacheTtlMs * 2) stale += 1;
    }
    return {
      ok: warmed > 0,
      server: {
        uptimeSec: Math.round((now - this.startedAt) / 1000),
        node: process.version,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      channels: {
        total: this.channels.length,
        warmed,
        notWarmed: errored,
        stale,
        groups: new Set(this.channels.map((channel) => channel.group)).size,
      },
      warmer: { ...this.warmer, intervalMs: this.cfg.warmerIntervalMs, concurrency: this.cfg.warmerConcurrency },
      cache: {
        masters: this.masters.size,
        media: this.media.size,
        keys: this.keys.size,
        ttlMs: this.cfg.cacheTtlMs,
        mediaTtlMs: this.cfg.mediaCacheTtlMs,
      },
      counters: { ...this.counters },
      upstream: { ...this.upstream.stats, segmentMode: this.cfg.segmentMode, tokens: this.upstream.tokens.size },
      channelsSource: {
        kind: this.channelSource,
        url: this.cfg.channelsUrl || null,
        file: this.cfg.channelsFile,
        syncError: this.channelSyncError,
        refreshMs: this.cfg.channelsRefreshMs,
      },
      config: {
        channelsFile: this.cfg.channelsFile,
        segmentMode: this.cfg.segmentMode,
        warmerEnabled: this.cfg.warmerEnabled,
        allowAutoFallback: this.cfg.allowAutoFallback,
        upstreamBaseConfigured: Boolean(this.cfg.upstreamBase),
        demoMode: Boolean(this.cfg.demoMode),
      },
      channelFileError: this.channelFileError,
      loadedAt: this.channelsLoadedAt,
    };
  }
}

export { describePlan };
