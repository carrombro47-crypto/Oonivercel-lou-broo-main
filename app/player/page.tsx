"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * /player?url=<m3u8-url>
 *
 * Deliberately plain — a native <video controls> element (default seek
 * bar, volume, fullscreen, everything, exactly as the browser gives it) +
 * hls.js for playback, plus exactly two small custom overlays:
 *
 *   - "● LIVE" badge, top-left — red left-border pill + blinking dot,
 *     shown only while the loaded playlist is actually live
 *     (no #EXT-X-ENDLIST).
 *   - "GO LIVE" button, top-right — shown only once the viewer has
 *     seeked/rewound more than ~15s behind the live edge. Tapping it jumps
 *     back to the live edge. Nothing here is forced — rewinding to watch
 *     from the start (or anywhere else) works completely normally, and the
 *     button disappears again once you're back at the live edge.
 */
function PlayerInner() {
  const searchParams = useSearchParams();
  const rawUrl = searchParams.get("url") || "";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<any>(null);

  const [isLive, setIsLive] = useState(false);
  const [showGoLive, setShowGoLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Load + attach the stream ────────────────────────────────────────
  useEffect(() => {
    if (!rawUrl) {
      setError("URL missing — ?url=<m3u8-link> lagakar aao.");
      setLoading(false);
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    const proxiedUrl = `/api/pwlive/player?url=${encodeURIComponent(rawUrl)}`;
    let cancelled = false;

    const onCanPlay = () => setLoading(false);
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);

    (async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari — native HLS support, no hls.js needed.
        video.src = proxiedUrl;
        setIsLive(true); // Safari's native player doesn't expose this easily; assume live.
        video.play().catch(() => {});
        return;
      }

      try {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;

        if (!Hls.isSupported()) {
          setError("Is browser mein HLS playback supported nahi hai.");
          setLoading(false);
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
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
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
    <div className="player-wrapper">
      {error ? (
        <div className="loading" style={{ color: "rgba(255,45,45,0.7)" }}>
          ✕ {error}
        </div>
      ) : (
        <>
          {loading && (
            <div className="loading">
              <div className="spinner" />
              Loading...
            </div>
          )}

          {isLive && (
            <div className="live-badge">
              <div className="live-dot" />
              <span className="live-text">LIVE</span>
            </div>
          )}

          {showGoLive && (
            <button className="go-live-btn" onClick={goLive}>
              ⏵ GO LIVE
            </button>
          )}

          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} controls playsInline autoPlay className="player-video" />
        </>
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
