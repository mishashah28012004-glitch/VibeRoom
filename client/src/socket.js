import { io } from 'socket.io-client';

const API_ORIGIN = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

// Create a fresh socket instance. We do NOT autoConnect — RoomPage controls
// the lifecycle explicitly. A new instance is created each time this module
// is evaluated, which happens once per page load (correct behaviour).
export const socket = io(API_ORIGIN || undefined, {
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 1000
});

const BASE = `${API_ORIGIN}/api`;

async function apiFetch(path, options = {}) {
  const token = sessionStorage.getItem('token');

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...options
    });
  } catch {
    throw new Error('Cannot reach server. Is the backend running on port 3000?');
  }

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    try { data = await res.json(); }
    catch { throw new Error(`Server error (${res.status}) — invalid JSON response`); }
  } else {
    const text = await res.text().catch(() => '');
    throw new Error(`Server error (${res.status})${text ? ': ' + text.slice(0, 120) : ''}`);
  }

  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ── auth ──────────────────────────────────────────────────────────────────────

export async function authGuest(name) {
  const data = await apiFetch('/auth/guest', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  sessionStorage.setItem('token',  data.token);
  sessionStorage.setItem('userId', String(data.userId));
  sessionStorage.setItem('name',   data.name);
  return data;
}

// ── rooms ─────────────────────────────────────────────────────────────────────

export async function generateRoomCode() {
  return apiFetch('/rooms/generate-code', { method: 'POST' });
}

export async function checkRoom(roomCode) {
  return apiFetch(`/rooms/check/${roomCode.trim().toUpperCase()}`);
}

export async function createRoom(roomCode) {
  return apiFetch('/rooms', {
    method: 'POST',
    body: JSON.stringify({ roomCode })
  });
}

export async function joinRoom(roomCode) {
  return apiFetch(`/rooms/${roomCode.trim().toUpperCase()}/join`, { method: 'POST' });
}

export async function getParticipants(roomCode) {
  return apiFetch(`/rooms/${roomCode}/participants`);
}

export async function apiAssignRole(roomCode, userId, role) {
  return apiFetch(`/rooms/${roomCode}/participants/${userId}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role })
  });
}

export async function apiRemoveParticipant(roomCode, userId) {
  return apiFetch(`/rooms/${roomCode}/participants/${userId}`, { method: 'DELETE' });
}

export async function apiTransferHost(roomCode, userId) {
  return apiFetch(`/rooms/${roomCode}/transfer-host`, {
    method: 'POST',
    body: JSON.stringify({ userId })
  });
}
