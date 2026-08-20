"""
app.py — PW Live HLS proxy + player (plain Flask, no DB / no admin / no
recorder — just the working proxy+player core).

Ported from the reference repo's main.py (add_cors_headers, _fetch_upstream
retry logic, _rewrite_m3u8, _inherit_auth_params) — same proven approach,
trimmed down to exactly what's needed here, PLUS two bugs already fixed
that the original TS/Next.js attempt had:

  1. Query-string truncation — if `?url=<CDN link>` is ever appended with
     the CDN link's OWN `&`/`?` left un-encoded (e.g. pasted raw into a
     browser address bar to test, instead of going through /player which
     encodeURIComponent()s it first), `request.args.get("url")` would only
     return everything up to the FIRST `&` — silently dropping
     Signature / Key-Pair-Id / Policy. We then fetch the CDN without a
     valid signature → CloudFront 403s. Fixed by extract_url_param() below,
     which reads the raw query string manually and is safe either way.

  2. Missing Cache-Control on the *nested/child* playlist response in the
     segment proxy — for master→child playlist live streams, this child
     playlist is what gets re-polled every few seconds for new segments.
     Without an explicit no-store, an edge/browser cache could keep
     serving the FIRST response back forever → playback looked like it
     "plays 3-5s then freezes/loops" because hls.js never actually saw new
     segments. Fixed below by always setting no-store on that response.

Routes:
  GET /player?url=<m3u8>          — the actual watchable page (player.html)
  GET /api/pw/stream?url=<m3u8>   — proxied LIVE playlist (proxy mode)
  GET /api/pw/seg?u=<token>       — segment / nested-playlist relay
  GET /api/pw/download?url=<m3u8> — direct-CDN playlist (for 1DM / download managers)
  GET /health                     — simple healthcheck
"""

import base64
import os
import re
import time
from urllib.parse import urljoin, urlparse, parse_qsl, urlencode, urlunparse, unquote

import requests
from flask import Flask, request, jsonify, Response, render_template

app = Flask(__name__)

# ─── Upstream fetch config (ported as-is from the reference proxy) ────────
UPSTREAM_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.pw.live/",
    "Origin": "https://www.pw.live",
    "sec-ch-ua": '"Chromium";v="126", "Not_A Brand";v="8"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}

AUTH_PARAMS = {"signature", "policy", "key-pair-id", "expires", "start", "session-id"}
UPSTREAM_TIMEOUT = 15
UPSTREAM_MAX_RETRIES = 2  # transient CDN edge hiccups ke liye

NO_STORE_HEADERS = {"Cache-Control": "no-cache, no-store, must-revalidate"}


# ─── CORS — every response, success ya error, exactly like the reference ──
@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "*"
    resp.headers["Access-Control-Expose-Headers"] = "*"
    resp.headers["Access-Control-Max-Age"] = "86400"
    # hls.js reads cross-origin fetch timings for its ABR logic via the
    # Resource Timing API — without this the entries come back zeroed.
    resp.headers["Timing-Allow-Origin"] = "*"
    return resp


# ─── Robust ?url=... reader (see bug #1 above) ─────────────────────────────
def extract_url_param(param_name="url"):
    qs = request.query_string.decode("utf-8", errors="replace")  # RAW, undecoded
    marker = f"{param_name}="
    idx = qs.find(marker)
    if idx == -1:
        return None
    raw = qs[idx + len(marker):]
    if not raw:
        return None
    try:
        return unquote(raw)
    except Exception:
        return raw


# ─── base64url helpers (opaque segment tokens) ─────────────────────────────
def b64e(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


def b64d(s: str) -> str:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad).decode()


def looks_like_m3u8(url: str, content_type: str = None) -> bool:
    ctype = (content_type or "").lower()
    if "mpegurl" in ctype or "m3u8" in ctype:
        return True
    try:
        return urlparse(url).path.lower().endswith(".m3u8")
    except Exception:
        return url.lower().split("?")[0].endswith(".m3u8")


def inherit_auth_params(seg_url: str, playlist_url: str) -> str:
    """Signed-CDN playlist ke auth params same-host segments pe copy karo
    (segments in a signed playlist often only carry a PATH, relying on the
    parent playlist's query string for authorization)."""
    try:
        seg = urlparse(seg_url)
        pl = urlparse(playlist_url)
        if seg.netloc != pl.netloc:
            return seg_url
        seg_q = dict(parse_qsl(seg.query, keep_blank_values=True))
        seg_lower = {k.lower() for k in seg_q}
        for k, v in parse_qsl(pl.query, keep_blank_values=True):
            if k.lower() in AUTH_PARAMS and k.lower() not in seg_lower:
                seg_q[k] = v
        return urlunparse(seg._replace(query=urlencode(seg_q)))
    except Exception:
        return seg_url


