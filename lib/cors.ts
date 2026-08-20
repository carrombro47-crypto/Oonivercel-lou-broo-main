/**
 * lib/cors.ts — allow-all-origins CORS on every response (success + error).
 *
 * Ported from the reference Flask app's `add_cors_headers` (main.py,
 * `@flask_app.after_request`), which applies the same header set to every
 * response — success, error, and OPTIONS preflight alike. Kept as a single
 * shared helper here (instead of Flask's global after_request hook) since
 * every route already wraps its NextResponse in withCors(...).
 */
export function withCors<T extends Response>(res: T): T {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Access-Control-Expose-Headers", "*");
  res.headers.set("Access-Control-Max-Age", "86400");
  // hls.js reads segment/manifest fetch timing via the Resource Timing API
  // for its ABR (bitrate) logic — without this, cross-origin timing entries
  // come back zeroed-out, which is harmless but makes ABR decisions blind.
  // Same allow-all posture as the Access-Control-Allow-Origin above.
  res.headers.set("Timing-Allow-Origin", "*");
  return res;
}
