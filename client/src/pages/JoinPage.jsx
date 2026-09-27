import { useState } from 'react';
import { authGuest, generateRoomCode, checkRoom, joinRoom } from '../socket';

// read ?room=CODE from the invite URL
function getRoomFromUrl() {
  try { return new URLSearchParams(window.location.search).get('room') || ''; }
  catch { return ''; }
}

// ── Host flow: enter name → click Create Room → see code → enter room ─────────
function HostFlow({ onJoined }) {
  const [name,    setName]    = useState(localStorage.getItem('watchName') || '');
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);
  // after creation, show the code before entering the room
  const [created, setCreated] = useState(null); // { roomCode, auth, joined }
  const [copied,  setCopied]  = useState('');   // 'code' | 'link' | ''

  async function handleCreate() {
    const n = name.trim();
    if (!n) { setError('Enter your display name.'); return; }
    setError('');
    setLoading(true);
    try {
      const auth   = await authGuest(n);
      const room   = await generateRoomCode();          // POST /api/rooms/generate-code
      const joined = await joinRoom(room.roomCode);     // POST /api/rooms/:code/join
      localStorage.setItem('watchName', n);
      setCreated({ roomCode: room.roomCode, auth, joined });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function copy(what) {
    const text = what === 'code'
      ? created.roomCode
      : `${window.location.origin}?room=${created.roomCode}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(''), 2000);
    });
  }

  function enterRoom() {
    const { roomCode, auth, joined } = created;
    localStorage.setItem('watchRoom', roomCode);
    onJoined({ roomCode, role: joined.role, userId: auth.userId, name: name.trim(), token: auth.token, state: joined.state });
  }

  // ── step 2: room created, show code ────────────────────────────────────────
  if (created) {
    return (
      <div className="join-card">
        <h1>🎬 Room Created!</h1>

        <div className="room-created-box">
          <p className="room-created-label">Your Room Code</p>
          <div className="room-code-display">{created.roomCode}</div>
          <p className="room-created-hint">Share this code or the invite link with your guests.</p>
        </div>

        <div className="copy-row">
          <button className="btn secondary" onClick={() => copy('code')}>
            {copied === 'code' ? '✓ Copied!' : '📋 Copy Code'}
          </button>
          <button className="btn secondary" onClick={() => copy('link')}>
            {copied === 'link' ? '✓ Copied!' : '🔗 Copy Invite Link'}
          </button>
        </div>

        <button className="btn primary" style={{ marginTop: '16px', width: '100%' }} onClick={enterRoom}>
          Enter Room →
        </button>
      </div>
    );
  }

  // ── step 1: enter name ──────────────────────────────────────────────────────
  return (
    <div className="join-card">
      <h1>🎬 Host a Room</h1>

      <div className="field-group">
        <label>Your Display Name</label>
        <input
          type="text" maxLength={24} placeholder="Enter your name"
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
          autoFocus
        />
      </div>

      {error && <p className="error-msg">{error}</p>}

      <button className="btn primary" style={{ width: '100%' }} onClick={handleCreate} disabled={loading}>
        {loading ? '⏳ Creating…' : '🎬 Create Room'}
      </button>
    </div>
  );
}

// ── Guest flow: enter code (pre-filled from URL) → enter name → join ──────────
function GuestFlow({ onJoined }) {
  const [step,    setStep]    = useState(getRoomFromUrl() ? 'name' : 'code'); // 'code' | 'name' | 'joining'
  const [code,    setCode]    = useState(getRoomFromUrl().toUpperCase());
  const [name,    setName]    = useState(localStorage.getItem('watchName') || '');
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);

  async function handleCheckCode() {
    const c = code.trim().toUpperCase();
    if (!c) { setError('Enter a room code.'); return; }
    setError('');
    setLoading(true);
    try {
      await checkRoom(c);   // GET /api/rooms/check/:code — 404 if not found
      setCode(c);
      setStep('name');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin() {
    const n = name.trim();
    if (!n) { setError('Enter your display name.'); return; }
    setError('');
    setLoading(true);
    try {
      const auth   = await authGuest(n);
      const joined = await joinRoom(code);
      localStorage.setItem('watchName', n);
      localStorage.setItem('watchRoom', code);
      onJoined({ roomCode: code, role: joined.role, userId: auth.userId, name: n, token: auth.token, state: joined.state });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ── step 1: enter / confirm room code ──────────────────────────────────────
  if (step === 'code') {
    return (
      <div className="join-card">
        <h1>👁 Join a Room</h1>

        <div className="field-group">
          <label>Room Code</label>
          <input
            type="text" maxLength={20} placeholder="e.g. AB3X7K"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleCheckCode()}
            autoFocus
            style={{ textTransform: 'uppercase', letterSpacing: '0.15em', fontSize: '1.1rem' }}
          />
        </div>

        {error && <p className="error-msg">{error}</p>}

        <button className="btn primary" style={{ width: '100%' }} onClick={handleCheckCode} disabled={loading}>
          {loading ? '⏳ Checking…' : 'Check Room →'}
        </button>
      </div>
    );
  }

  // ── step 2: code verified, enter name ──────────────────────────────────────
  return (
    <div className="join-card">
      <h1>👁 Join a Room</h1>

      <div className="room-verified-badge">
        ✓ Room <strong>{code}</strong> found
        <button className="btn-sm secondary" style={{ marginLeft: '8px' }} onClick={() => { setStep('code'); setError(''); }}>
          Change
        </button>
      </div>

      <div className="field-group" style={{ marginTop: '16px' }}>
        <label>Your Display Name</label>
        <input
          type="text" maxLength={24} placeholder="Enter your name"
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleJoin()}
          autoFocus
        />
      </div>

      {error && <p className="error-msg">{error}</p>}

      <button className="btn accent" style={{ width: '100%' }} onClick={handleJoin} disabled={loading}>
        {loading ? '⏳ Joining…' : '🚀 Join Room'}
      </button>
    </div>
  );
}

// ── Root: pick Host or Guest ──────────────────────────────────────────────────
export default function JoinPage({ onJoined }) {
  // if URL has ?room=, go straight to guest flow
  const [mode, setMode] = useState(getRoomFromUrl() ? 'guest' : null);

  if (mode === 'host')  return <div className="join-page"><HostFlow  onJoined={onJoined} /></div>;
  if (mode === 'guest') return <div className="join-page"><GuestFlow onJoined={onJoined} /></div>;

  return (
    <div className="join-page">
      <div className="join-card">
        <h1>🎬 VibeRoom</h1>
        <p className="join-hint" style={{ marginBottom: '24px' }}>
          Watch YouTube videos together in real time.
        </p>

        <div className="mode-select">
          <button className="mode-btn" onClick={() => setMode('host')}>
            <span className="mode-icon">🎬</span>
            <span className="mode-title">Create a Room</span>
            <span className="mode-desc">Start a new Vibe Room & invite friends</span>
          </button>

          <button className="mode-btn" onClick={() => setMode('guest')}>
            <span className="mode-icon">👁</span>
            <span className="mode-title">Join a Room</span>
            <span className="mode-desc">Enter a room code or open an invite link</span>
          </button>
        </div>
      </div>
    </div>
  );
}
