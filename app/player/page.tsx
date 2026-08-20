"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * /player?url=<m3u8-url>
 *
 * Native <video controls> element (default seek bar, volume, fullscreen) +
 * hls.js for playback, plus exactly three small custom overlays:
 *   - "● LIVE" badge + elapsed timer, top-left — only shown while the
 *     loaded playlist is actually live (no #EXT-X-ENDLIST).
 *   - "GO LIVE" button, right side (just above the native control bar) —
 *     only shown once the viewer has fallen behind the live edge. Tapping
 *     it jumps back to live. Hidden automatically once back at the edge.
 *     Never forces anyone back to live — seeking/rewinding still works.
 *   - Fullscreen button forces landscape orientation on entering
 *     fullscreen (best-effort — not every browser/OS allows locking it).
 */
function PlayerInner() {
  const searchParams = useSearchParams();
  const rawUrl = searchParams.get("url") || "";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<any>(null);

  // Elapsed-time interpolation, same approach as the reference player:
  // hls.js gives us the real `totalduration` from the m3u8 on every
  // LEVEL_LOADED; between refreshes we interpolate off the wall clock so
  // the counter ticks smoothly instead of jumping every few seconds.
  const liveDurationBaseRef = useRef<number | null>(null);
  const liveDurationBaseAtRef = useRef<number>(0);
  const manifestEverLoadedRef = useRef(false);

  const [isLive, setIsLive] = useState(false);
  const [showGoLive, setShowGoLive] = useState(false);
  const [elapsedText, setElapsedText] = useState("00:00");
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
        // Safari — native HLS support, no hls.js needed. Safari's own
        // engine handles live-manifest refresh/retry internally.
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
          enableWorker: true,
          // ── Retry tuning — this is the actual fix for "plays 3-5s then
          // stalls forever" ──
          // hls.js's DEFAULT manifestLoadingMaxRetry is just 1. A live
          // proxy route on a serverless function occasionally has one slow
          // cold-start response; with only 1 retry, hls.js gave up
          // re-polling the live manifest completely after that single
          // hiccup — so playback froze right after whatever few seconds
          // were already buffered, and never advanced again even though
          // the class was still live. Raising these (matching the
          // reference player's config) makes hls.js tolerate transient
          // proxy/network blips and keep polling for new segments.
          manifestLoadingMaxRetry: 6,
          levelLoadingMaxRetry: 6,
          fragLoadingMaxRetry: 6,
          manifestLoadingRetryDelay: 1000,
          levelLoadingRetryDelay: 1000,
          fragLoadingRetryDelay: 1000,
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          manifestEverLoadedRef.current = true;
        });

        hls.on(Hls.Events.LEVEL_LOADED, (_evt: any, data: any) => {
          setIsLive(!!data?.details?.live);
          if (data?.details && typeof data.details.totalduration === "number") {
            liveDurationBaseRef.current = data.details.totalduration;
            liveDurationBaseAtRef.current = Date.now();
          }
        });

        hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
          if (!data?.fatal) return;
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR: {
              const neverStarted =
                data.details === "manifestLoadError" ||
                data.details === "manifestLoadTimeOut" ||
                data.details === "manifestParsingError";
              if (!manifestEverLoadedRef.current && neverStarted) {
                setError("Stream load nahi ho paya — link expire ho gaya hoga ya server down hai. Thodi der baad refresh karo.");
                return;
              }
              if (!manifestEverLoadedRef.current) return; // let hls.js's own retry policy handle it
              // Playback had already started once — a network error near
              // the live edge usually just means a transient hiccup (or
              // the class ending). Keep polling instead of giving up.
              hls.startLoad();
              break;
            }
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

  // ── Elapsed timer + "Go Live" visibility — one lightweight ticker ────
  useEffect(() => {
    if (!isLive) {
      setShowGoLive(false);
      return;
    }
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;

      if (liveDurationBaseRef.current !== null) {
        const elapsed =
          liveDurationBaseRef.current + (Date.now() - liveDurationBaseAtRef.current) / 1000;
        setElapsedText(fmt(elapsed));
      }

      const hls = hlsRef.current;
      let behind = 0;
      if (hls && typeof hls.liveSyncPosition === "number") {
        behind = hls.liveSyncPosition - video.currentTime;
      } else if (video.seekable.length) {
        behind = video.seekable.end(video.seekable.length - 1) - video.currentTime;
      }
      setShowGoLive(behind > 8); // 8s+ peeche ho tabhi "Go Live" dikhao
    }, 500);
    return () => clearInterval(id);
  }, [isLive]);

  const goLive = () => {
    const video = videoRef.current;
    if (!video) return;
    const hls = hlsRef.current;
    let edge: number | null = null;
    if (hls && typeof hls.liveSyncPosition === "number") edge = hls.liveSyncPosition;
    else if (video.seekable.length) edge = video.seekable.end(video.seekable.length - 1);
    if (edge != null) {
      video.currentTime = edge;
      video.play().catch(() => {});
    }
  };

  // ── Fullscreen → force landscape (best-effort; iOS Safari & a few
  // browsers don't support orientation lock — fails silently there, the
  // fullscreen itself still works fine) ──
  const goFullscreen = async () => {
    const el = shellRef.current;
    if (!el) return;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
      else if ((videoRef.current as any)?.webkitEnterFullscreen) {
        (videoRef.current as any).webkitEnterFullscreen(); // iOS Safari video-only fullscreen
        return;
      }
      const orientation: any = (screen as any).orientation;
      if (orientation?.lock) {
        await orientation.lock("landscape").catch(() => {});
      }
    } catch {
      /* fullscreen/orientation not available — ignore, native controls still work */
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) {
        const orientation: any = (screen as any).orientation;
        if (orientation?.unlock) {
          try {
            orientation.unlock();
          } catch {}
        }
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  return (
    <div style={styles.wrap}>
      {error ? (
        <div style={styles.errorBox}>{error}</div>
      ) : (
        <div style={styles.playerBox} ref={shellRef}>
          <style>{`
            @keyframes pwLiveBlink { 50% { opacity: .25; } }
          `}</style>

          {isLive && (
            <div style={styles.liveStack}>
              <div style={styles.liveBadge}>
                <span style={styles.liveDot} />
                LIVE
              </div>
              <div style={styles.elapsedText}>{elapsedText}</div>
            </div>
          )}

          {showGoLive && (
            <button style={styles.goLiveBtn} onClick={goLive}>
              ● GO LIVE
            </button>
          )}

          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} controls playsInline autoPlay style={styles.video} />

          {/* Tiny extra fullscreen tap-target, top-right, that also locks
              landscape — the native control bar's own fullscreen button
              can't be hooked into, so this sits above it as an easy target. */}
          <button style={styles.fsBtn} onClick={goFullscreen} title="Fullscreen">
            ⛶
          </button>
        </div>
      )}
    </div>
  );
}

function fmt(totalSeconds: number): string {
  const s = Math.floor(totalSeconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
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
  liveStack: {
    position: "absolute",
    top: 12,
    left: 12,
    zIndex: 5,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
    pointerEvents: "none",
  },
  liveBadge: {
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
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#ff2d2d",
    boxShadow: "0 0 6px #ff2d2d",
    animation: "pwLiveBlink 1s infinite",
  },
  elapsedText: {
    background: "rgba(0,0,0,0.55)",
    color: "#d1d5db",
    fontSize: 11.5,
    fontWeight: 600,
    padding: "3px 9px",
    borderRadius: 6,
  },
  goLiveBtn: {
    position: "absolute",
    right: 12,
    bottom: 52, // sits just above the native <video controls> bar
    zIndex: 5,
    background: "#ff2d2d",
    color: "#fff",
    border: "none",
    padding: "6px 13px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(255,45,45,.4)",
  },
  fsBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 5,
    width: 32,
    height: 32,
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,.2)",
    borderRadius: 8,
    fontSize: 15,
    cursor: "pointer",
  },
  errorBox: {
    color: "#fff",
    fontSize: 14,
    padding: 24,
    textAlign: "center",
  },
};
