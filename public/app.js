const socket = io();

let player;
let roomCode      = 'demo';
let currentUser   = 'Guest';
let role          = 'viewer';
let userId        = null;
let authToken     = null;
let currentVideoId = '';
let isReady       = false;
let pendingVideoState = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const roomInput      = document.getElementById('roomInput');
const nameInput      = document.getElementById('nameInput');
const videoInput     = document.getElementById('videoInput');
const userList       = document.getElementById('userList');
const chatMessages   = document.getElementById('chatMessages');
const statusText     = document.getElementById('statusText');
const chatInput      = document.getElementById('chatInput');
const videoControls  = document.getElementById('videoControls');
const hostBtn        = document.getElementById('hostBtn');
const viewerBtn      = document.getElementById('viewerBtn');
const loadVideoBtn   = document.getElementById('loadVideoBtn');
const togglePlayBtn  = document.getElementById('togglePlayBtn');
const sendChatBtn    = document.getElementById('sendChatBtn');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmMsg     = document.getElementById('confirmMsg');
const confirmOk      = document.getElementById('confirmOk');
const confirmCancel  = document.getElementById('confirmCancel');

// ── restore saved values ──────────────────────────────────────────────────────
nameInput.value  = localStorage.getItem('watchName')  || 'Guest';
roomInput.value  = localStorage.getItem('watchRoom')  || 'demo';
videoInput.value = localStorage.getItem('watchVideo') || '';

// ── helpers ───────────────────────────────────────────────────────────────────
function updateStatus(msg, isError = false) {
  statusText.textContent = msg;
  statusText.style.color = isError ? '#ff5555' : '';
}

function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  try {
    const p = new URL(url);
    const h = p.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return p.pathname.split('/').filter(Boolean)[0] || null;
    if (['youtube.com','m.youtube.com','music.youtube.com'].includes(h)) {
      if (p.pathname === '/watch') return p.searchParams.get('v');
      const m = p.pathname.match(/^\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
      return m ? m[2] : null;
    }
  } catch { return null; }
  return null;
}

