const express        = require('express');
const router         = express.Router();
const pool           = require('../db');
const { authMiddleware, signToken } = require('../auth');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── helpers ───────────────────────────────────────────────────────────────────

async function getParticipant(roomId, userId) {
  const [[row]] = await pool.query(
    `SELECT rp.role, u.name, u.socket_id
     FROM room_participants rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id = ? AND rp.user_id = ?`,
    [roomId, userId]
  );
  return row || null;
}

async function logEvent(roomId, userId, eventType, payload) {
  await pool.query(
    'INSERT INTO room_events (room_id, user_id, event_type, payload) VALUES (?,?,?,?)',
    [roomId, userId || null, eventType, JSON.stringify(payload || {})]
  );
}

async function emitParticipants(io, roomCode) {
  if (!io) return;
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.socket_id, rp.role
     FROM room_participants rp
     JOIN users u ON u.id = rp.user_id
     JOIN rooms r ON r.id = rp.room_id
     WHERE r.room_code = ?`,
    [roomCode]
  );
  io.to(roomCode).emit('participants:update', rows);
}

// generates a unique 6-char alphanumeric code, retries on collision
async function generateUniqueCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const [[existing]] = await pool.query(
      'SELECT id FROM rooms WHERE room_code = ?', [code]
    );
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique room code. Try again.');
}

// ── POST /api/auth/guest ──────────────────────────────────────────────────────
router.post('/auth/guest', wrap(async (req, res) => {
  const name = String(req.body.name || 'Guest').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Name required' });

  const [result] = await pool.query('INSERT INTO users (name) VALUES (?)', [name]);
  const userId = result.insertId;
  const token  = signToken({ userId, name });
  res.json({ token, userId, name });
}));

// ── POST /api/rooms/generate-code  (auth required — host only) ───────────────
// Creates a room with a server-generated unique code. Returns the code.
router.post('/rooms/generate-code', authMiddleware, wrap(async (req, res) => {
  const roomCode = await generateUniqueCode();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'INSERT INTO rooms (room_code, host_user_id) VALUES (?, ?)',
      [roomCode, req.user.userId]
    );
    const [[room]] = await conn.query('SELECT id FROM rooms WHERE room_code = ?', [roomCode]);

    await conn.query(
      `INSERT INTO room_participants (room_id, user_id, role) VALUES (?, ?, 'host')`,
      [room.id, req.user.userId]
    );

    await conn.commit();
    res.json({ roomCode, roomId: room.id });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// ── GET /api/rooms/check/:roomCode  (NO auth — guests can verify a code) ─────
router.get('/rooms/check/:roomCode', wrap(async (req, res) => {
  const code = String(req.params.roomCode).trim().toUpperCase();
  const [[room]] = await pool.query(
    'SELECT id, room_code FROM rooms WHERE room_code = ?', [code]
  );
  if (!room) return res.status(404).json({ exists: false, error: 'Room not found. Check the code and try again.' });
  res.json({ exists: true, roomCode: room.room_code });
}));

// ── POST /api/rooms  (kept for backward compat — manual room code) ────────────
router.post('/rooms', authMiddleware, wrap(async (req, res) => {
  const roomCode = String(req.body.roomCode || '').trim().toUpperCase().slice(0, 20);
  if (!roomCode) return res.status(400).json({ error: 'roomCode required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'INSERT INTO rooms (room_code, host_user_id) VALUES (?, ?)',
      [roomCode, req.user.userId]
    );
    const [[room]] = await conn.query('SELECT id FROM rooms WHERE room_code = ?', [roomCode]);

    await conn.query(
      `INSERT INTO room_participants (room_id, user_id, role) VALUES (?, ?, 'host')`,
      [room.id, req.user.userId]
    );

    await conn.commit();
    res.json({ roomCode, roomId: room.id });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Room already exists' });
    throw err;
  } finally {
    conn.release();
  }
}));

// ── GET /api/rooms/:roomCode ──────────────────────────────────────────────────
router.get('/rooms/:roomCode', authMiddleware, wrap(async (req, res) => {
  const [[room]] = await pool.query(
    'SELECT id, room_code, video_id, video_title, playing, playback_time FROM rooms WHERE room_code = ?',
    [req.params.roomCode.toUpperCase()]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const actor = await getParticipant(room.id, req.user.userId);
  if (!actor) return res.status(403).json({ error: 'Not a member of this room' });
  res.json(room);
}));

// ── POST /api/rooms/:roomCode/join ────────────────────────────────────────────
router.post('/rooms/:roomCode/join', authMiddleware, wrap(async (req, res) => {
  const [[room]] = await pool.query(
    'SELECT id, video_id, video_title, playing, playback_time FROM rooms WHERE room_code = ?',
    [req.params.roomCode.toUpperCase()]
  );
  if (!room) return res.status(404).json({ error: 'Room not found. Check the room code and try again.' });

  const [[ban]] = await pool.query(
    'SELECT 1 FROM room_bans WHERE room_id = ? AND user_id = ?',
    [room.id, req.user.userId]
  );
  if (ban) return res.status(403).json({ error: 'You were removed from this room.' });

  const existing = await getParticipant(room.id, req.user.userId);
  const role = existing ? existing.role : 'viewer';

  if (!existing) {
    await pool.query(
      `INSERT INTO room_participants (room_id, user_id, role) VALUES (?, ?, 'viewer')
       ON DUPLICATE KEY UPDATE role = role`,
      [room.id, req.user.userId]
    );
  }

  res.json({ roomId: room.id, role, state: room });
}));

// ── GET /api/rooms/:roomCode/participants ─────────────────────────────────────
router.get('/rooms/:roomCode/participants', authMiddleware, wrap(async (req, res) => {
  const [[room]] = await pool.query(
    'SELECT id FROM rooms WHERE room_code = ?',
    [req.params.roomCode.toUpperCase()]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const actor = await getParticipant(room.id, req.user.userId);
  if (!actor) return res.status(403).json({ error: 'Not a member of this room' });

  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.socket_id, rp.role
     FROM room_participants rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id = ?`,
    [room.id]
  );
  res.json(rows);
}));

