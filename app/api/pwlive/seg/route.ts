import { NextRequest, NextResponse } from "next/server";
import { fetchUpstream, rewriteM3U8, b64urlDecode, looksLikeM3U8 } from "@/lib/hlsProxy";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pwlive/seg?u=<base64url-encoded-absolute-url>
 *
 * Fetches one segment (.ts/.m4s) OR a nested/variant playlist referenced
 * by /api/pwlive/player's rewritten output, and relays it back. Nested
 * playlists get rewritten again (recursively, same "proxy" mode) so hls.js
 * never has to talk to the real CDN directly.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("u");
  if (!token) {
    return withCors(NextResponse.json({ error: "Missing segment token" }, { status: 400 }));
  }

  let url: string;
  try {
    url = b64urlDecode(token);
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("bad scheme");
    }
  } catch {
    return withCors(NextResponse.json({ error: "Invalid segment token" }, { status: 400 }));
  }

  try {
    const range = req.headers.get("range");
    const upstream = await fetchUpstream(url, range);
    if (!upstream.ok) {
      return withCors(
        NextResponse.json({ error: `Upstream failed: ${upstream.status}` }, { status: upstream.status })
      );
    }

    const ctype = upstream.headers.get("content-type");
    if (looksLikeM3U8(url, ctype)) {
      // Nested/variant playlist — rewrite it too.
      const body = await upstream.text();
      const origin = req.nextUrl.origin;
      const rewritten = rewriteM3U8(body, url, { mode: "proxy", origin });
      return withCors(
        new NextResponse(rewritten, {
          status: 200,
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        })
      );
    }

    // Binary media segment — relay as-is (Range/partial-content aware).
    const buf = await upstream.arrayBuffer();
    const headers: Record<string, string> = {
      "Content-Type": ctype || "video/mp2t",
      "Cache-Control": "public, max-age=30",
      "Accept-Ranges": "bytes",
    };
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers["Content-Range"] = contentRange;

    return withCors(
      new NextResponse(buf, {
        status: upstream.status === 206 ? 206 : 200,
        headers,
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
