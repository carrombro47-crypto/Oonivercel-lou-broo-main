import { NextRequest, NextResponse } from "next/server";
import { fetchUpstream, rewriteM3U8, extractUrlParam } from "@/lib/hlsProxy";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/live/<title>/playlist?url=<m3u8-url>
 *
 * Kept as requested, for the older `/api/live/<title>/playlist` URL
 * shape. The old (Flask + MongoDB) version looked `original_url` up in a
 * database by `title`. That whole database/login/generate-link system has
 * been removed — this app is now fully stateless — so `title` here is
 * just a human-friendly path label (not looked up anywhere); the actual
 * source is always the `?url=` query param, same as /api/pwlive/player.
 * Behaviour is identical to /api/pwlive/player (proxy mode).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { title: string } }
) {
  const url = extractUrlParam(req);

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
