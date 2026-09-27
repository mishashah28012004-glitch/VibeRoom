import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket';

// ── URL → video ID ────────────────────────────────────────────────────────────
function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();
  // bare 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  try {
    const p = new URL(url);
    const h = p.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') {
      // e.g. https://youtu.be/IYCADK9ehXg?si=...
      return p.pathname.split('/').filter(Boolean)[0] || null;
    }
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(h)) {
      if (p.pathname === '/watch') return p.searchParams.get('v');
      const m = p.pathname.match(/^\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
      return m ? m[2] : null;
    }
  } catch { return null; }
  return null;
}

// ── YouTube IFrame API bootstrap ──────────────────────────────────────────────
// These live at module scope so they survive component re-mounts.
let ytApiReady = false;
const ytReadyCallbacks = [];

if (!window.__ytApiBootstrapped) {
  window.__ytApiBootstrapped = true;
  window.onYouTubeIframeAPIReady = () => {
    ytApiReady = true;
    ytReadyCallbacks.forEach(fn => fn());
    ytReadyCallbacks.length = 0;
  };
}

function whenYTReady(fn) {
  if (ytApiReady) {
    // already ready — but defer one tick so the DOM element is mounted
    setTimeout(fn, 0);
  } else {
    ytReadyCallbacks.push(fn);
  }
}

// ── component ─────────────────────────────────────────────────────────────────
const PLAYER_EL_ID = 'yt-player-container';

