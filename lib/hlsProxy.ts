/**
 * lib/hlsProxy.ts
 * ────────────────────────────────────────────────────────────────────────
 * Core HLS (.m3u8) fetch + rewrite logic — shared by every route under
 * app/api/pwlive/* and app/api/live/[title]/playlist.
 *
 * Two rewrite modes:
 *   - "proxy"  → every segment / nested-playlist URL is rewritten to point
 *                back at OUR OWN domain (/api/pwlive/seg?u=<token>). Used
 *                for the in-browser PLAYER (hls.js needs same-origin /
 *                CORS-enabled URLs, and this also hides the real CDN URL).
 *   - "direct" → every segment / nested-playlist URL is rewritten to an
 *                ABSOLUTE real CDN url with the playlist's signed-CDN auth
 *                params (Signature/Policy/Key-Pair-Id/etc.) copied onto it
 *                — but NOT proxied through us. Used for the DOWNLOAD route:
 *                a download manager (1DM etc.) or the browser fetches every
 *                segment directly from the CDN in parallel — much faster
 *                and avoids routing potentially thousands of segment
 *                requests through a serverless function.
 */

// A generic modern browser User-Agent + a few extra client-hint headers.
// Several CDN edge nodes treat requests without these as "non-browser"
// and either drop them or serve degraded/slow responses.
export const UPSTREAM_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.pw.live/",
  Origin: "https://www.pw.live",
  "sec-ch-ua": '"Chromium";v="126", "Not_A Brand";v="8"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

// Query-param names (case-insensitive) that are CDN signed-URL auth
// tokens — these get copied from the playlist URL onto same-host segment
// URLs that don't already carry them (segments in a signed-CDN playlist
// often only carry a PATH, relying on the parent playlist's query string
// for authorization).
const AUTH_PARAMS = new Set([
  "signature",
  "policy",
  "key-pair-id",
  "expires",
  "start",
  "session-id",
]);

const UPSTREAM_TIMEOUT_MS = 15_000;
const UPSTREAM_MAX_RETRIES = 2; // transient CDN edge hiccups ke liye

// ── base64url helpers (opaque segment tokens for "proxy" mode) ─────────
export function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}
export function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8");
}

/**
 * Upstream fetch with retry + backoff:
 *   - 2xx and 4xx are both FINAL (retrying a 4xx — e.g. an expired signed
 *     URL — wastes time and won't fix itself).
 *   - Only 5xx / network-level errors (timeout, DNS, reset) are retried,
 *     with a small backoff.
 */
export async function fetchUpstream(
  url: string,
  rangeHeader?: string | null
): Promise<Response> {
  const headers: Record<string, string> = { ...UPSTREAM_HEADERS };
  if (rangeHeader) headers["Range"] = rangeHeader;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= UPSTREAM_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers,
        redirect: "follow",
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res; // final — 2xx ya 4xx, retry se koi fayda nahi
      }
      lastErr = new Error(`Upstream ${res.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
    if (attempt < UPSTREAM_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Upstream fetch failed");
}

function inheritAuthParams(segUrl: string, playlistUrl: string): string {
  try {
    const seg = new URL(segUrl);
    const pl = new URL(playlistUrl);
    if (seg.host !== pl.host) return segUrl;
    const segKeysLower = new Set(
      Array.from(seg.searchParams.keys()).map((k) => k.toLowerCase())
    );
    for (const [k, v] of pl.searchParams.entries()) {
      if (AUTH_PARAMS.has(k.toLowerCase()) && !segKeysLower.has(k.toLowerCase())) {
        seg.searchParams.append(k, v);
      }
    }
    return seg.toString();
  } catch {
    return segUrl;
  }
}

export type RewriteOpts =
  | { mode: "proxy"; origin: string }
  | { mode: "direct" };

/**
 * Rewrite every URL reference inside an .m3u8 body (plain segment lines,
 * nested/variant playlist lines, and `URI="..."` attributes such as
 * #EXT-X-KEY / #EXT-X-MAP) according to `opts`.
 */
export function rewriteM3U8(body: string, playlistUrl: string, opts: RewriteOpts): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];

  const transform = (raw: string): string => {
    const absolute = new URL(raw.trim(), playlistUrl).toString();
    const withAuth = inheritAuthParams(absolute, playlistUrl);
    if (opts.mode === "direct") return withAuth;
    const token = b64urlEncode(withAuth);
    return `${opts.origin}/api/pwlive/seg?u=${token}`;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      out.push(line);
      continue;
    }
    if (t.startsWith("#")) {
      if (/URI="/i.test(t)) {
        out.push(line.replace(/URI="([^"]+)"/gi, (_m, p1) => `URI="${transform(p1)}"`));
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(transform(t));
  }
  return out.join("\n") + "\n";
}

/** True if the URL looks like an .m3u8 (by extension or content-type). */
export function looksLikeM3U8(url: string, contentType?: string | null): boolean {
  const ctype = (contentType || "").toLowerCase();
  if (ctype.includes("mpegurl") || ctype.includes("m3u8")) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return url.toLowerCase().split("?")[0].endsWith(".m3u8");
  }
}
