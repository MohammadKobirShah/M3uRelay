/**
 * MPD (DASH) → HLS mapping.
 *
 * The relay only speaks HLS (PRD §1: no FFmpeg, no DASH playback), so every MPD
 * URL that comes in from a provider playlist has to be pointed at its HLS twin
 * *before* it is fetched, shown or written to a playlist file.
 *
 * JioTV-Go publishes DRM channels as `/live/mpd/<id>?q=high` while the same
 * channel also exists as `/live/high/<id>.m3u8`, which is the mapping that
 * matters most here. Everything else is a best-effort extension swap
 * (`index.mpd` → `index.m3u8`, `/dash/x` → `/high/x.m3u8`).
 */

const MPD_PATTERNS = [
  /\.mpd(?:[?#]|$)/i,
  /\/live\/(?:mpd|dash)\//i,
  /\/mpd\//i,
  /\/dash\//i,
  /\/manifest\.mpd/i,
];

/** True for anything that is a DASH manifest rather than an HLS playlist. */
export function isMpdUrl(url) {
  const value = String(url || '');
  if (!value || /\.m3u8?(?:[?#]|$)/i.test(value)) return false;
  return MPD_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * The channel id carried by a JioTV-Go style DASH URL, or null.
 *   https://host/live/mpd/143?q=high      -> "143"
 *   https://host/live/dash/143.mpd        -> "143"
 */
export function mpdChannelId(url) {
  const match = /\/live\/(?:mpd|dash)\/([^/?#]+?)(?:\.mpd)?(?:[?#]|$)/i.exec(String(url || ''));
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Convert an MPD URL to its HLS twin.
 * Returns null when the URL is not DASH so callers can branch cheaply.
 */
export function mpdToHls(url) {
  const value = String(url || '');
  if (!isMpdUrl(value)) return null;

  const id = mpdChannelId(value);
  if (id != null) {
    // /live/mpd/<id> and /live/dash/<id> have a sibling /live/high/<id>.m3u8
    return value.replace(
      /\/live\/(?:mpd|dash)\/([^/?#]+?)(?:\.mpd)?(?:[?#].*)?$/i,
      `/live/high/${encodeURIComponent(id)}.m3u8`,
    );
  }

  // .../dash/<name>/manifest.mpd -> .../high/<name>.m3u8
  const manifest = /\/(?:mpd|dash)\/([^/?#]+)\/manifest\.mpd(?:[?#]|$)/i.exec(value);
  if (manifest && manifest[1]) {
    return value.replace(
      /\/(?:mpd|dash)\/[^/?#]+\/manifest\.mpd(?=[?#]|$)/i,
      `/high/${manifest[1]}.m3u8`,
    );
  }

  // Generic /mpd/<name> or /dash/<name> folder: use the /high/ sibling.
  if (/\/mpd\/[^/?#]+|\/dash\/[^/?#]+/i.test(value)) {
    return value
      .replace(/\/(?:mpd|dash)\//i, '/high/')
      .replace(/\.mpd(?=[?#]|$)/i, '.m3u8')
      .replace(/(\/high\/[^/?#.]+)(?=[?#]|$)/i, '$1.m3u8');
  }

  // Last resort: same directory, switch the manifest extension.
  return value.replace(/\.mpd(?=[?#]|$)/i, '.m3u8');
}