function formatTimestamp(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function YoutubePlayer({ videoState, role, onStateChange }) {
  const playerRef    = useRef(null);   // YT.Player instance
  const isReady      = useRef(false);  // player onReady fired
  const ignoreEvents = useRef(false);  // suppress our own state-change echoes
  const roleRef      = useRef(role);
  const pendingState = useRef(null);   // videoState that arrived before player ready
  const lastSyncRef  = useRef(null);
  const activeVideoId = useRef(videoState?.videoId || '');
  const viewerProgressAnchor = useRef({ videoId: '', time: 0, at: 0, playing: false });

  const [urlInput,   setUrlInput]   = useState('');
  const [loadError,  setLoadError]  = useState(null);
  const [viewerProgress, setViewerProgress] = useState({ videoId: '', time: 0, duration: 0 });

  useEffect(() => { roleRef.current = role; }, [role]);
  useEffect(() => { activeVideoId.current = videoState?.videoId || ''; }, [videoState?.videoId]);

  const canControl = role === 'host' || role === 'moderator';
  const visibleLoadError = loadError?.videoId === (videoState?.videoId || '') ? loadError.message : '';
  const progressMatchesVideo = viewerProgress.videoId === videoState?.videoId;
  const progressTime = progressMatchesVideo ? viewerProgress.time : Math.max(0, Number(videoState?.time) || 0);
  const progressDuration = progressMatchesVideo ? viewerProgress.duration : 0;
  const progressPercent = progressDuration > 0
    ? Math.min(100, progressTime / progressDuration * 100)
    : 0;

  function reportLoadError(message) {
    setLoadError({ message, videoId: activeVideoId.current });
  }

  function handlePlayerStateChange(event) {
    const p = playerRef.current;
    if (!p) return;

    if (!['host', 'moderator'].includes(roleRef.current)) {
      if (pendingState.current && event.data !== window.YT.PlayerState.BUFFERING) {
        const pending = pendingState.current;
        pendingState.current = null;
        applyVideoState(p, pending, ignoreEvents, lastSyncRef);
      }
      return;
    }
    if (ignoreEvents.current) return;

    const t = p.getCurrentTime() || 0;
    const videoId = p.getVideoData?.()?.video_id;
    if (!videoId) return;

    if (event.data === window.YT.PlayerState.PLAYING) {
      if (lastSyncRef.current?.playing) return;
      socket.emit('playback:play', { time: t });
      lastSyncRef.current = { time: t, at: Date.now(), playing: true };
    } else if (event.data === window.YT.PlayerState.PAUSED) {
      if (lastSyncRef.current && !lastSyncRef.current.playing) return;
      socket.emit('playback:pause', { time: t });
      lastSyncRef.current = { time: t, at: Date.now(), playing: false };
    }
  }

  // ── inject YT IFrame API script once ───────────────────────────────────────
  useEffect(() => {
    if (!document.getElementById('yt-api-script')) {
      const s    = document.createElement('script');
      s.id       = 'yt-api-script';
      s.src      = 'https://www.youtube.com/iframe_api';
      s.async    = true;
      document.head.appendChild(s);
    }
  }, []);

  // ── create YT.Player after API is ready ────────────────────────────────────
  useEffect(() => {
    // FIX: pass the element ID string, not the DOM ref.
    // The ref may still be null when onYTReady fires if the API was already
    // loaded before this component mounted. Using the ID lets YouTube find
    // the element itself after the deferred tick.
    whenYTReady(() => {
      if (playerRef.current) return; // already created (StrictMode double-invoke)

      playerRef.current = new window.YT.Player(PLAYER_EL_ID, {
        height: '100%',
        width:  '100%',
        playerVars: {
          autoplay: 0,
          controls: canControl ? 1 : 0,
          disablekb: canControl ? 0 : 1,
          rel: 0,
          playsinline: 1
        },
        events: {
          onReady() {
            isReady.current = true;
            // apply any videoState that arrived before the player was ready
            if (pendingState.current) {
              applyVideoState(playerRef.current, pendingState.current, ignoreEvents, lastSyncRef);
              pendingState.current = null;
            }
          },
          onStateChange: handlePlayerStateChange,
          onError(e) {
            console.error('[YT] error code:', e.data);
            const msgs = {
              2:  'Invalid video ID.',
              5:  'HTML5 player error.',
              100:'Video not found or private.',
              101:'Video cannot be embedded.',
              150:'Video cannot be embedded.',
            };
            reportLoadError(msgs[e.data] || `Player error (code ${e.data})`);
          },
        },
      });
    });

    return () => {
      try { playerRef.current?.destroy(); } catch {}
      playerRef.current = null;
      isReady.current   = false;
    };
  }, [canControl]);

  // ── apply incoming videoState (socket sync or initial load) ────────────────
  useEffect(() => {
    if (!videoState?.videoId) return;

    if (!isReady.current || !playerRef.current) {
      pendingState.current = videoState; // apply once player is ready
      return;
    }
    if (!canControl && playerRef.current.getPlayerState() === window.YT.PlayerState.BUFFERING) {
      pendingState.current = videoState;
    }
    applyVideoState(playerRef.current, videoState, ignoreEvents, lastSyncRef);
  }, [canControl, videoState]);

  useEffect(() => {
    viewerProgressAnchor.current = {
      videoId: videoState?.videoId || '',
      time: Math.max(0, Number(videoState?.time) || 0),
      at: Date.now(),
      playing: !!videoState?.playing
    };
  }, [videoState?.videoId, videoState?.playing, videoState?.time]);

  useEffect(() => {
    if (canControl) return;

    const id = setInterval(() => {
      const anchor = viewerProgressAnchor.current;
      if (!anchor.videoId) return;

      const player = playerRef.current;
      const loadedVideoId = isReady.current ? player?.getVideoData?.()?.video_id : undefined;
      const duration = isReady.current && loadedVideoId === anchor.videoId
        ? Math.max(0, Number(player.getDuration?.()) || 0)
        : 0;
      const time = anchor.time + (anchor.playing ? (Date.now() - anchor.at) / 1000 : 0);

      setViewerProgress(current => current.videoId === anchor.videoId
        && Math.abs(current.time - time) < 0.2
        && current.duration === duration
        ? current
        : { videoId: anchor.videoId, time, duration });
    }, 250);

    return () => clearInterval(id);
  }, [canControl]);

  // ── host/mod: Load button ──────────────────────────────────────────────────
  function loadVideo() {
    if (!canControl) return;
    setLoadError(null);
    const videoId = extractVideoId(urlInput);
    if (!videoId) {
      reportLoadError('Could not extract a video ID from that URL. Try pasting the full YouTube link.');
      return;
    }
    if (!isReady.current || !playerRef.current) {
      reportLoadError('Player is not ready yet. Wait a moment and try again.');
      return;
    }

    // FIX: use loadVideoById (not cueVideoById) so the video is immediately
    // visible in the player iframe, not just queued invisibly.
    ignoreEvents.current = true;
    setTimeout(() => { ignoreEvents.current = false; }, 1500);

    playerRef.current.loadVideoById({ videoId, startSeconds: 0 });
    activeVideoId.current = videoId;
    lastSyncRef.current = { time: 0, at: Date.now(), playing: false };

    // broadcast to all viewers
    socket.emit('playback:changeVideo', { videoId, title: videoId });
    onStateChange?.({ videoId, playing: false, time: 0 });

    localStorage.setItem('watchVideo', urlInput.trim());
    setUrlInput('');
  }

  // ── host/mod: Play / Pause button ─────────────────────────────────────────
  function togglePlay() {
    if (!canControl || !isReady.current || !playerRef.current) return;
    const state = playerRef.current.getPlayerState();
    if (state === window.YT.PlayerState.PLAYING) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  }

  // ── host/mod: periodic sync broadcast every 3 s ────────────────────────────
  useEffect(() => {
    if (!canControl) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!isReady.current || !p) return;
      const data = p.getVideoData?.();
      if (!data?.video_id) return;
      const playerState = p.getPlayerState();
      if (![window.YT.PlayerState.PLAYING, window.YT.PlayerState.PAUSED].includes(playerState)) return;
      const time = p.getCurrentTime() || 0;
      const now = Date.now();
      const previous = lastSyncRef.current;
      if (previous) {
        const expected = previous.time + (previous.playing ? (now - previous.at) / 1000 : 0);
        if (Math.abs(time - expected) > 1.5) socket.emit('playback:seek', { time });
      }

      socket.emit('video-state', {
        videoId: data.video_id,
        title:   '',
        time,
        playing: playerState === window.YT.PlayerState.PLAYING,
      });
      lastSyncRef.current = { time, at: now, playing: playerState === window.YT.PlayerState.PLAYING };
    }, 3000);
    return () => clearInterval(id);
  }, [canControl]);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="player-section">
      <div className="video-controls">
        {canControl && (
          <>
          <input
            type="text"
            placeholder="YouTube URL or video ID"
            value={urlInput}
            onChange={e => { setUrlInput(e.target.value); setLoadError(null); }}
            onKeyDown={e => e.key === 'Enter' && loadVideo()}
            className="video-url-input"
          />
          <button className="btn primary"   onClick={loadVideo}>Load</button>
          </>
        )}
        <button className="btn secondary" onClick={togglePlay} disabled={!canControl}>Play / Pause</button>
      </div>

      {visibleLoadError && (
        <p style={{ color: 'var(--danger)', fontSize: '0.82rem', padding: '4px 2px' }}>
          ⚠ {visibleLoadError}
        </p>
      )}

      {/* FIX: use a stable id= attribute so YT.Player can find the element */}
      <div className="player-wrapper" style={{ pointerEvents: canControl ? 'auto' : 'none' }}>
        <div id={PLAYER_EL_ID} />
      </div>

      {!canControl && videoState?.videoId && (
        <div className="viewer-progress">
          <span className="viewer-progress-time">{formatTimestamp(progressTime)}</span>
          <div
            className="viewer-progress-track"
            role="progressbar"
            aria-label="Video playback progress"
            aria-valuemin={0}
            aria-valuemax={progressDuration}
            aria-valuenow={progressTime}
          >
            <div className="viewer-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <span className="viewer-progress-time">
            {progressDuration > 0 ? formatTimestamp(progressDuration) : '--:--'}
          </span>
        </div>
      )}
    </div>
  );
}

