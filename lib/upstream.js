import { sanitizeManifest } from './manifest.js';
import { isMpdUrl, mpdToHls } from './mpd.js';

export class UpstreamError extends Error {
  constructor(message, { status = 0, url = '', kind = 'upstream' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.url = url;
    this.kind = kind;
  }
}

function appendQuery(url, params) {
  if (!params) return url;
  try {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function pickPath(object, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);
}

/**
 * Thin HTTP client for the upstream (JioTV-Go style) server.
 *
 * It only ever asks for manifests and encryption keys — never media segments
 * unless SEGMENT_MODE=proxy was explicitly requested.
 */
export class Upstream {
  constructor(config, logger) {
    this.cfg = config;
    this.log = logger;
    this.tokens = new Map();
    this.stats = { manifest: 0, manifestFail: 0, token: 0, tokenFail: 0, key: 0, segment: 0 };
  }

  headersFor(channel) {
    const headers = {
      'user-agent': this.cfg.upstreamUserAgent,
      accept: '*/*',
      'accept-encoding': 'gzip, deflate',
    };
    Object.assign(headers, this.cfg.upstreamHeaders || {});
    if (channel && channel.headers) Object.assign(headers, channel.headers);
    return headers;
  }

  async authFor(channel, { force = false } = {}) {
    const token = await this.getToken(channel, { force });
    if (!token) return { token: null, headers: {}, query: null };
    const headers = {};
    if (this.cfg.tokenHeader) {
      headers[this.cfg.tokenHeader.toLowerCase()] = this.cfg.tokenHeaderFormat.replaceAll('{token}', token);
    }
    const query = this.cfg.tokenQuery ? { [this.cfg.tokenQuery]: token } : null;
    return { token, headers, query };
  }

  async getToken(channel, { force = false } = {}) {
    if (!this.cfg.tokenUrl) return null;
    const cached = this.tokens.get(channel.id);
    if (cached && !force && cached.pending) return cached.pending;
    if (cached && !force && cached.value && cached.expiresAt > Date.now()) return cached.value;

    const endpoint = this.cfg.tokenUrl
      .replaceAll('{id}', encodeURIComponent(channel.providerId || channel.id))
      .replaceAll('{name}', encodeURIComponent(channel.name || ''));

    const pending = (async () => {
      this.stats.token += 1;
      const response = await this.request(endpoint, {
        headers: this.headersFor(channel),
        timeoutMs: this.cfg.tokenTimeoutMs,
        kind: 'token',
      });
      const body = await response.text();
      let token = body.trim();
      try {
        const parsed = JSON.parse(body);
        const picked = pickPath(parsed, this.cfg.tokenField);
        if (picked !== undefined && picked !== null && String(picked) !== '') token = String(picked);
      } catch {
        /* plain-text token endpoint */
      }
      if (!token) {
        this.stats.tokenFail += 1;
        throw new UpstreamError('token endpoint returned an empty token', { url: endpoint, kind: 'token' });
      }
      this.tokens.set(channel.id, { value: token, expiresAt: Date.now() + this.cfg.tokenTtlMs });
      return token;
    })();

    pending.catch(() => {}); // mark handled for callers that only read the cache
    this.tokens.set(channel.id, { ...(cached || {}), pending });
    try {
      return await pending;
    } catch (error) {
      this.stats.tokenFail += 1;
      this.tokens.delete(channel.id);
      throw error;
    }
  }

  currentToken(channel) {
    const cached = this.tokens.get(channel.id);
    if (!cached || !cached.value) return null;
    return cached.expiresAt > Date.now() ? cached.value : null;
  }

  /**
   * Turn a playlist URL into a high-endpoint URL (PRD §4) while remembering
   * whether the original is safe as an emergency fallback.
   */
  normalizeCustomUrl(url) {
    let out = String(url)
      .replace(/\/live\/(low|medium)\//i, '/live/high/')
      .replace(/\/live\/(low|medium)(?=[?#]|$)/i, '/live/high');
    if (this.cfg.highFirstCustomUrls) {
      out = out.replace(/\/live\/(?!high\/|auto\/|low\/|medium\/)([^/?#]+\.m3u8?)(?=[?#]|$)/i, '/live/high/$1');
    }
    return out;
  }

  isDashUrl(url) {
    return isMpdUrl(url);
  }

  /** /live/mpd/<id>?q=high -> https://host/live/high/<id>.m3u8 (and *.mpd -> *.m3u8) */
  dashToHlsUrl(url) {
    return mpdToHls(url) || String(url);
  }

  resolveCustomUrl(channel) {
    return channel.customUrl.includes('{id}')
      ? channel.customUrl.replaceAll('{id}', encodeURIComponent(channel.providerId || channel.id))
      : channel.customUrl;
  }

  customUrlCandidates(channel) {
    const original = this.resolveCustomUrl(channel);
    if (this.isDashUrl(original)) {
      // DASH/Widevine cannot be played by an HLS relay; try the HLS twin only.
      return this.cfg.dashToHls ? [this.dashToHlsUrl(original)] : [];
    }
    const high = this.normalizeCustomUrl(original);
    const candidates = [high];
    const forbidden = /\/live\/(low|medium)(\/|[?#]|$)/i.test(original);
    if (high !== original && !forbidden) candidates.push(original);
    return candidates;
  }

  masterUrl(channel, endpoint = 'high') {
    const template = endpoint === 'high' ? this.cfg.upstreamHighPath : this.cfg.upstreamAutoPath;
    if (channel.customUrl) {
      // Never hand a low/medium URL to a player or the warmer.
      return this.customUrlCandidates(channel)[0];
    }
    if (!this.cfg.upstreamBase) {
      throw new UpstreamError(
        `no UPSTREAM_BASE configured (channel ${channel.id}) — set UPSTREAM_BASE or use absolute URLs in channels.m3u`,
        { kind: 'config' },
      );
    }
    const id = channel.providerId || channel.id;
    return `${this.cfg.upstreamBase}${template.replaceAll('{id}', encodeURIComponent(id))}`;
  }

  async request(url, { headers = {}, timeoutMs = this.cfg.upstreamTimeoutMs, kind = 'manifest', redirect = 'follow' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await fetch(url, {
        headers,
        redirect,
        signal: controller.signal,
        // Node's fetch decompresses gzip transparently; identity keeps it simple.
        compress: true,
      });
      return response;
    } catch (error) {
      throw new UpstreamError(
        error && error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error && error.message ? error.message : error),
        { status: 0, url, kind },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async readCapped(response, maxBytes) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new UpstreamError(`response larger than ${maxBytes} bytes`, { kind: 'size' });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }

  async fetchText(url, { channel, auth, timeoutMs, maxBytes, kind = 'manifest' } = {}) {
    const headers = this.headersFor(channel);
    if (auth) Object.assign(headers, auth.headers);
    const target = auth && auth.query ? appendQuery(url, auth.query) : url;
    const response = await this.request(target, { headers, timeoutMs, kind });
    if (!response.ok) {
      // Drain the body so the socket can be reused.
      response.body?.cancel?.().catch(() => {});
      throw new UpstreamError(`upstream returned HTTP ${response.status}`, {
        status: response.status,
        url: target,
        kind,
      });
    }
    const text = await this.readCapped(response, maxBytes || this.cfg.upstreamMaxBytes);
    return { text, url: response.url || target };
  }

  /**
   * High-first master fetch with an emergency auto fallback (PRD §4).
   * A 401/403 triggers one forced token refresh before the fallback.
   */
  async fetchMaster(channel) {
    const targets = [];
    if (channel.customUrl) {
      const candidates = this.customUrlCandidates(channel);
      if (!candidates.length) {
        throw new RelayError(`${channel.id}: upstream offers only DASH (Widevine), no HLS endpoint`, 502);
      }
      candidates.forEach((url, index) => {
        if (index > 0 && !this.cfg.allowAutoFallback) return;
        targets.push({ endpoint: index === 0 ? 'high' : 'auto', url });
      });
    } else {
      targets.push({ endpoint: 'high', url: this.masterUrl(channel, 'high') });
      if (this.cfg.allowAutoFallback && this.cfg.upstreamAutoPath) {
        targets.push({ endpoint: 'auto', url: this.masterUrl(channel, 'auto') });
      }
    }

    let auth = await this.authFor(channel).catch((error) => {
      this.log.debug(`token fetch failed for ${channel.id}: ${error.message}`);
      return { headers: {}, query: null };
    });

    let lastError = null;
    for (const target of targets) {
      let refreshed = false;
      for (;;) {
        this.stats.manifest += 1;
        try {
          const { text, url: finalUrl } = await this.fetchText(target.url, { channel, auth });
          let clean;
          try {
            clean = sanitizeManifest(text);
          } catch (error) {
            throw new UpstreamError(error.message, { url: target.url, kind: 'format' });
          }
          return { text: clean, url: finalUrl || target.url, endpoint: target.endpoint };
        } catch (error) {
          lastError = error;
          this.stats.manifestFail += 1;
          const needsAuth = (error.status === 401 || error.status === 403) && !refreshed && this.cfg.tokenUrl;
          if (needsAuth) {
            refreshed = true;
            auth = await this.authFor(channel, { force: true }).catch(() => ({ headers: {}, query: null }));
            continue;
          }
          break;
        }
      }
    }
    throw lastError || new UpstreamError('no upstream endpoint available', { kind: 'config' });
  }

  /** Fetch a variant/audio media playlist (small text) with token retry. */
  async fetchPlaylist(url, channel) {
    let auth = await this.authFor(channel).catch(() => ({ headers: {}, query: null }));
    let refreshed = false;
    for (;;) {
      this.stats.manifest += 1;
      try {
        const { text, url: finalUrl } = await this.fetchText(url, {
          channel,
          auth,
          timeoutMs: this.cfg.mediaTimeoutMs,
        });
        return { text: sanitizeManifest(text), url: finalUrl || url };
      } catch (error) {
        this.stats.manifestFail += 1;
        if ((error.status === 401 || error.status === 403) && !refreshed && this.cfg.tokenUrl) {
          refreshed = true;
          auth = await this.authFor(channel, { force: true }).catch(() => ({ headers: {}, query: null }));
          continue;
        }
        throw error;
      }
    }
  }

  async fetchBytes(url, { channel, maxBytes = 64 * 1024, timeoutMs = this.cfg.mediaTimeoutMs } = {}) {
    this.stats.key += 1;
    const headers = this.headersFor(channel);
    const response = await this.request(url, { headers, timeoutMs, kind: 'key' });
    if (!response.ok) {
      response.body?.cancel?.().catch(() => {});
      throw new UpstreamError(`key request returned HTTP ${response.status}`, {
        status: response.status,
        url,
        kind: 'key',
      });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new UpstreamError('key larger than allowed', { url, kind: 'key' });
    }
    return buffer;
  }

  /** Append the live token to a segment URL when explicitly enabled. */
  applySegmentAuth(url, channel) {
    if (!this.cfg.tokenAppendSegments || !this.cfg.tokenQuery || !channel) return url;
    const token = this.currentToken(channel);
    return token ? appendQuery(url, { [this.cfg.tokenQuery]: token }) : url;
  }
}

export { appendQuery };