// ── PATCH /api/rooms/:roomCode/participants/:userId/role ──────────────────────
router.patch('/rooms/:roomCode/participants/:userId/role', authMiddleware, wrap(async (req, res) => {
  const targetUserId = Number(req.params.userId);
  const newRole      = req.body.role;

  if (!['moderator', 'participant', 'viewer'].includes(newRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const [[room]] = await pool.query(
    'SELECT id FROM rooms WHERE room_code = ?', [req.params.roomCode.toUpperCase()]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const actor = await getParticipant(room.id, req.user.userId);
  if (!actor || actor.role !== 'host') return res.status(403).json({ error: 'Only host can assign roles' });

  const target = await getParticipant(room.id, targetUserId);
  if (!target) return res.status(404).json({ error: 'Participant not found' });
  if (target.role === 'host') return res.status(400).json({ error: 'Cannot change host role this way' });

  await pool.query(
    'UPDATE room_participants SET role = ? WHERE room_id = ? AND user_id = ?',
    [newRole, room.id, targetUserId]
  );

  await logEvent(room.id, req.user.userId, 'role_changed', { targetUserId, newRole });
  const io = req.app.get('io');
  if (io) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId === targetUserId && socket.data.roomCode === req.params.roomCode.toUpperCase()) {
        socket.data.role = newRole;
        socket.emit('role:updated', { role: newRole });
      }
    }
    await emitParticipants(io, req.params.roomCode.toUpperCase());
  }
  res.json({ ok: true, userId: targetUserId, role: newRole });
}));

// ── DELETE /api/rooms/:roomCode/participants/:userId ──────────────────────────
router.delete('/rooms/:roomCode/participants/:userId', authMiddleware, wrap(async (req, res) => {
  const targetUserId = Number(req.params.userId);

  const [[room]] = await pool.query(
    'SELECT id FROM rooms WHERE room_code = ?', [req.params.roomCode.toUpperCase()]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const actor = await getParticipant(room.id, req.user.userId);
  if (!actor || !['host', 'moderator'].includes(actor.role)) {
    return res.status(403).json({ error: 'Only host or moderator can remove participants' });
  }

  const target = await getParticipant(room.id, targetUserId);
  if (!target) return res.status(404).json({ error: 'Participant not found' });
  if (target.role === 'host') return res.status(400).json({ error: 'Cannot remove the host' });
  if (actor.role === 'moderator' && !['viewer', 'participant'].includes(target.role)) {
    return res.status(403).json({ error: 'Moderators can only remove viewers and participants' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO room_bans (room_id, user_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE removed_at = CURRENT_TIMESTAMP`,
      [room.id, targetUserId]
    );
    await conn.query(
      'DELETE FROM room_participants WHERE room_id = ? AND user_id = ?',
      [room.id, targetUserId]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await logEvent(room.id, req.user.userId, 'participant_removed', { targetUserId });
  const io = req.app.get('io');
  if (io) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId === targetUserId && socket.data.roomCode === req.params.roomCode.toUpperCase()) {
        socket.emit('participant:removed', { reason: 'You were removed from the room.' });
        socket.leave(req.params.roomCode.toUpperCase());
        socket.data.roomCode = null;
      }
    }
    await emitParticipants(io, req.params.roomCode.toUpperCase());
  }
  res.json({ ok: true, socketId: target.socket_id });
}));

// ── POST /api/rooms/:roomCode/transfer-host ───────────────────────────────────
router.post('/rooms/:roomCode/transfer-host', authMiddleware, wrap(async (req, res) => {
  const newHostId = Number(req.body.userId);
  if (!newHostId) return res.status(400).json({ error: 'userId required' });

  const [[room]] = await pool.query(
    'SELECT id FROM rooms WHERE room_code = ?', [req.params.roomCode.toUpperCase()]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const actor = await getParticipant(room.id, req.user.userId);
  if (!actor || actor.role !== 'host') return res.status(403).json({ error: 'Only host can transfer' });

  const target = await getParticipant(room.id, newHostId);
  if (!target) return res.status(404).json({ error: 'Target participant not found' });
  if (target.role === 'host') return res.status(400).json({ error: 'Target is already the host' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'UPDATE room_participants SET role = ? WHERE room_id = ? AND user_id = ?',
      ['participant', room.id, req.user.userId]
    );
    await conn.query(
      'UPDATE room_participants SET role = ? WHERE room_id = ? AND user_id = ?',
      ['host', room.id, newHostId]
    );
    await conn.query('UPDATE rooms SET host_user_id = ? WHERE id = ?', [newHostId, room.id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await logEvent(room.id, req.user.userId, 'host_transferred', { newHostId });
  const io = req.app.get('io');
  if (io) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.roomCode !== req.params.roomCode.toUpperCase()) continue;
      if (socket.data.userId === req.user.userId) {
        socket.data.role = 'participant';
        socket.emit('role:updated', { role: 'participant' });
      } else if (socket.data.userId === newHostId) {
        socket.data.role = 'host';
        socket.emit('role:updated', { role: 'host' });
      }
    }
    io.to(req.params.roomCode.toUpperCase()).emit('host:transferred', { newHostId });
    await emitParticipants(io, req.params.roomCode.toUpperCase());
  }
  res.json({ ok: true, newHostId, newHostSocketId: target.socket_id });
}));

module.exports = router;
