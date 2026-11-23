import dns from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { parseChannelList } from './channels.js';
import { banglaChannelName, banglaGroupName } from './bangla.js';

/**
 * One-shot health check for the channel-list URL.
 *
 * The relay runs on the user's own box, so this is the tool that answers
 * "why is the panel empty?" without shell access: DNS, TCP/TLS/HTTP timing,
 * status code, playlist shape and the exact reason a list was rejected.
 */

function round(ms) {
  return Math.round(ms * 10) / 10;
}

function classify(channel) {
  if (channel.customUrl) {
    const url = channel.customUrl;
    if (/\/live\/high\//i.test(url)) return 'high';
    if (/\/live\/(low|medium)\//i.test(url)) return 'low';
    if (/\/live\/[^/?#]+\.m3u8?/i.test(url)) return 'auto';
    return 'other';
  }
  if (channel.providerId) return 'provider';
  return 'unknown';
}

/** The URL the relay would sync from when CHANNELS_URL is not set. */
export function inferredChannelsUrl(config) {
  if (config.channelsUrl) return config.channelsUrl;
  if (config.upstreamBase) {
    try {
      return new URL('/playlist.m3u?q=high', config.upstreamBase).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export async function probeChannelSource(target, options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const headers = options.headers || {};
  const result = {
    url: target,
    checkedAt: Date.now(),
    ok: false,
    dns: null,
    http: null,
    playlist: null,
    samples: [],
    findings: [],
  };
  const finding = (level, code, en, bn) => result.findings.push({ level, code, en, bn });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    finding('error', 'invalid-url', 'The channel URL is not a valid absolute URL.', 'চ্যানেল URL টি সঠিক ফরম্যাটে নেই।');
    return result;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    finding('error', 'invalid-url', 'Only http and https URLs are supported.', 'শুধু http/https URL কাজ করে।');
    return result;
  }

  /* DNS ---------------------------------------------------------------- */
  const dnsStarted = performance.now();
  try {
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    result.dns = {
      host: parsed.hostname,
      ms: round(performance.now() - dnsStarted),
      addresses: [...new Set(addresses.map((entry) => entry.address))],
    };
    if (!addresses.length) {
      finding('error', 'dns-empty', 'The hostname did not resolve to any address.', 'হোস্টনেম থেকে কোনো IP পাওয়া যায়নি।');
      return result;
    }
  } catch (error) {
    result.dns = {
      host: parsed.hostname,
      ms: round(performance.now() - dnsStarted),
      error: error.code || error.message,
    };
    finding(
      'error',
      'dns',
      `DNS lookup failed for ${parsed.hostname} (${error.code || error.message}). Inside Docker the container needs its own DNS/hosts entry for a LAN name.`,
      `${parsed.hostname} এর DNS রিজলভ হয়নি (${error.code || error.message})। Docker-এর ভেতরে লোকাল নাম চলতে হলে কন্টেইনারকে আলাদা করে hosts/DNS দিতে হবে।`,
    );
    return result;
  }

  /* HTTP --------------------------------------------------------------- */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const httpStarted = performance.now();
  try {
    const response = await fetch(target, {
      headers: {
        accept: 'application/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*',
        'user-agent': options.userAgent || 'M3uRelay-probe/1.0',
        ...headers,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await response.text();
    const ms = round(performance.now() - httpStarted);
    const bytes = Buffer.byteLength(text);
    result.http = {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type') || null,
      server: response.headers.get('server') || null,
      bytes,
      ms,
      redirectedTo: response.url && response.url !== target ? response.url : null,
    };

    if (!response.ok) {
      finding(
        'error',
        'http-status',
        `The server answered HTTP ${response.status}.`,
        `সার্ভার HTTP ${response.status} ফেরত দিয়েছে।`,
      );
      return result;
    }
    if (!/#EXTINF/i.test(text)) {
      finding(
        'error',
        'not-a-playlist',
        'The response is not an M3U channel list (no #EXTINF found). Often this means a login page, a 200 error page, or the wrong path.',
        'রেসপন্সে M3U চ্যানেল লিস্ট নেই (#EXTINF পাওয়া যায়নি)। সাধারণত লগইন পেজ, ভুল পাথ বা ২০০ স্ট্যাটাসে এরর পেজ বোঝায়।',
      );
      return result;
    }

    const base = response.url || target;
    const list = parseChannelList(text, { baseUrl: base, defaultGroup: 'Other' });
    const quality = { high: 0, auto: 0, low: 0, provider: 0, other: 0 };
    for (const channel of list.channels) quality[classify(channel)] += 1;

    result.playlist = {
      channels: list.channels.length,
      duplicates: list.duplicates.length,
      groups: new Set(list.channels.map((channel) => channel.group)).size,
      withLogo: list.channels.filter((channel) => channel.logo).length,
      quality,
      baseUrl: base,
    };
    result.samples = list.channels.slice(0, 5).map((channel) => ({
      id: channel.id,
      name: channel.name,
      nameBn: banglaChannelName(channel.name),
      group: channel.group,
      groupBn: banglaGroupName(channel.group),
      logo: channel.logo || null,
      url: channel.customUrl || (channel.providerId ? `provider id ${channel.providerId}` : null),
      shape: classify(channel),
    }));

    if (!list.channels.length) {
      finding('error', 'no-channels', 'The playlist has no parsable channels.', 'প্লেলিস্টে কোনো চ্যানেল পাওয়া যায়নি।');
      return result;
    }

    result.ok = true;
    finding(
      'ok',
      'synced',
      `${list.channels.length} channels in ${result.playlist.groups} groups (${ms} ms, ${bytes} bytes).`,
      `${list.channels.length} টি চ্যানেল, ${result.playlist.groups} টি গ্রুপ (${ms} ms, ${bytes} বাইট)।`,
    );
    if (quality.auto > 0) {
      finding(
        'info',
        'auto-promoted',
        `${quality.auto} URLs have no quality segment; the relay promotes them to /live/high/ and keeps the original as fallback.`,
        `${quality.auto} টি URL-এ কোয়ালিটি অংশ নেই; রিলে সেগুলোকে /live/high/ বানিয়ে চেষ্টা করে আর মূলটি ফলব্যাক রাখে।`,
      );
    }
    if (quality.low > 0) {
      finding(
        'warn',
        'low-urls',
        `${quality.low} URLs point at low/medium quality; the relay rewrites them to high.`,
        `${quality.low} টি URL low/medium কোয়ালিটিতে আছে; রিলে সেগুলো high-এ বদলে নেয়।`,
      );
    }
    if (quality.provider > 0 && !options.hasUpstreamBase) {
      finding(
        'warn',
        'needs-upstream',
        `${quality.provider} channels are bare ids and need UPSTREAM_BASE to be set.`,
        `${quality.provider} টি চ্যানেল শুধু আইডি — এগুলোর জন্য UPSTREAM_BASE সেট করতে হবে।`,
      );
    }
    if (bytes > 2 * 1024 * 1024) {
      finding(
        'warn',
        'large-playlist',
        `The playlist is ${(bytes / 1024 / 1024).toFixed(1)} MB, which is unusually large.`,
        `প্লেলিস্টের আকার ${(bytes / 1024 / 1024).toFixed(1)} MB — বেশ বড়।`,
      );
    }
    return result;
  } catch (error) {
    const aborted = error.name === 'AbortError';
    result.http = { ms: round(performance.now() - httpStarted), error: aborted ? 'timeout' : error.message };
    finding(
      'error',
      aborted ? 'timeout' : 'network',
      aborted
        ? `No response within ${timeoutMs} ms.`
        : `Could not reach the server (${error.message}).`,
      aborted ? `${timeoutMs} ms এর মধ্যে উত্তর আসেনি।` : `সার্ভারে পৌঁছানো যায়নি (${error.message})।`,
    );
    return result;
  } finally {
    clearTimeout(timer);
  }
}
