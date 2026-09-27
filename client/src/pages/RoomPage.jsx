import { useEffect, useState } from 'react';
import { socket } from '../socket';
import YoutubePlayer    from '../components/YoutubePlayer';
import Chat             from '../components/Chat';
import ParticipantsList from '../components/ParticipantsList';
import RequestPanel     from '../components/RequestPanel';

export default function RoomPage({ roomCode, role: initialRole, userId, name, token, initialState, onLeave }) {
  const [role,         setRole]         = useState(initialRole);
  const [status,       setStatus]       = useState(`Joining "${roomCode}"…`);
  const [participants, setParticipants] = useState([]);
  const [removed,      setRemoved]      = useState(false);
  const [copied,       setCopied]       = useState(false);
  const [messages,     setMessages]     = useState([]);
  const [videoState, setVideoState] = useState(
    initialState?.video_id
      ? { videoId: initialState.video_id, playing: !!initialState.playing, time: Number(initialState.playback_time) || 0 }
      : null
  );

  // ── connect socket ──────────────────────────────────────────────────────────
  useEffect(() => {
    // FIX: emit join-room inside the 'connect' event, not synchronously after
    // connect(). This guarantees the socket is actually connected before we
    // send join-room, and also handles automatic reconnections correctly.
    function onConnect() {
      socket.emit('join-room', { roomCode, token });
    }

    socket.on('connect', onConnect);

    // if already connected (e.g. hot-reload), emit immediately
    if (socket.connected) {
      socket.emit('join-room', { roomCode, token });
    } else {
      socket.connect();
    }

    socket.on('join-error', (msg) => {
      setStatus(`Error: ${msg}`);
    });

    socket.on('room-state', (state) => {
      if (state.role) setRole(state.role);
      if (state.videoId) {
        setVideoState({
          videoId: state.videoId,
          playing: !!state.playing,
          time:    Number(state.time) || 0
        });
      }
      setStatus(`Joined "${roomCode}" as ${state.role || initialRole}`);
    });

    socket.on('participants:update', setParticipants);

    socket.on('room-chat', (msg) => {
      if (!msg || msg.system) return;
      const text = String(msg.text || '');
      if (msg.name === 'System' && /(?:joined|left) the room\.$/.test(text)) return;
      setMessages(prev => [...prev, msg]);
    });

    socket.on('role:updated', ({ role: newRole }) => {
      setRole(newRole);
      setStatus(`Your role is now: ${newRole}`);
    });

    socket.on('participant:removed', ({ reason }) => {
      setRemoved(reason || 'You were removed from the room.');
    });

    socket.on('host:transferred', ({ newHostId }) => {
      if (newHostId === userId) {
        setRole('host');
        setStatus('You are now the host!');
      }
    });

    socket.on('playback:play', ({ time }) => {
      setVideoState(v => v ? { ...v, playing: true, time: time ?? v.time } : v);
    });
    socket.on('playback:pause', ({ time }) => {
      setVideoState(v => v ? { ...v, playing: false, time: time ?? v.time } : v);
    });
    socket.on('playback:seek', ({ time }) => {
      setVideoState(v => v ? { ...v, time } : v);
    });
    socket.on('playback:changeVideo', ({ videoId }) => {
      setVideoState({ videoId, playing: false, time: 0 });
    });
    // legacy periodic sync from host
    socket.on('video-state', (state) => {
      const next = {
        videoId: state.videoId,
        playing: !!state.playing,
        time: Number(state.time) || 0
      };
      setVideoState(current => current?.videoId === next.videoId
        && current.playing === next.playing
        && Math.abs(current.time - next.time) < 0.5
        ? current
        : next);
    });

    return () => {
      socket.off('connect',             onConnect);
      socket.off('join-error');
      socket.off('room-state');
      socket.off('participants:update');
      socket.off('room-chat');
      socket.off('role:updated');
      socket.off('participant:removed');
      socket.off('host:transferred');
      socket.off('playback:play');
      socket.off('playback:pause');
      socket.off('playback:seek');
      socket.off('playback:changeVideo');
      socket.off('video-state');
      socket.disconnect();
    };
  }, [initialRole, roomCode, token, userId]);

  function sendChat(text) {
    socket.emit('room-chat', { text });
  }

  function copyRoomLink() {
    const url = `${window.location.origin}?room=${roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // ── removed screen ──────────────────────────────────────────────────────────
  if (removed) {
    return (
      <div className="join-page">
        <div className="join-card" style={{ textAlign: 'center' }}>
          <h1>🚫 Removed</h1>
          <p style={{ color: 'var(--muted)', margin: '16px 0 24px' }}>{removed}</p>
          <button className="btn primary" onClick={onLeave}>Back to Lobby</button>
        </div>
      </div>
    );
  }

  return (
    <div className="room-shell">
      <aside className="sidebar panel">
        <div className="sidebar-header">
          <h2>VibeRoom</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className="room-code-badge">{roomCode}</span>
            <button className="btn-sm secondary" onClick={copyRoomLink} title="Copy invite link">
              {copied ? '✓' : '🔗'}
            </button>
            <button className="btn-sm danger" onClick={onLeave} title="Leave room">Leave</button>
          </div>
        </div>

        <div className="you-badge">
          <span>{name}</span>
          <span className={`role-badge role-${role}`}>{role}</span>
        </div>

        <ParticipantsList
          participants={participants}
          myUserId={userId}
          myRole={role}
          roomCode={roomCode}
          onRoleChange={(uid, newRole) => socket.emit('role:assign',       { targetUserId: uid, newRole })}
          onRemove={(uid)              => socket.emit('participant:remove', { targetUserId: uid })}
          onTransfer={(uid)            => socket.emit('host:transfer',      { targetUserId: uid })}
        />

        <RequestPanel role={role} videoState={videoState} />

        <Chat messages={messages} onSend={sendChat} />
      </aside>

      <main className="main-content panel">
        <div className="status-bar">{status}</div>

        <YoutubePlayer
          key={role}
          videoState={videoState}
          role={role}
          onStateChange={setVideoState}
        />
      </main>
    </div>
  );
}
