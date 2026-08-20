import { NextRequest, NextResponse } from "next/server";
import { fetchUpstream, rewriteM3U8, extractUrlParam } from "@/lib/hlsProxy";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pwlive/download?url=<m3u8-url>
 *
 * IMPORTANT: this route never downloads or saves anything itself — Vercel
 * serverless functions have no persistent disk and tight execution-time
 * limits, so they're the wrong place to "download a video". Instead this
 * returns a DOWNLOAD-FRIENDLY .m3u8 playlist: every segment / nested-
 * playlist URL is rewritten to the REAL, ABSOLUTE CDN URL (with the
 * playlist's signed auth params — Signature/Policy/Key-Pair-Id/etc. —
 * copied onto it), NOT proxied through this domain.
 *
 * That means:
 *   - Opening this URL directly in a browser plays the FULL playlist
 *     (all segments, properly connected/ordered) straight off the CDN.
 *   - Handing this same URL to a download manager (1DM, ADM, etc.) lets
 *     it fetch every segment directly from the CDN in parallel — full
 *     CDN speed, and zero load on our serverless functions.
 */
export async function GET(req: NextRequest) {
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
    const rewritten = rewriteM3U8(body, url, { mode: "direct" });

    return withCors(
      new NextResponse(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          // Signed CDN URLs expire — never let a stale playlist get cached.
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
