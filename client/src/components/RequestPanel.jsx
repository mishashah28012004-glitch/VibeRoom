import { useState, useEffect } from 'react';
import { socket } from '../socket';

// Panel shown to viewers/participants — they can request actions
function RequesterPanel({ videoState }) {
  const [sent,   setSent]   = useState(null); // { type, requestId }
  const [result, setResult] = useState(null); // 'approved' | 'rejected'
  const [urlReq, setUrlReq] = useState('');

  useEffect(() => {
    socket.on('request:result', ({ requestId, approved }) => {
      if (sent?.requestId !== requestId) return;
      setResult(approved ? 'approved' : 'rejected');
      setSent(null);
      setTimeout(() => setResult(null), 3000);
    });
    return () => socket.off('request:result');
  }, [sent]);

  function sendRequest(type, payload = {}) {
    setResult(null);
    socket.emit('request:action', { type, payload }, ({ requestId, error } = {}) => {
      if (error || !requestId) {
        setResult('rejected');
        return;
      }
      setSent({ type, requestId });
    });
  }

  function extractId(url) {
    if (!url) return null;
    url = url.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
    try {
      const p = new URL(url);
      const h = p.hostname.replace(/^www\./, '');
      if (h === 'youtu.be') return p.pathname.split('/').filter(Boolean)[0] || null;
      if (h === 'youtube.com' || h === 'm.youtube.com') {
        if (p.pathname === '/watch') return p.searchParams.get('v');
        const m = p.pathname.match(/^\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
        return m ? m[2] : null;
      }
    } catch { return null; }
    return null;
  }

  return (
    <div className="request-panel">
      <h3>Request Actions</h3>
      <p className="request-hint">You are a viewer. Request the host to control playback.</p>

      <div className="request-btns">
        <button
          className="btn-sm secondary"
          disabled={!!sent}
          onClick={() => sendRequest('play', { time: videoState?.time || 0 })}
        >
          ▶ Request Play
        </button>
        <button
          className="btn-sm secondary"
          disabled={!!sent}
          onClick={() => sendRequest('pause', { time: videoState?.time || 0 })}
        >
          ⏸ Request Pause
        </button>
      </div>

      <div className="request-video-row">
        <input
          type="text"
          className="video-url-input"
          placeholder="YouTube URL to request"
          value={urlReq}
          onChange={e => setUrlReq(e.target.value)}
        />
        <button
          className="btn-sm secondary"
          disabled={!!sent}
          onClick={() => {
            const id = extractId(urlReq);
            if (!id) return;
            sendRequest('changeVideo', { videoId: id });
            setUrlReq('');
          }}
        >
          Request Video
        </button>
      </div>

      {sent && (
        <p className="request-status pending">⏳ Waiting for approval ({sent.type})…</p>
      )}
      {result === 'approved' && (
        <p className="request-status approved">✅ Request approved!</p>
      )}
      {result === 'rejected' && (
        <p className="request-status rejected">❌ Request rejected.</p>
      )}
    </div>
  );
}

// Panel shown to host/moderators — incoming requests with approve/reject
function ApprovalPanel() {
  const [requests, setRequests] = useState([]);

  useEffect(() => {
    socket.on('request:incoming', (req) => {
      setRequests(prev => {
        // replace if same user already has a pending request of same type
        const filtered = prev.filter(r => !(r.fromUserId === req.fromUserId && r.type === req.type));
        return [...filtered, req];
      });
    });
    return () => socket.off('request:incoming');
  }, []);

  function respond(req, approved) {
    socket.emit('request:respond', {
      requestId:   req.requestId,
      fromUserId:  req.fromUserId,
      approved,
      type:        req.type,
      payload:     req.payload
    });
    setRequests(prev => prev.filter(r => r.requestId !== req.requestId));
  }

  if (requests.length === 0) return null;

  return (
    <div className="approval-panel">
      <h3>Pending Requests <span className="count-badge">{requests.length}</span></h3>
      <ul className="request-list">
        {requests.map(req => (
          <li key={req.requestId} className="request-item">
            <span className="request-info">
              <strong>{req.fromName}</strong> wants to <em>{req.type}</em>
              {req.payload?.videoId && ` → ${req.payload.videoId}`}
            </span>
            <div className="request-actions">
              <button className="btn-sm accent"  onClick={() => respond(req, true)}>✓ Approve</button>
              <button className="btn-sm danger"  onClick={() => respond(req, false)}>✗ Reject</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RequestPanel({ role, videoState }) {
  const canControl = role === 'host' || role === 'moderator';
  if (canControl) return <ApprovalPanel />;
  return <RequesterPanel videoState={videoState} />;
}