def rewrite_m3u8(body: str, playlist_url: str, mode: str) -> str:
    """
    mode="proxy"  → every segment / nested-playlist URL rewritten to point
                    back at THIS server (/api/pw/seg?u=<token>) — used by
                    the in-browser player (same-origin, no CORS issues,
                    real CDN URL never reaches client JS).
    mode="direct" → every URL rewritten to an ABSOLUTE real CDN url with
                    the playlist's signed auth params copied on — used by
                    the download route (download manager / browser fetches
                    straight from the CDN, not proxied through us).
    """
    base = request.host_url.rstrip("/")

    def tok(raw: str) -> str:
        absolute = urljoin(playlist_url, raw.strip())
        absolute = inherit_auth_params(absolute, playlist_url)
        if mode == "direct":
            return absolute
        return f"{base}/api/pw/seg?u={b64e(absolute)}"

    out_lines = []
    for line in body.splitlines():
        t = line.strip()
        if not t:
            out_lines.append(line)
            continue
        if t.startswith("#"):
            if "URI=" in t:
                line = re.sub(
                    r'URI="([^"]+)"',
                    lambda m: f'URI="{tok(m.group(1))}"',
                    line,
                    flags=re.IGNORECASE,
                )
            out_lines.append(line)
            continue
        out_lines.append(tok(t))
    return "\n".join(out_lines) + "\n"


def fetch_upstream(url: str, range_header: str = None):
    """
    Retry + backoff:
      - 2xx and 4xx are FINAL (retrying an expired-signature 4xx wastes
        time and won't fix itself).
      - Only 5xx / connection-level errors (timeout, DNS, reset — transient
        CDN edge hiccups) are retried, with a small backoff.
    """
    headers = dict(UPSTREAM_HEADERS)
    if range_header:
        headers["Range"] = range_header

    last_exc = None
    for attempt in range(UPSTREAM_MAX_RETRIES + 1):
        try:
            r = requests.get(url, headers=headers, timeout=UPSTREAM_TIMEOUT, allow_redirects=True)
            if r.ok or (400 <= r.status_code < 500):
                return r  # final — retry se koi fayda nahi
            last_exc = requests.RequestException(f"Upstream {r.status_code}")
        except requests.RequestException as e:
            last_exc = e
        if attempt < UPSTREAM_MAX_RETRIES:
            time.sleep(0.3 * (attempt + 1))
    raise last_exc


# ═══════════════════════════════════════════════════════════════════════════
#  Routes
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/pw/stream")
def pw_stream():
    """GET /api/pw/stream?url=<m3u8> — proxied playlist for the browser player."""
    url = extract_url_param("url")
    if not url:
        return jsonify({"error": "URL missing"}), 400

    try:
        r = fetch_upstream(url)
    except requests.RequestException as e:
        return jsonify({"error": f"Upstream error: {e}"}), 502
    if not r.ok:
        return jsonify({"error": f"Upstream failed: {r.status_code}"}), r.status_code

    body = rewrite_m3u8(r.text, url, mode="proxy")
    return Response(
        body, 200,
        content_type="application/vnd.apple.mpegurl",
        headers=NO_STORE_HEADERS,
    )


@app.route("/api/pw/seg")
def pw_seg():
    """GET /api/pw/seg?u=<base64url token> — segment or nested/variant playlist relay."""
    token = request.args.get("u")
    if not token:
        return jsonify({"error": "Missing segment token"}), 400
    try:
        url = b64d(token)
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError("bad scheme")
    except Exception:
        return jsonify({"error": "Invalid segment token"}), 400

    try:
        r = fetch_upstream(url, request.headers.get("Range"))
    except requests.RequestException as e:
        return jsonify({"error": f"Upstream error: {e}"}), 502
    if not r.ok:
        return jsonify({"error": f"Upstream failed: {r.status_code}"}), r.status_code

    ctype = r.headers.get("content-type")
    if looks_like_m3u8(url, ctype):
        # Nested/variant playlist — rewrite it too.
        #
        # THIS is the exact spot that was causing "plays 3-5s then loops /
        # freezes forever" on live streams: for a master→child playlist
        # shape, THIS nested child playlist (not /api/pw/stream) is what
        # hls.js re-polls every few seconds to discover new segments as the
        # class progresses. Skipping no-store here lets an edge/browser
        # cache keep serving back the very first response — so hls.js kept
        # re-fetching the same short, early segment window forever. Always
        # setting no-store fixes it.
        body = rewrite_m3u8(r.text, url, mode="proxy")
        return Response(
            body, 200,
            content_type="application/vnd.apple.mpegurl",
            headers=NO_STORE_HEADERS,
        )

    # Binary media segment — relay as-is (Range/partial-content aware).
    headers = {
        "Content-Type": ctype or "video/mp2t",
        "Cache-Control": "public, max-age=30",
        "Accept-Ranges": "bytes",
    }
    if r.headers.get("content-range"):
        headers["Content-Range"] = r.headers["content-range"]
    status = 206 if r.status_code == 206 else 200
    return Response(r.content, status, headers=headers)


@app.route("/api/pw/download")
def pw_download():
    """GET /api/pw/download?url=<m3u8> — direct-CDN playlist for download managers (1DM etc.)."""
    url = extract_url_param("url")
    if not url:
        return jsonify({"error": "URL missing"}), 400

    try:
        r = fetch_upstream(url)
    except requests.RequestException as e:
        return jsonify({"error": f"Upstream error: {e}"}), 502
    if not r.ok:
        return jsonify({"error": f"Upstream failed: {r.status_code}"}), r.status_code

    body = rewrite_m3u8(r.text, url, mode="direct")
    return Response(body, 200, content_type="application/vnd.apple.mpegurl", headers=NO_STORE_HEADERS)


@app.route("/player")
def player_page():
    """GET /player?url=<m3u8> — the actual watchable page. `url` itself is
    read client-side (player.js) straight off window.location.search, so
    nothing server-side needs templating/escaping here."""
    return render_template("player.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, threaded=True)
