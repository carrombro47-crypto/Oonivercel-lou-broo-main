import { NextRequest, NextResponse } from "next/server";
import { fetchUpstream, rewriteM3U8 } from "@/lib/hlsProxy";
import { withCors } from "@/lib/cors";

// Node.js runtime (not Edge) — we need Buffer for base64url tokens and a
// normal fetch/timeout setup; Node runtime is the right fit here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // live stream — never cache this route

/**
 * GET /api/pwlive/player?url=<m3u8-url>
 *
 * Fetches the given .m3u8, rewrites every segment / nested-playlist
 * reference to point back at THIS domain (/api/pwlive/seg?u=<token>), and
 * returns the rewritten playlist. This is what the browser's player page
 * (via hls.js) loads — proxying keeps everything same-origin (no CORS
 * issues) and never exposes the real upstream CDN URL to client JS.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    return withCors(NextResponse.json({ error: "URL missing" }, { status: 400 }));
  }

  try {
    const upstream = await fetchUpstream(url);
    if (!upstream.ok) {
      return withCors(
        NextResponse.json({ error: `Upstream failed: ${upstream.status}` }, { status: upstream.status })
      );
    }

    const body = await upstream.text();
    const origin = req.nextUrl.origin;
    const rewritten = rewriteM3U8(body, url, { mode: "proxy", origin });

    return withCors(
      new NextResponse(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      })
    );
  } catch (e: any) {
    return withCors(
      NextResponse.json({ error: `Upstream error: ${e?.message ?? String(e)}` }, { status: 502 })
    );
  }
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}