function addChatMessage(name, text) {
  const div = document.createElement('div');
  div.className = 'chat-message';
  const strong = document.createElement('strong');
  strong.textContent = `${name}: `;
  const span = document.createElement('span');
  span.textContent = text;
  div.appendChild(strong);
  div.appendChild(span);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showConfirm(message) {
  return new Promise((resolve) => {
    confirmMsg.textContent = message;
    confirmOverlay.classList.remove('hidden');
    const cleanup = (result) => {
      confirmOverlay.classList.add('hidden');
      confirmOk.removeEventListener('click', onOk);
      confirmCancel.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    confirmOk.addEventListener('click', onOk);
    confirmCancel.addEventListener('click', onCancel);
  });
}

function applyRoleUI() {
  const canControl = role === 'host' || role === 'moderator';
  videoControls.style.display = canControl ? '' : 'none';
}

// ── participants list ─────────────────────────────────────────────────────────
const ROLE_COLORS = {
  host:        '#f59e0b',
  moderator:   '#3b82f6',
  participant: '#22c55e',
  viewer:      '#94a3b8'
};

function setParticipants(users) {
  userList.innerHTML = '';
  if (!Array.isArray(users)) return;

  users.forEach((user) => {
    const li = document.createElement('li');
    li.className = 'participant-item';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = user.name;
    nameSpan.className = 'participant-name';

    const badge = document.createElement('span');
    badge.className = 'role-badge';
    badge.textContent = user.role;
    badge.style.background = ROLE_COLORS[user.role] || '#94a3b8';

    li.appendChild(nameSpan);
    li.appendChild(badge);

    // Host-only controls — don't show for self or other hosts
    if (role === 'host' && user.id !== userId && user.role !== 'host') {
      const actions = document.createElement('div');
      actions.className = 'participant-actions';

      // Role toggle button
      const roleBtn = document.createElement('button');
      roleBtn.className = 'btn-small secondary';
      roleBtn.textContent = user.role === 'moderator' ? 'Demote' : 'Promote';
      roleBtn.title = user.role === 'moderator' ? 'Demote to Participant' : 'Promote to Moderator';
      roleBtn.addEventListener('click', () => assignRole(user.id, user.role === 'moderator' ? 'participant' : 'moderator'));

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-small danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeParticipant(user.id, user.name));

      // Transfer host button
      const transferBtn = document.createElement('button');
      transferBtn.className = 'btn-small warning';
      transferBtn.textContent = 'Make Host';
      transferBtn.addEventListener('click', () => transferHost(user.id, user.name));

      actions.appendChild(roleBtn);
      actions.appendChild(removeBtn);
      actions.appendChild(transferBtn);
      li.appendChild(actions);
    }

    userList.appendChild(li);
  });
}

// ── host actions ──────────────────────────────────────────────────────────────
async function assignRole(targetUserId, newRole) {
  const ok = await showConfirm(`Change this user's role to "${newRole}"?`);
  if (!ok) return;
  socket.emit('role:assign', { targetUserId, newRole });
}

async function removeParticipant(targetUserId, name) {
  const ok = await showConfirm(`Remove "${name}" from the room?`);
  if (!ok) return;
  socket.emit('participant:remove', { targetUserId });
}

async function transferHost(targetUserId, name) {
  const ok = await showConfirm(`Transfer host to "${name}"? You will become a participant.`);
  if (!ok) return;
  socket.emit('host:transfer', { targetUserId });
}

// ── auth + room join ──────────────────────────────────────────────────────────
async function joinRoom(requestedRole) {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();
  if (!name) { updateStatus('Please enter your name.', true); nameInput.focus(); return; }
  if (!room)  { updateStatus('Please enter a room code.', true); roomInput.focus(); return; }

  currentUser = name;
  roomCode    = room;
  localStorage.setItem('watchName', name);
  localStorage.setItem('watchRoom', room);

  updateStatus('Authenticating...');

  try {
    // 1. get JWT
    const authRes = await fetch('/api/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const authData = await authRes.json();
    if (!authRes.ok) { updateStatus(authData.error || 'Auth failed', true); return; }
    authToken = authData.token;
    userId    = authData.userId;

    // 2. create or join room
    if (requestedRole === 'host') {
      const createRes = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ roomCode: room })
      });
      if (!createRes.ok && createRes.status !== 409) {
        const e = await createRes.json();
        updateStatus(e.error || 'Failed to create room', true);
        return;
      }
    }

    const joinRes = await fetch(`/api/rooms/${room}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }
    });
    const joinData = await joinRes.json();
    if (!joinRes.ok) { updateStatus(joinData.error || 'Failed to join room', true); return; }

    role = joinData.role;
    applyRoleUI();

    // 3. connect via socket
    socket.emit('join-room', { roomCode: room, token: authToken });
    updateStatus(`Joining room "${room}" as ${role}...`);
  } catch (err) {
    updateStatus('Network error. Is the server running?', true);
    console.error(err);
  }
}

// ── video sync ────────────────────────────────────────────────────────────────
function sendVideoSync() {
  if (!CAN_CONTROL() || !isReady || !player || !currentVideoId) return;
  let time = 0, playing = false;
  try {
    time    = player.getCurrentTime() || 0;
    playing = player.getPlayerState() === YT.PlayerState.PLAYING;
  } catch { return; }
  socket.emit('video-state', { videoId: currentVideoId, title: currentVideoId, time, playing });
}

function CAN_CONTROL() { return role === 'host' || role === 'moderator'; }

function applyVideoState(state) {
  if (!state || !state.videoId) return;
  if (!isReady || !player) { pendingVideoState = state; return; }

  const videoChanged = currentVideoId !== state.videoId;
  currentVideoId = state.videoId;
  videoInput.value = `https://www.youtube.com/watch?v=${state.videoId}`;

  if (videoChanged) {
    if (state.playing) {
      player.loadVideoById({ videoId: state.videoId, startSeconds: Math.max(0, Number(state.time) || 0) });
    } else {
      player.cueVideoById({ videoId: state.videoId, startSeconds: Math.max(0, Number(state.time) || 0) });
    }
    return;
  }

  try {
    const cur = player.getCurrentTime() || 0;
    const tgt = Math.max(0, Number(state.time) || 0);
    if (Math.abs(cur - tgt) > 2) player.seekTo(tgt, true);
    state.playing ? player.playVideo() : player.pauseVideo();
  } catch (err) { console.error('Sync error:', err); }
}

function loadVideoFromInput() {
  if (!CAN_CONTROL()) { updateStatus('Only host/moderator can load a video.', true); return; }
  const videoId = extractVideoId(videoInput.value);
  if (!videoId) { updateStatus('Please enter a valid YouTube URL.', true); return; }
  if (!isReady || !player) { updateStatus('YouTube player is not ready yet.', true); return; }

  currentVideoId = videoId;
  localStorage.setItem('watchVideo', videoInput.value.trim());

  player.cueVideoById({ videoId, startSeconds: 0 });
  socket.emit('playback:changeVideo', { videoId, title: videoId });
  socket.emit('video-state', { videoId, title: videoId, time: 0, playing: false });
  updateStatus('Video loaded. Press Play to start.');
}

function togglePlayback() {
  if (!CAN_CONTROL()) { updateStatus('Only host/moderator can control playback.', true); return; }
  if (!isReady || !player) { updateStatus('YouTube player is not ready yet.', true); return; }
  if (!currentVideoId)    { updateStatus('Please load a video first.', true); return; }

  const state = player.getPlayerState();
  if (state === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  } else {
    player.playVideo();
  }
}

