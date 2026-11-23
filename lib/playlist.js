import fs from 'node:fs/promises';
import os from 'node:os';
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

/** Errors that mean "this location cannot be written", not "the code is wrong". */
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EBUSY', 'ENOSPC', 'EINVAL']);

/**
 * Keeps `PLAYLIST_FILE` in sync with the relay's channel list.
 *
 * Writes are atomic (tmp file + rename) and serialised, so a player polling the
 * file never sees a half-written playlist. A missing directory is created.
 *
 * The default path lives inside the app directory, which is read-only in the
 * published image (`USER node` owns nothing in `/app`). Instead of warning on
 * every refresh and never producing a file, an unwritable location falls back
 * to `<root>/.cache/` and then to the OS temp dir, and says so once with a fix.
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
    this.index = 0;
    this.lastWarning = null;

    const configured = config.playlistFile
      ? path.isAbsolute(config.playlistFile)
        ? config.playlistFile
        : path.join(root, config.playlistFile)
      : null;
    this.configuredFile = configured;
    const base = configured ? path.basename(configured) : 'playlist.m3u';
    this.candidates = configured
      ? [...new Set([configured, path.join(root, '.cache', base), path.join(os.tmpdir(), `m3urelay-${base}`)])]
      : [];

    this.state = {
      enabled: Boolean(configured),
      file: configured,
      configuredFile: configured,
      fallback: false,
      warning: null,
      channels: 0,
      bytes: 0,
      generatedAt: null,
      error: null,
    };
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

  async #writeTo(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o644 });
    await fs.rename(tmp, file);
  }

  async #writeOnce() {
    if (!this.state.enabled) return null;
    const channels = this.getChannels() || [];
    // Never blank a good file: at boot the channel list can still be empty.
    if (channels.length === 0 && this.state.generatedAt) {
      this.log.debug?.('playlist file not rewritten: channel list is empty');
      return null;
    }
    const origin = this.originUrl;
    const updatedAt = this.getUpdatedAt ? this.getUpdatedAt() : 0;
    const text = buildPlaylist(channels, { origin, updatedAt });

    let lastError = null;
    for (let i = this.index; i < this.candidates.length; i += 1) {
      const file = this.candidates[i];
      try {
        await this.#writeTo(file, text);
        this.index = i;
        this.state.file = file;
        this.state.fallback = file !== this.configuredFile;
        this.state.warning = this.state.fallback
          ? `${this.configuredFile} is not writable — writing to ${file}. Set PLAYLIST_FILE to a writable path.`
          : null;
        this.state.channels = channels.length;
        this.state.bytes = Buffer.byteLength(text);
        this.state.generatedAt = Date.now();
        this.state.error = null;
        if (this.state.fallback && this.lastWarning !== this.state.warning) {
          this.lastWarning = this.state.warning;
          this.log.warn(`playlist ${this.state.warning}`);
        } else {
          this.log.debug?.(`playlist file written: ${file} (${this.state.bytes} bytes)`);
        }
        return text;
      } catch (error) {
        lastError = error;
        if (!UNWRITABLE.has(error.code)) break;
      }
    }

    const message = `${lastError && lastError.code ? `${lastError.code}: ` : ''}${lastError ? lastError.message : 'no writable path'}`;
    this.state.error = message;
    if (this.lastWarning !== message) {
      this.lastWarning = message;
      this.log.warn(
        `cannot write playlist file ${this.configuredFile}: ${message} — set PLAYLIST_FILE to a writable path (e.g. /app/.cache/playlist.m3u) or run the container with a writable volume`,
      );
    }
    return null;
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
