import { NextResponse } from "next/server";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";

/** GET /api — simple health/info route listing everything available. */
export async function GET() {
  return withCors(
    NextResponse.json({
      name: "PW Live Proxy API",
      status: "ok",
      endpoints: {
        player:
          "GET /api/pwlive/player?url=<m3u8-url> — proxied playlist for the browser player (CORS-safe, same-origin)",
        segment: "GET /api/pwlive/seg?u=<token> — internal, used by /api/pwlive/player's rewritten playlist",
        download:
          "GET /api/pwlive/download?url=<m3u8-url> — direct-CDN playlist for playing/downloading with a download manager (e.g. 1DM)",
        legacyPlaylist:
          "GET /api/live/<title>/playlist?url=<m3u8-url> — same as /api/pwlive/player, alternate path shape",
        playerPage: "GET /player?url=<m3u8-url> — the actual watchable web page",
      },
    })
  );
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}