function onPlayerStateChange(event) {
  if (!CAN_CONTROL()) return;
  if (event.data === YT.PlayerState.PLAYING) {
    const t = player.getCurrentTime() || 0;
    socket.emit('playback:play', { time: t });
    socket.emit('video-state', { videoId: currentVideoId, title: currentVideoId, time: t, playing: true });
  } else if (event.data === YT.PlayerState.PAUSED) {
    const t = player.getCurrentTime() || 0;
    socket.emit('playback:pause', { time: t });
    socket.emit('video-state', { videoId: currentVideoId, title: currentVideoId, time: t, playing: false });
  }
}

// ── YouTube player init ───────────────────────────────────────────────────────
function initPlayer() {
  player = new YT.Player('player', {
    height: '100%',
    width:  '100%',
    playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1 },
    events: {
      onReady: () => {
        isReady = true;
        updateStatus('Ready. Join a room to begin.');
        if (pendingVideoState) {
          const s = pendingVideoState;
          pendingVideoState = null;
          applyVideoState(s);
        }
      },
      onStateChange: onPlayerStateChange,
      onError: (e) => updateStatus(`YouTube player error: ${e.data}`, true)
    }
  });
}

window.onYouTubeIframeAPIReady = initPlayer;

// ── button events ─────────────────────────────────────────────────────────────
hostBtn.addEventListener('click',       () => joinRoom('host'));
viewerBtn.addEventListener('click',     () => joinRoom('viewer'));
loadVideoBtn.addEventListener('click',  loadVideoFromInput);
togglePlayBtn.addEventListener('click', togglePlayback);
videoInput.addEventListener('keydown',  (e) => { if (e.key === 'Enter') loadVideoFromInput(); });

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!socket.connected) { updateStatus('Not connected.', true); return; }
  socket.emit('room-chat', { text });
  chatInput.value = '';
}
sendChatBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });

// ── socket events ─────────────────────────────────────────────────────────────
socket.on('connect',       () => updateStatus('Connected. Join a room to begin.'));
socket.on('disconnect',    () => updateStatus('Disconnected. Reconnecting...', true));
socket.on('connect_error', () => updateStatus('Server connection failed.', true));

socket.on('room-state', (state) => {
  if (state.role) { role = state.role; applyRoleUI(); }
  updateStatus(`Joined room "${roomCode}" as ${role}.`);
  if (state && state.videoId) applyVideoState(state);
});

socket.on('join-error', (msg) => updateStatus(msg || 'Unable to join room.', true));

socket.on('participants:update', (users) => setParticipants(users));

// legacy user-list fallback
socket.on('user-list', (users) => {
  if (Array.isArray(users)) setParticipants(users.map(u => ({ ...u, id: u.id || 0 })));
});

socket.on('room-chat', (msg) => {
  if (msg) addChatMessage(msg.name || 'Guest', msg.text || '');
});

// new granular playback events
socket.on('playback:play',        ({ time } = {}) => { if (!CAN_CONTROL()) { try { if (time != null) player.seekTo(time, true); player.playVideo(); } catch {} } });
socket.on('playback:pause',       ({ time } = {}) => { if (!CAN_CONTROL()) { try { if (time != null) player.seekTo(time, true); player.pauseVideo(); } catch {} } });
socket.on('playback:seek',        ({ time } = {}) => { if (!CAN_CONTROL()) { try { player.seekTo(time, true); } catch {} } });
socket.on('playback:changeVideo', (data)          => { if (!CAN_CONTROL()) applyVideoState({ ...data, time: 0, playing: false }); });

// legacy video-state (preserved for backward compat)
socket.on('video-state', (state) => { if (!CAN_CONTROL()) applyVideoState(state); });

socket.on('role:updated', ({ role: newRole } = {}) => {
  role = newRole;
  applyRoleUI();
  updateStatus(`Your role is now: ${newRole}`);
});

socket.on('participant:removed', ({ reason } = {}) => {
  updateStatus(reason || 'You were removed from the room.', true);
  roomCode = null;
});

socket.on('host:transferred', ({ newHostId } = {}) => {
  if (newHostId === userId) {
    role = 'host';
    applyRoleUI();
    updateStatus('You are now the host!');
  }
});

// ── periodic host sync (preserved) ───────────────────────────────────────────
setInterval(() => {
  if (CAN_CONTROL() && isReady && currentVideoId) sendVideoSync();
}, 3000);

window.addEventListener('beforeunload', () => socket.disconnect());

// initial message
addChatMessage('System', 'Welcome to the VibeRoom room to begin.');
