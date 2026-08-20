"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * /player?url=<m3u8-url>
 *
 * Deliberately plain — a native <video controls> element (default seek
 * bar, volume, fullscreen, everything) + hls.js for playback, plus exactly
 * two small custom overlays:
 *   - "● LIVE" badge, top-left — only shown while the loaded playlist is
 *     actually a live (no #EXT-X-ENDLIST) stream.
 *   - "GO LIVE" button, top-right — only shown once the viewer has seeked
 *     more than ~15s behind the live edge. Tapping it jumps back to the
 *     live edge. Never forces anyone back to live — seeking/rewinding to
 *     watch from the start works completely normally.
 */
function PlayerInner() {
  const searchParams = useSearchParams();
  const rawUrl = searchParams.get("url") || "";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<any>(null);

  const [isLive, setIsLive] = useState(false);
  const [showGoLive, setShowGoLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Load + attach the stream ────────────────────────────────────────
  useEffect(() => {
    if (!rawUrl) {
      setError("URL missing — ?url=<m3u8-link> lagakar aao.");
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    const proxiedUrl = `/api/pwlive/player?url=${encodeURIComponent(rawUrl)}`;
    let cancelled = false;

    (async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari — native HLS support, no hls.js needed.
        video.src = proxiedUrl;
        setIsLive(true); // Safari native player doesn't expose this easily; assume live.
        video.play().catch(() => {});
        return;
      }

      try {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;

        if (!Hls.isSupported()) {
          setError("Is browser mein HLS playback supported nahi hai.");
          return;
        }

        const hls = new Hls({
          lowLatencyMode: true,
          liveSyncDurationCount: 3,
          backBufferLength: 90,
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.LEVEL_LOADED, (_evt: any, data: any) => {
          setIsLive(!!data?.details?.live);
        });

        hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
          if (!data?.fatal) return;
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              setError("Playback error — page ko refresh karo.");
          }
        });

        hls.loadSource(proxiedUrl);
        hls.attachMedia(video);
        video.play().catch(() => {});
      } catch {
        setError("Player load nahi ho paya — page ko refresh karo.");
      }
    })();

    return () => {
      cancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [rawUrl]);

  // ── "Go Live" visibility — only while actually behind the live edge ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isLive) {
      setShowGoLive(false);
      return;
    }

    const checkLiveEdge = () => {
      const seekable = video.seekable;
      if (seekable.length === 0) return;
      const liveEdge = seekable.end(seekable.length - 1);
      const behind = liveEdge - video.currentTime;
      setShowGoLive(behind > 15); // 15s+ peeche ho tabhi button dikhao
    };

    video.addEventListener("timeupdate", checkLiveEdge);
    video.addEventListener("seeked", checkLiveEdge);
    checkLiveEdge();
    return () => {
      video.removeEventListener("timeupdate", checkLiveEdge);
      video.removeEventListener("seeked", checkLiveEdge);
    };
  }, [isLive]);

  const goLive = () => {
    const video = videoRef.current;
    if (!video) return;
    const seekable = video.seekable;
    if (seekable.length === 0) return;
    video.currentTime = seekable.end(seekable.length - 1);
    video.play().catch(() => {});
  };

  return (
    <div style={styles.wrap}>
      {error ? (
        <div style={styles.errorBox}>{error}</div>
      ) : (
        <div style={styles.playerBox}>
          {isLive && (
            <div style={styles.liveBadge}>
              <span style={styles.liveDot} />
              LIVE
            </div>
          )}
          {showGoLive && (
            <button style={styles.goLiveBtn} onClick={goLive}>
              ⏵ GO LIVE
            </button>
          )}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} controls playsInline autoPlay style={styles.video} />
        </div>
      )}
    </div>
  );
}

export default function PlayerPage() {
  return (
    <Suspense fallback={null}>
      <PlayerInner />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    width: "100vw",
    height: "100vh",
    background: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  playerBox: {
    position: "relative",
    width: "100%",
    height: "100%",
    background: "#000",
  },
  video: {
    width: "100%",
    height: "100%",
    background: "#000",
    display: "block",
  },
  liveBadge: {
    position: "absolute",
    top: 12,
    left: 12,
    zIndex: 5,
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    padding: "5px 10px",
    borderRadius: 6,
    letterSpacing: 0.5,
    pointerEvents: "none",
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#ff2d2d",
  },
  goLiveBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 5,
    background: "#ff2d2d",
    color: "#fff",
    border: "none",
    padding: "7px 14px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  errorBox: {
    color: "#fff",
    fontSize: 14,
    padding: 24,
    textAlign: "center",
  },
};
