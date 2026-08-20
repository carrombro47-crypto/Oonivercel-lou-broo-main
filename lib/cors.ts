/**
 * lib/cors.ts — allow-all-origins CORS on every response (success + error).
 */
export function withCors<T extends Response>(res: T): T {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Access-Control-Expose-Headers", "*");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}
