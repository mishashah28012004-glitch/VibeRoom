require('dotenv').config();
const { randomUUID } = require('crypto');
const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const path       = require('path');
const { Server } = require('socket.io');
const pool       = require('./db');
const { verifyToken } = require('./auth');
const roomsRouter = require('./routes/rooms');

const app    = express();
const server = http.createServer(app);
const configuredOrigins = (process.env.CLIENT_ORIGIN || '').split(',').map(origin => origin.trim()).filter(Boolean);
const corsOrigin = configuredOrigins.length
  ? configuredOrigins
  : process.env.NODE_ENV === 'production' ? false : '*';
const io     = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST']
  }
});
const PORT   = process.env.PORT || 3000;
const pendingRequests = new Map();
app.set('io', io);

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', roomsRouter);

// ── global async error handler for /api routes ─────────────────────────────
app.use('/api', (err, req, res, next) => {
  console.error('[API Error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── role helpers ──────────────────────────────────────────────────────────────

const CAN_CONTROL = new Set(['host', 'moderator']);

async function getDbParticipant(roomCode, userId) {
  const [[row]] = await pool.query(
    `SELECT rp.role, r.id AS room_id, r.host_user_id
     FROM room_participants rp
     JOIN rooms r ON r.id = rp.room_id
     WHERE r.room_code = ? AND rp.user_id = ?`,
    [roomCode, userId]
  );
  return row || null;
}

async function logRoomEvent(roomId, userId, eventType, payload) {
  await pool.query(
    'INSERT INTO room_events (room_id, user_id, event_type, payload) VALUES (?, ?, ?, ?)',
    [roomId, userId || null, eventType, JSON.stringify(payload || {})]
  );
}

async function saveRoomState(roomCode, state) {
  await pool.query(
    `UPDATE rooms SET video_id=?, video_title=?, playing=?, playback_time=? WHERE room_code=?`,
    [state.videoId || '', state.title || '', state.playing ? 1 : 0, state.time || 0, roomCode]
  );
}

async function getRoomState(roomCode) {
  const [[row]] = await pool.query(
    'SELECT video_id, video_title, playing, playback_time, updated_at FROM rooms WHERE room_code = ?',
    [roomCode]
  );
  return row ? {
    videoId:  row.video_id,
    title:    row.video_title,
    playing:  !!row.playing,
    time:     Number(row.playback_time) || 0,
    updatedAt: row.updated_at
  } : null;
}

async function getParticipantList(roomCode) {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.socket_id, rp.role
     FROM room_participants rp
     JOIN users u ON u.id = rp.user_id
     JOIN rooms r ON r.id = rp.room_id
     WHERE r.room_code = ?`,
    [roomCode]
  );
  return rows;
}

async function emitParticipants(roomCode) {
  const list = await getParticipantList(roomCode);
  io.to(roomCode).emit('participants:update', list);
}

// ── in-memory time tracking (lightweight, no DB polling) ─────────────────────
const roomTimers = new Map(); // roomCode -> { time, playing, lastUpdated }

function getStateTime(roomCode, state) {
  const timer = roomTimers.get(roomCode);
  if (timer) return timer.playing ? timer.time + (Date.now() - timer.lastUpdated) / 1000 : timer.time;
  if (!state) return 0;
  const time = Number(state.time) || 0;
  if (!state.playing) return time;
  const updatedAt = state.updatedAt ? new Date(state.updatedAt).getTime() : Date.now();
  return time + Math.max(0, Date.now() - updatedAt) / 1000;
}

function parsePlaybackTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function normalizeRequestedAction(type, payload = {}) {
  if (['play', 'pause', 'seek'].includes(type)) {
    const time = parsePlaybackTime(payload.time);
    return time === null ? null : { type, payload: { time } };
  }
  if (type === 'changeVideo') {
    const videoId = String(payload.videoId || '');
    return /^[a-zA-Z0-9_-]{11}$/.test(videoId)
      ? { type, payload: { videoId } }
      : null;
  }
  return null;
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── join-room ──────────────────────────────────────────────────────────────
  socket.on('join-room', async (data) => {
    if (!data || !data.roomCode || !data.token) return;

    let decoded;
    try { decoded = verifyToken(data.token); }
    catch { socket.emit('join-error', 'Invalid token'); return; }

    const roomCode = String(data.roomCode).trim().slice(0, 20);
    const userId   = decoded.userId;
    const name     = decoded.name;

    // look up role from DB
    const participant = await getDbParticipant(roomCode, userId);
    if (!participant) {
      socket.emit('join-error', 'Not a member of this room. Call /api/rooms/:code/join first.');
      return;
    }

    const role = participant.role;

    // leave previous room
    const prevRoom = socket.data.roomCode;
    if (prevRoom && prevRoom !== roomCode) {
      socket.leave(prevRoom);
      await pool.query(
        'UPDATE users SET socket_id = "" WHERE id = ?', [userId]
      );
      emitParticipants(prevRoom);
    }

    socket.join(roomCode);
    socket.data = { roomCode, userId, name, role };

    // persist socket_id
    await pool.query('UPDATE users SET socket_id = ? WHERE id = ?', [socket.id, userId]);

    // restore state
    const state = await getRoomState(roomCode);
    socket.emit('room-state', {
      ...(state || {}),
      time: getStateTime(roomCode, state),
      role
    });

    await emitParticipants(roomCode);

    io.to(roomCode).emit('room-chat', {
      name: 'System',
      text: `${name} joined the room.`,
      system: true
    });
  });

  // ── playback:play ──────────────────────────────────────────────────────────
  socket.on('playback:play', async ({ time } = {}) => {
    const { roomCode, role } = socket.data || {};
    const t = parsePlaybackTime(time);
    if (!roomCode || !CAN_CONTROL.has(role) || t === null) return;

    roomTimers.set(roomCode, { time: t, playing: true, lastUpdated: Date.now() });

    const state = await getRoomState(roomCode);
    if (state) {
      await saveRoomState(roomCode, { ...state, playing: true, time: t });
    }

    socket.to(roomCode).emit('playback:play', { time: t });
  });

  // ── playback:pause ─────────────────────────────────────────────────────────
  socket.on('playback:pause', async ({ time } = {}) => {
    const { roomCode, role } = socket.data || {};
    const t = parsePlaybackTime(time);
    if (!roomCode || !CAN_CONTROL.has(role) || t === null) return;

    roomTimers.set(roomCode, { time: t, playing: false, lastUpdated: Date.now() });

    const state = await getRoomState(roomCode);
    if (state) {
      await saveRoomState(roomCode, { ...state, playing: false, time: t });
    }

    socket.to(roomCode).emit('playback:pause', { time: t });
  });

  // ── playback:seek ──────────────────────────────────────────────────────────
  socket.on('playback:seek', async ({ time } = {}) => {
    const { roomCode, role } = socket.data || {};
    const t = parsePlaybackTime(time);
    if (!roomCode || !CAN_CONTROL.has(role) || t === null) return;

    const timer = roomTimers.get(roomCode) || { playing: false };
    roomTimers.set(roomCode, { ...timer, time: t, lastUpdated: Date.now() });

    const state = await getRoomState(roomCode);
    if (state) await saveRoomState(roomCode, { ...state, time: t });

    socket.to(roomCode).emit('playback:seek', { time: t });
  });

  // ── playback:changeVideo ───────────────────────────────────────────────────
  socket.on('playback:changeVideo', async ({ videoId, title } = {}) => {
    const { roomCode, role } = socket.data || {};
    if (!roomCode || !CAN_CONTROL.has(role) || !/^[a-zA-Z0-9_-]{11}$/.test(String(videoId || ''))) return;

    const safeId    = String(videoId).slice(0, 32);
    const safeTitle = String(title || videoId).slice(0, 255);

    roomTimers.set(roomCode, { time: 0, playing: false, lastUpdated: Date.now() });
    await saveRoomState(roomCode, { videoId: safeId, title: safeTitle, playing: false, time: 0 });

    io.to(roomCode).emit('playback:changeVideo', { videoId: safeId, title: safeTitle });
  });

  // ── legacy video-state (preserve existing host sync) ──────────────────────
  socket.on('video-state', async (state) => {
    const { roomCode, role } = socket.data || {};
    if (!roomCode || !CAN_CONTROL.has(role) || !state || !/^[a-zA-Z0-9_-]{11}$/.test(String(state.videoId || '')) || typeof state.playing !== 'boolean') return;
    const time = parsePlaybackTime(state.time);
    if (time === null) return;

    const safeState = {
      videoId: String(state.videoId).slice(0, 32),
      title:   String(state.title || state.videoId).slice(0, 255),
      time,
      playing: state.playing
    };

    roomTimers.set(roomCode, {
      time: safeState.time,
      playing: safeState.playing,
      lastUpdated: Date.now()
    });

    await saveRoomState(roomCode, safeState);
    socket.to(roomCode).emit('video-state', safeState);
  });

  // ── role:assign ────────────────────────────────────────────────────────────
  socket.on('role:assign', async ({ targetUserId, newRole } = {}) => {
    const { roomCode, userId, role } = socket.data || {};
    if (!roomCode || role !== 'host') return;
    if (!['moderator', 'participant', 'viewer'].includes(newRole)) return;
    const targetId = Number(targetUserId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return;

    const [[room]] = await pool.query('SELECT id FROM rooms WHERE room_code = ?', [roomCode]);
    if (!room) return;
    const [[target]] = await pool.query(
      'SELECT role FROM room_participants WHERE room_id = ? AND user_id = ?',
      [room.id, targetId]
    );
    if (!target || target.role === 'host') return;

    await pool.query(
      'UPDATE room_participants SET role = ? WHERE room_id = ? AND user_id = ?',
      [newRole, room.id, targetId]
    );
    await logRoomEvent(room.id, userId, 'role_changed', { targetUserId: targetId, newRole });

    // update socket.data for the target socket if online
    for (const [, s] of io.sockets.sockets) {
      if (s.data.userId === targetId && s.data.roomCode === roomCode) {
        s.data.role = newRole;
        s.emit('role:updated', { role: newRole });
      }
    }

    await emitParticipants(roomCode);
  });

  // ── participant:remove ─────────────────────────────────────────────────────
  socket.on('participant:remove', async ({ targetUserId } = {}) => {
    const { roomCode, userId, role } = socket.data || {};
    if (!roomCode || !CAN_CONTROL.has(role)) return;
    const targetId = Number(targetUserId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return;

    const [[room]] = await pool.query('SELECT id FROM rooms WHERE room_code = ?', [roomCode]);
    if (!room) return;

    // moderators can only remove viewers/participants, not other moderators or host
    const [[target]] = await pool.query(
      `SELECT rp.role FROM room_participants rp WHERE rp.room_id = ? AND rp.user_id = ?`,
      [room.id, targetId]
    );
    if (!target) return;
    if (role === 'moderator' && !['viewer', 'participant'].includes(target.role)) return;
    if (target.role === 'host') return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO room_bans (room_id, user_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE removed_at = CURRENT_TIMESTAMP`,
        [room.id, targetId]
      );
      await conn.query(
        'DELETE FROM room_participants WHERE room_id = ? AND user_id = ?',
        [room.id, targetId]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      return;
    } finally {
      conn.release();
    }
    await logRoomEvent(room.id, userId, 'participant_removed', { targetUserId: targetId });

    // kick the target socket
    for (const [, s] of io.sockets.sockets) {
      if (s.data.userId === targetId && s.data.roomCode === roomCode) {
        s.emit('participant:removed', { reason: 'You were removed from the room.' });
        s.leave(roomCode);
        s.data.roomCode = null;
      }
    }

    await emitParticipants(roomCode);
  });

  // ── host:transfer ──────────────────────────────────────────────────────────
  socket.on('host:transfer', async ({ targetUserId } = {}) => {
    const { roomCode, userId, role } = socket.data || {};
    if (!roomCode || role !== 'host') return;
    const targetId = Number(targetUserId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === userId) return;

    const [[room]] = await pool.query('SELECT id FROM rooms WHERE room_code = ?', [roomCode]);
    if (!room) return;
    const [[target]] = await pool.query(
      'SELECT role FROM room_participants WHERE room_id = ? AND user_id = ?',
      [room.id, targetId]
    );
    if (!target || target.role === 'host') return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'UPDATE room_participants SET role = "participant" WHERE room_id = ? AND user_id = ?',
        [room.id, userId]
      );
      await conn.query(
        'UPDATE room_participants SET role = "host" WHERE room_id = ? AND user_id = ?',
        [room.id, targetId]
      );
      await conn.query('UPDATE rooms SET host_user_id = ? WHERE id = ?', [targetId, room.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      conn.release();
      return;
    }
    conn.release();
    await logRoomEvent(room.id, userId, 'host_transferred', { newHostId: targetId });

    // Update every active session for both users.
    for (const [, s] of io.sockets.sockets) {
      if (s.data.roomCode !== roomCode) continue;
      if (s.data.userId === userId) {
        s.data.role = 'participant';
        s.emit('role:updated', { role: 'participant' });
      } else if (s.data.userId === targetId) {
        s.data.role = 'host';
        s.emit('role:updated', { role: 'host' });
      }
    }

    io.to(roomCode).emit('host:transferred', { newHostId: targetId });
    await emitParticipants(roomCode);
  });

  // ── request:action (participants request playback actions) ───────────────────
  socket.on('request:action', (data = {}, acknowledge) => {
    const { roomCode, userId, name, role } = socket.data || {};
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!roomCode || !userId || CAN_CONTROL.has(role)) {
      reply({ error: 'Only participants and viewers can request playback actions.' });
      return;
    }

    const action = normalizeRequestedAction(data.type, data.payload);
    if (!action) {
      reply({ error: 'Unsupported or invalid playback request.' });
      return;
    }

    const requestId = randomUUID();
    const timeout = setTimeout(() => pendingRequests.delete(requestId), 5 * 60 * 1000);
    timeout.unref?.();
    const request = {
      requestId,
      roomCode,
      userId,
      socketId: socket.id,
      name,
      ...action,
      timeout
    };
    pendingRequests.set(requestId, request);
    reply({ requestId });

    const message = {
      requestId,
      fromUserId: userId,
      fromName: name,
      type: action.type,
      payload: action.payload
    };
    for (const participant of io.sockets.sockets.values()) {
      if (participant.data.roomCode === roomCode && CAN_CONTROL.has(participant.data.role)) {
        participant.emit('request:incoming', message);
      }
    }
  });

  // ── request:respond (host/mod approves or rejects) ──────────────────────────
  socket.on('request:respond', async ({ requestId, approved } = {}) => {
    const { roomCode, role } = socket.data || {};
    if (!roomCode || !CAN_CONTROL.has(role) || typeof approved !== 'boolean') return;

    const request = pendingRequests.get(String(requestId || ''));
    if (!request || request.roomCode !== roomCode) return;
    clearTimeout(request.timeout);
    pendingRequests.delete(request.requestId);

    const state = await getRoomState(roomCode);
    const action = normalizeRequestedAction(request.type, request.payload);
    const requester = await getDbParticipant(roomCode, request.userId);
    const executable = action && requester && (action.type === 'changeVideo' || state?.videoId);
    const accepted = approved && !!executable;

    for (const participant of io.sockets.sockets.values()) {
      if (participant.data.userId === request.userId && participant.data.roomCode === roomCode) {
        participant.emit('request:result', {
          requestId: request.requestId,
          approved: accepted,
          type: request.type
        });
      }
    }
    if (!accepted) return;

    if (action.type === 'changeVideo') {
      const { videoId } = action.payload;
      roomTimers.set(roomCode, { time: 0, playing: false, lastUpdated: Date.now() });
      await saveRoomState(roomCode, { videoId, title: videoId, playing: false, time: 0 });
      io.to(roomCode).emit('playback:changeVideo', { videoId, title: videoId });
      return;
    }

    const time = action.payload.time;
    const playing = action.type === 'play' ? true
      : action.type === 'pause' ? false
      : state.playing;
    roomTimers.set(roomCode, { time, playing, lastUpdated: Date.now() });
    await saveRoomState(roomCode, { ...state, time, playing });
    io.to(roomCode).emit(`playback:${action.type}`, { time });
  });

  // ── room-chat (preserved) ──────────────────────────────────────────────────
  socket.on('room-chat', (data) => {
    const { roomCode, name } = socket.data || {};
    if (!roomCode || !data || !data.text) return;
    io.to(roomCode).emit('room-chat', {
      name: name || 'Guest',
      text: String(data.text).trim().slice(0, 500)
    });
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const { roomCode, userId, name } = socket.data || {};
    for (const [requestId, request] of pendingRequests) {
      if (request.socketId === socket.id) {
        clearTimeout(request.timeout);
        pendingRequests.delete(requestId);
      }
    }

    if (!roomCode || !userId) return;

    io.to(roomCode).emit('room-chat', {
      name: 'System',
      text: `${name || 'Guest'} left the room.`,
      system: true
    });

    await pool.query('UPDATE users SET socket_id = "" WHERE id = ? AND socket_id = ?', [userId, socket.id]).catch(() => {});
    await emitParticipants(roomCode).catch(() => {});
  });
});

// ── health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch {
    res.status(500).json({ ok: false, db: 'error' });
  }
});

// ── API 404 ──────────────────────────────────────────────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` });
});

// ── SPA fallback (non-API routes only) ──────────────────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`VibeRoomon http://localhost:${PORT}`);
});