// ── helper: apply a videoState object to a ready YT.Player ───────────────────
function applyVideoState(player, videoState, ignoreRef, syncRef) {
  if (!player || !videoState?.videoId) return;

  ignoreRef.current = true;
  setTimeout(() => { ignoreRef.current = false; }, 1500);

  const currentId = player.getVideoData?.()?.video_id;

  if (currentId !== videoState.videoId) {
    syncRef.current = {
      time: videoState.time || 0,
      at: Date.now(),
      playing: !!videoState.playing
    };
    // different video
    if (videoState.playing) {
      player.loadVideoById({ videoId: videoState.videoId, startSeconds: videoState.time || 0 });
    } else {
      // cueVideoById is fine here for viewers — they see the thumbnail
      // and can click play; the host's periodic sync will keep them aligned
      player.cueVideoById({ videoId: videoState.videoId, startSeconds: videoState.time || 0 });
    }
    return;
  }

  // same video — sync position + play/pause
  try {
    const playerState = player.getPlayerState();
    const cur = player.getCurrentTime() || 0;
    const targetTime = Math.max(0, Number(videoState.time) || 0);

    if (!videoState.playing) {
      if (playerState !== window.YT.PlayerState.PAUSED) player.pauseVideo();
      if (Math.abs(cur - targetTime) > 0.05) player.seekTo(targetTime, true);
    } else if (playerState === window.YT.PlayerState.BUFFERING) {
      syncRef.current = { time: targetTime, at: Date.now(), playing: true };
      return;
    } else {
      if (Math.abs(cur - targetTime) > 2) player.seekTo(targetTime, true);
      if (playerState !== window.YT.PlayerState.PLAYING) player.playVideo();
    }
    syncRef.current = {
      time: targetTime,
      at: Date.now(),
      playing: !!videoState.playing
    };
  } catch {}
}
