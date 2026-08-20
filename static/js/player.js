(function () {
    "use strict";

    // ── Elements ─────────────────────────────────────────────────────────
    var video = document.getElementById("video");
    var shell = document.getElementById("shell");
    var statusBox = document.getElementById("status");
    var statusText = document.getElementById("statusText");
    var spinner = document.getElementById("spinner");
    var liveStack = document.getElementById("liveStack");
    var liveElapsed = document.getElementById("liveElapsed");
    var goLiveBtn = document.getElementById("goLiveBtn");
    var fsBtn = document.getElementById("fsBtn");

    // ── Read ?url=<m3u8> straight from THIS page's own query string ────────
    var rawUrl = new URLSearchParams(window.location.search).get("url") || "";

    var hls = null;
    var isLive = false;
    var manifestEverLoaded = false;

    // Elapsed-time interpolation: hls.js gives the real `totalduration`
    // from the m3u8 on every LEVEL_LOADED; between refreshes we interpolate
    // off the wall clock so the counter ticks smoothly instead of jumping.
    var liveDurationBase = null;
    var liveDurationBaseAt = 0;

    function showLoading(msg) {
        statusBox.style.display = "flex";
        statusBox.className = "status";
        spinner.style.display = "block";
        statusText.textContent = msg;
    }
    function showError(msg) {
        statusBox.style.display = "flex";
        statusBox.className = "status error";
        spinner.style.display = "none";
        statusText.textContent = "✕ " + msg;
    }
    function hideStatus() {
        statusBox.style.display = "none";
    }

    function fmt(totalSeconds) {
        var s = Math.floor(totalSeconds || 0);
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    }

    // Browsers usually block unmuted autoplay without prior interaction.
    // Try unmuted first (best experience); fall back to muted autoplay so
    // playback definitely starts (user's first tap on the video unmutes).
    function attemptAutoplay() {
        video.play().catch(function () {
            video.muted = true;
            video.play().catch(function () {});
        });
    }

    if (!rawUrl) {
        showError("URL missing — ?url=<m3u8-link> lagakar aao.");
        return;
    }

    var STREAM_URL = "/api/pw/stream?url=" + encodeURIComponent(rawUrl);

    // ── hls.js setup ─────────────────────────────────────────────────────
    if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
            lowLatencyMode: true,
            liveSyncDurationCount: 3,
            backBufferLength: 90,
            enableWorker: true,
            // ── Retry tuning — the actual fix for "plays 3-5s then stalls
            // forever" ──
            // hls.js's DEFAULT manifestLoadingMaxRetry is just 1. A proxy
            // route occasionally has one slow response (server cold
            // start / transient network blip); with only 1 retry, hls.js
            // gave up re-polling the live manifest completely after that
            // single hiccup, so playback froze right after whatever was
            // already buffered and never advanced again even though the
            // class was still live. Raising these makes hls.js tolerate
            // transient blips and keep polling for new segments.
            manifestLoadingMaxRetry: 6,
            levelLoadingMaxRetry: 6,
            fragLoadingMaxRetry: 6,
            manifestLoadingRetryDelay: 1000,
            levelLoadingRetryDelay: 1000,
            fragLoadingRetryDelay: 1000,
        });

        hls.on(Hls.Events.MANIFEST_PARSED, function () {
            manifestEverLoaded = true;
            attemptAutoplay();
        });

        hls.on(Hls.Events.LEVEL_LOADED, function (_evt, data) {
            isLive = !!(data && data.details && data.details.live);
            liveStack.classList.toggle("show", isLive);
            if (data && data.details && typeof data.details.totalduration === "number") {
                liveDurationBase = data.details.totalduration;
                liveDurationBaseAt = Date.now();
            }
        });

        hls.on(Hls.Events.ERROR, function (_evt, data) {
            if (!data || !data.fatal) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                var neverStarted =
                    data.details === "manifestLoadError" ||
                    data.details === "manifestLoadTimeOut" ||
                    data.details === "manifestParsingError";
                if (!manifestEverLoaded && neverStarted) {
                    showError("Stream load nahi ho paya — link expire ho gaya hoga ya server down hai. Thodi der baad refresh karo.");
                    return;
                }
                if (!manifestEverLoaded) return; // let hls.js's own retry policy handle it
                // Playback had already started once — a network error near
                // the live edge is usually just a transient hiccup. Keep
                // polling instead of giving up.
                hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
            } else {
                showError("Playback error — page ko refresh karo.");
            }
        });

        hls.loadSource(STREAM_URL);
        hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari — native HLS support, no hls.js needed.
        video.src = STREAM_URL;
        isLive = true;
        liveStack.classList.add("show");
        video.addEventListener("loadedmetadata", function () {
            manifestEverLoaded = true;
            attemptAutoplay();
        });
    } else {
        showError("Is browser mein HLS playback supported nahi hai.");
    }

    // ── Video events ─────────────────────────────────────────────────────
    video.addEventListener("playing", function () {
        hideStatus();
    });
    video.addEventListener("waiting", function () {
        if (manifestEverLoaded) showLoading("Buffering...");
    });
    video.addEventListener("error", function () {
        if (video.getAttribute("src")) showError("Video error — please refresh.");
    });

    // Tap-to-play/pause directly on the video.
    video.addEventListener("click", function () {
        video.muted = false;
        if (video.paused) video.play().catch(function () {});
        else video.pause();
    });

    // ── Elapsed timer + "Go Live" visibility ────────────────────────────
    setInterval(function () {
        if (!isLive) return;

        if (liveDurationBase !== null) {
            var elapsed = liveDurationBase + (Date.now() - liveDurationBaseAt) / 1000;
            liveElapsed.textContent = fmt(elapsed);
        }

        var behind = 0;
        if (hls && typeof hls.liveSyncPosition === "number") {
            behind = hls.liveSyncPosition - video.currentTime;
        } else if (video.seekable.length) {
            behind = video.seekable.end(video.seekable.length - 1) - video.currentTime;
        }
        goLiveBtn.classList.toggle("show", behind > 8); // 8s+ peeche ho tabhi dikhao
    }, 500);

    goLiveBtn.addEventListener("click", function () {
        var edge = null;
        if (hls && typeof hls.liveSyncPosition === "number") edge = hls.liveSyncPosition;
        else if (video.seekable.length) edge = video.seekable.end(video.seekable.length - 1);
        if (edge != null) {
            video.currentTime = edge;
            video.play().catch(function () {});
        }
    });

    // ── Fullscreen → force landscape (best-effort; iOS Safari & some
    // browsers don't support orientation lock — fails silently there, the
    // fullscreen itself still works fine) ──
    fsBtn.addEventListener("click", function () {
        var req = shell.requestFullscreen || shell.webkitRequestFullscreen;
        var p = req ? req.call(shell) : null;
        var lockLandscape = function () {
            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock("landscape").catch(function () {});
            }
        };
        if (p && p.then) p.then(lockLandscape).catch(function () {});
        else if (req) lockLandscape();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS Safari
    });

    document.addEventListener("fullscreenchange", function () {
        if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) {
            try { screen.orientation.unlock(); } catch (e) {}
        }
    });
})();
