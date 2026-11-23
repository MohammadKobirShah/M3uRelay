import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeXml } from './util.js';

/**
 * The playlist generator.
 *
 * One renderer feeds both HTTP (`/playlist.m3u`) and the on-disk file that is
 * regenerated whenever the channel list changes, so VLC / TiviMate / OTT
 * Navigator always read the same URLs the panel uses.
 */

/**
 * A channel name or a source playlist can contain a stray newline or control
 * character. Left alone it would split one channel into two broken `#EXTINF`
 * entries, so every user-supplied string is cleaned before rendering.
 */
function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Attribute values are cleaned *and* XML escaped. */
function attrValue(value) {
  return escapeXml(cleanText(value));
}

/**
 * The text after `#EXTINF:...,` is a plain display title, so players show it
 * verbatim — it is cleaned but not escaped.
 */
function displayTitle(channel) {
  return cleanText(channel.name || channel.id || '');
}

export function buildPlaylist(channels, { origin, updatedAt = 0, name = '' } = {}) {
  const base = String(origin || '').replace(/\/+$/, '');
  const lines = ['#EXTM3U'];
  const stamp = updatedAt ? new Date(updatedAt).toISOString() : null;
  lines.push(
    `# MY IPTV PRO — ${channels.length} channels${stamp ? ` · updated ${stamp}` : ''}${name ? ` · ${name}` : ''}`,
  );
  lines.push('# every stream below is the high-only HLS endpoint; segments go straight to the CDN');

  for (const channel of channels) {
    const attrs = [`tvg-id="${attrValue(channel.id)}"`];
    if (channel.name) attrs.push(`tvg-name="${attrValue(channel.name)}"`);
    if (channel.logo) attrs.push(`tvg-logo="${attrValue(channel.logo)}"`);
    if (channel.group) attrs.push(`group-title="${attrValue(channel.group)}"`);
    if (channel.language) attrs.push(`tvg-language="${attrValue(channel.language)}"`);
    const number = channel.number || channel.order + 1;
    if (number) attrs.push(`tvg-chno="${number}"`);
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${displayTitle(channel)}`);
    lines.push(`${base}/live/high/${encodeURIComponent(channel.id)}.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}

/** Stable ETag for a rendered playlist (changes with the channel list and origin). */
export function playlistEtag(channels, { origin = '', updatedAt = 0 } = {}) {
  return `W/"pl-${channels.length}-${updatedAt}-${String(origin).length}"`;
}

/**
 * Keeps `PLAYLIST_FILE` in sync with the relay's channel list.
 *
 * Writes are atomic (tmp file + rename) and serialised, so a player polling the
 * file never sees a half-written playlist. A missing directory is created.
 */
export class PlaylistFile {
  constructor({ config, logger, root = process.cwd(), getChannels, getUpdatedAt, origin }) {
    this.cfg = config;
    this.log = logger;
    this.root = root;
    this.getChannels = getChannels;
    this.getUpdatedAt = getUpdatedAt;
    this.origin = origin;
    this.timer = null;
    this.writing = null;
    this.state = {
      enabled: Boolean(config.playlistFile),
      file: null,
      channels: 0,
      bytes: 0,
      generatedAt: null,
      error: null,
    };
    if (config.playlistFile) {
      this.state.file = path.isAbsolute(config.playlistFile)
        ? config.playlistFile
        : path.join(root, config.playlistFile);
    }
  }

  get originUrl() {
    const origin = typeof this.origin === 'function' ? this.origin() : this.origin;
    return String(origin || this.cfg.publicUrl || `http://localhost:${this.cfg.port}`);
  }

  /** Serialise writes: a burst of /api/sync calls must not interleave. */
  write() {
    if (!this.state.enabled) return Promise.resolve(null);
    if (this.writing) return this.writing;
    this.writing = this.#writeOnce().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }

  async #writeOnce() {
    if (!this.state.file) return null;
    const channels = this.getChannels() || [];
    const origin = this.originUrl;
    const updatedAt = this.getUpdatedAt ? this.getUpdatedAt() : 0;
    const text = buildPlaylist(channels, { origin, updatedAt });
    try {
      await fs.mkdir(path.dirname(this.state.file), { recursive: true });
      const tmp = `${this.state.file}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, this.state.file);
      this.state.channels = channels.length;
      this.state.bytes = Buffer.byteLength(text);
      this.state.generatedAt = Date.now();
      this.state.error = null;
      this.log.debug?.(`playlist file written: ${this.state.file} (${this.state.bytes} bytes)`);
      return text;
    } catch (error) {
      this.state.error = error.message;
      this.log.warn(`cannot write playlist file ${this.state.file}: ${error.message}`);
      return null;
    }
  }

  start(intervalMs) {
    if (!this.state.enabled) return;
    this.write();
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.write(), intervalMs);
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      ...this.state,
      refreshMs: this.state.enabled ? this.cfg.playlistRefreshMs : 0,
      origin: this.state.enabled ? this.originUrl : null,
    };
  }
}
