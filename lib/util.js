import crypto from 'node:crypto';

/** Base64url without padding — safe inside URLs and query strings. */
export function b64urlEncode(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Decode base64url. Returns null on malformed input instead of throwing. */
export function b64urlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(padded, 'base64');
  return buf.toString('utf8');
}

/** Short deterministic signature so /s and /k cannot be used as an open proxy. */
export function signUrl(secret, url) {
  return crypto
    .createHmac('sha256', secret)
    .update(url)
    .digest()
    .subarray(0, 16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function verifyUrl(secret, url, signature) {
  if (typeof signature !== 'string' || signature.length !== 22) return false;
  const expected = signUrl(secret, url);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Resolve a possibly relative playlist URI against the manifest URL. */
export function resolveUrl(uri, baseUrl) {
  const raw = String(uri || '').trim();
  if (!raw) return raw;
  if (/^(data:|skd:|blob:)/i.test(raw)) return raw;
  if (/^https?:/i.test(raw)) {
    try {
      return new URL(raw).toString();
    } catch {
      return raw;
    }
  }
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return raw;
  }
}

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

/** Reject redirects into loopback / RFC1918 space when proxying bytes. */
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function parseJsonEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs tasks with bounded concurrency, preserving order of results. */
export async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit || 1, list.length || 1));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Absolute origin (scheme://host) for a request, honouring PUBLIC_URL / proxies. */
export function requestOrigin(req, publicUrl) {
  if (publicUrl) return publicUrl.replace(/\/$/, '');
  const forwardedProto = headerValue(req, 'x-forwarded-proto');
  const forwardedHost = headerValue(req, 'x-forwarded-host');
  const host = forwardedHost || headerValue(req, 'host') || 'localhost';
  let proto = forwardedProto ? forwardedProto.split(',')[0].trim() : '';
  if (!proto) {
    const cfVisitor = headerValue(req, 'cf-visitor');
    if (cfVisitor) {
      const match = /"scheme"\s*:\s*"([a-z]+)"/i.exec(cfVisitor);
      if (match) proto = match[1];
    }
  }
  if (!proto) proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  const safeHost = /^[A-Za-z0-9.:[\]_-]+(:\d+)?$/.test(host) ? host : 'localhost';
  return `${proto}://${safeHost}`;
}

export function headerValue(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
