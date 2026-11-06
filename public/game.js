/* ═══════════════════════════════════════════════════════════════
   WebUNO – Client Game Logic
═══════════════════════════════════════════════════════════════ */

const socket = io();

// ── State ──────────────────────────────────────────────────────
let myId        = null;
let myName      = null;
let roomCode    = null;
let roomState   = null;      // latest room_update payload
let myHand      = [];
let pendingWild = null;      // card waiting for color pick
let canPlayDrawn = false;    // after drawing 1 card, can optionally play it
let drawnCard    = null;     // the card drawn

// ── Screen Router ──────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// ── Toast ──────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Socket ID ─────────────────────────────────────────────────
socket.on('connect', () => {
  myId = socket.id;
  // Auto-join from URL if path is /join/CODE
  const m = location.pathname.match(/^\/join\/([A-Z0-9]{4,8})$/i);
  if (m) {
    const code = m[1].toUpperCase();
    document.getElementById('join-code').value = code;
    showScreen('join');
  }
});

socket.on('disconnect', () => {
  toast('Disconnected from server', 'error');
});

// ── Server Events ─────────────────────────────────────────────

socket.on('room_created', ({ code }) => {
  roomCode = code;
  showScreen('lobby');
  loadLobbyInvite(code);
  history.replaceState({}, '', '/');
});

socket.on('room_joined', ({ code }) => {
  roomCode = code;
  showScreen('lobby');
  loadLobbyInvite(code);
  history.replaceState({}, '', '/');
});

socket.on('room_update', (state) => {
  roomState = state;
  if (state.status === 'waiting') renderLobby(state);
  else if (state.status === 'playing') renderGame(state);
  else if (state.status === 'finished') renderGame(state);
});

socket.on('hand_update', ({ hand }) => {
  myHand = hand;
  if (roomState && roomState.status === 'playing') renderMyHand();
});

socket.on('game_started', () => {
  canPlayDrawn = false;
  drawnCard = null;
  showScreen('game');
});

socket.on('card_played', ({ playerName, card, currentColor }) => {
  // Visual feedback already handled by room_update
});

socket.on('cards_drawn', ({ playerName, count }) => {
  if (playerName !== myName) {
    toast(`${playerName} drew ${count} card${count > 1 ? 's' : ''}`, 'info', 2000);
  }
});

socket.on('can_play_drawn', ({ card }) => {
  canPlayDrawn = true;
  drawnCard = card;
  renderMyHand();
  showPassButton(true);
  toast('You drew a playable card — play it or pass', 'info');
});

socket.on('uno_called', ({ playerName }) => {
  toast(`${playerName} called UNO! 🃏`, 'info', 2500);
});

socket.on('uno_caught', ({ catcherName, targetName }) => {
  toast(`${catcherName} caught ${targetName} — 2 card penalty! 😬`, 'error', 3000);
});

socket.on('player_disconnected', ({ playerName }) => {
  toast(`${playerName} disconnected`, 'error', 3500);
});

socket.on('return_to_lobby', () => {
  canPlayDrawn = false;
  drawnCard = null;
  showScreen('lobby');
  loadLobbyInvite(roomCode);
});

socket.on('game_over', ({ winnerId, winnerName, points, scores }) => {
  showGameOver(winnerId, winnerName, points, scores);
});

socket.on('error', ({ message }) => {
  toast(message, 'error');
});

// ═══════════════════════════════════════════════════════════════
//  HOME SCREEN
// ═══════════════════════════════════════════════════════════════

document.getElementById('btn-create').addEventListener('click', () => {
  showScreen('create');
  document.getElementById('create-name').focus();
});

document.getElementById('btn-join-home').addEventListener('click', () => {
  showScreen('join');
  document.getElementById('join-name').focus();
});

document.getElementById('btn-create-back').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-join-back').addEventListener('click', () => showScreen('home'));

// ── Create Room ────────────────────────────────────────────────

document.getElementById('btn-create-confirm').addEventListener('click', createRoom);
document.getElementById('create-name').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });

function createRoom() {
  const name = document.getElementById('create-name').value.trim();
  if (!name) { toast('Enter your name', 'error'); return; }
  myName = name;
  socket.emit('create_room', { name });
}

// ── Join Room ──────────────────────────────────────────────────

document.getElementById('btn-join-confirm').addEventListener('click', joinRoom);
document.getElementById('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
document.getElementById('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

// Force uppercase in room code input
document.getElementById('join-code').addEventListener('input', function() {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function joinRoom() {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) { toast('Enter your name', 'error'); return; }
  if (code.length < 4) { toast('Enter a valid room code', 'error'); return; }
  myName = name;
  socket.emit('join_room', { code, name });
}

// ═══════════════════════════════════════════════════════════════
//  LOBBY
// ═══════════════════════════════════════════════════════════════

const AVATAR_COLORS = ['#e63946','#2a9d5c','#2196f3','#ffc300','#9c27b0','#ff5722'];

function renderLobby(state) {
  document.getElementById('lobby-code').textContent = state.code;

  // Players list
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    const initial = p.name.charAt(0).toUpperCase();
    const avatarColor = AVATAR_COLORS[i % AVATAR_COLORS.length];
    div.innerHTML = `
      <div class="player-avatar" style="background:${avatarColor}">${initial}</div>
      <span class="player-name">${escHtml(p.name)} ${p.id === myId ? '<span style="font-size:11px;color:var(--muted)">(you)</span>' : ''}</span>
      ${p.id === state.host ? '<span class="player-badge">HOST</span>' : ''}
    `;
    list.appendChild(div);
  });

  // Host controls
  const isHost = state.host === myId;
  document.getElementById('lobby-host-controls').style.display = isHost ? 'block' : 'none';
  document.getElementById('lobby-guest-info').style.display = isHost ? 'none' : 'block';

  if (isHost) {
    const enough = state.players.length >= 2;
    const full   = state.players.length >= 6;
    const btn = document.getElementById('btn-start');
    btn.disabled = !enough;
    const hint = document.getElementById('lobby-hint');
    if (full) hint.textContent = 'Room is full (6/6) — ready to start!';
    else if (enough) hint.textContent = `${state.players.length}/6 players — ready to start!`;
    else hint.textContent = `Waiting for more players… (${state.players.length}/6, need at least 2)`;
  }
}

async function loadLobbyInvite(code) {
  document.getElementById('lobby-code').textContent = code;
  document.getElementById('btn-copy-code').onclick = () => {
    navigator.clipboard.writeText(code).then(() => toast('Room code copied!', 'success', 1800));
  };

  try {
    const res = await fetch(`/api/qr/${code}`);
    const data = await res.json();
    document.getElementById('qr-image').src = data.qr;
    document.getElementById('invite-link').value = data.url;
    document.getElementById('btn-copy-link').onclick = () => {
      navigator.clipboard.writeText(data.url).then(() => toast('Link copied!', 'success', 1800));
    };
  } catch (e) {
    console.error('QR fetch failed', e);
  }
}

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_game');
});

// ═══════════════════════════════════════════════════════════════
//  GAME
// ═══════════════════════════════════════════════════════════════

function renderGame(state) {
  renderOpponents(state);
  renderDiscardPile(state);
  renderStatusBar(state);
  renderMyHand();
  updateDrawPile(state);
}

// ── Opponents ─────────────────────────────────────────────────

function renderOpponents(state) {
  const area = document.getElementById('opponents-area');
  area.innerHTML = '';
  const opponents = state.players.filter(p => p.id !== myId);

  opponents.forEach((p, i) => {
    const isActive = state.players[state.currentPlayerIndex]?.id === p.id;
    const slot = document.createElement('div');
    slot.className = `opponent-slot glass${isActive ? ' active-turn' : ''}${!p.connected ? ' disconnected' : ''}`;

    // Show mini cards (max 7 visible)
    const show = Math.min(p.handCount, 7);
    let cardsHtml = '<div class="opp-cards">';
    for (let c = 0; c < show; c++) {
      cardsHtml += '<div class="opp-card-mini"></div>';
    }
    cardsHtml += '</div>';

    const catchBtn = (p.handCount === 1 && !p.saidUno && state.players[state.currentPlayerIndex]?.id !== p.id)
      ? `<button class="btn btn-sm" style="background:#e63946;color:#fff;margin-top:4px;font-size:10px;padding:2px 10px" onclick="catchUno('${p.id}')">Catch!</button>`
      : '';

    slot.innerHTML = `
      <span class="opp-name">${escHtml(p.name)}</span>
      ${cardsHtml}
      <span class="opp-count-badge">${p.handCount} card${p.handCount !== 1 ? 's' : ''}</span>
      ${p.saidUno ? '<span class="uno-badge">UNO!</span>' : ''}
      ${catchBtn}
      ${!p.connected ? '<span style="font-size:10px;color:var(--muted)">offline</span>' : ''}
    `;
    area.appendChild(slot);
  });
}

// ── Discard Pile ──────────────────────────────────────────────

function renderDiscardPile(state) {
  const el = document.getElementById('discard-pile');
  if (!state.topCard) { el.textContent = ''; return; }
  el.className = `discard-card color-${state.currentColor || state.topCard.color}`;
  el.innerHTML = buildCardFace(state.topCard, state.currentColor);
}

// ── Status Bar ────────────────────────────────────────────────

function renderStatusBar(state) {
  const dir = document.getElementById('status-direction');
  dir.textContent = state.direction === 1 ? '↻ CW' : '↺ CCW';

  const dot = document.getElementById('status-color');
  dot.className = `color-dot ${state.currentColor || 'wild'}`;

  const turnEl = document.getElementById('status-turn');
  const current = state.players[state.currentPlayerIndex];
  if (current) {
    if (current.id === myId) {
      turnEl.textContent = 'Your turn!';
      turnEl.style.color = '#ffc300';
    } else {
      turnEl.textContent = `${current.name}'s turn`;
      turnEl.style.color = 'var(--muted)';
    }
  }

  // Draw stack notice
  if (state.drawStack > 0) {
    toast(`Draw stack: +${state.drawStack}`, 'info', 1000);
  }
}

// ── My Hand ───────────────────────────────────────────────────

function renderMyHand() {
  const hand = document.getElementById('my-hand');
  hand.innerHTML = '';
  if (!roomState) return;

  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  const topCard  = roomState.topCard;

  myHand.forEach(card => {
    let playable = false;
    if (isMyTurn) {
      if (canPlayDrawn) {
        // Only the drawn card is playable
        playable = card.id === drawnCard?.id;
      } else {
        playable = canPlayCard(card, topCard, roomState.currentColor, roomState.drawStack);
      }
    }

    const el = document.createElement('div');
    el.className = `uno-card color-${card.color} ${playable ? 'playable' : 'not-playable'}`;
    el.innerHTML = buildCardFace(card, card.color);
    el.title = cardLabel(card);

    if (playable) {
      el.addEventListener('click', () => handlePlayCard(card));
    }
    hand.appendChild(el);
  });

  // UNO button visibility
  const unoBtn = document.getElementById('btn-uno');
  const me = roomState.players.find(p => p.id === myId);
  unoBtn.style.display = (myHand.length === 1 && isMyTurn && me && !me.saidUno) ? 'inline-flex' : 'none';
}

function canPlayCard(card, topCard, currentColor, drawStack) {
  if (!topCard) return true;
  // If draw stack active, can only stack same type
  if (drawStack > 0) {
    if (topCard.value === 'draw2' && card.value !== 'draw2') return false;
    if (topCard.value === 'wild_draw4' && card.value !== 'wild_draw4') return false;
  }
  if (card.value === 'wild' || card.value === 'wild_draw4') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function handlePlayCard(card) {
  if (card.value === 'wild' || card.value === 'wild_draw4') {
    pendingWild = card;
    document.getElementById('color-picker').style.display = 'flex';
    return;
  }
  socket.emit('play_card', { cardId: card.id, chosenColor: null });
  canPlayDrawn = false;
  drawnCard = null;
  showPassButton(false);
}

// Color picker
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!pendingWild) return;
    const color = btn.dataset.color;
    socket.emit('play_card', { cardId: pendingWild.id, chosenColor: color });
    pendingWild = null;
    canPlayDrawn = false;
    drawnCard = null;
    showPassButton(false);
    document.getElementById('color-picker').style.display = 'none';
  });
});

// ── Draw pile click ────────────────────────────────────────────

document.getElementById('draw-pile').addEventListener('click', () => {
  if (!roomState || roomState.status !== 'playing') return;
  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  if (!isMyTurn) { toast("It's not your turn", 'error', 1500); return; }
  if (canPlayDrawn) return; // must play or pass first
  socket.emit('draw_card');
});

function updateDrawPile(state) {
  const isMyTurn = state.players[state.currentPlayerIndex]?.id === myId;
  const dp = document.getElementById('draw-pile');
  if (isMyTurn) {
    dp.style.cursor = 'pointer';
    dp.style.opacity = '1';
  } else {
    dp.style.cursor = 'default';
    dp.style.opacity = '0.6';
  }
  if (state.drawStack > 0) {
    dp.querySelector('span').textContent = `+${state.drawStack}`;
  } else {
    dp.querySelector('span').textContent = 'DRAW';
  }
}

// ── Pass turn ─────────────────────────────────────────────────

function showPassButton(show) {
  document.getElementById('btn-pass').style.display = show ? 'inline-flex' : 'none';
}

document.getElementById('btn-pass').addEventListener('click', () => {
  socket.emit('pass_turn');
  canPlayDrawn = false;
  drawnCard = null;
  showPassButton(false);
});

// ── UNO button ────────────────────────────────────────────────

document.getElementById('btn-uno').addEventListener('click', () => {
  socket.emit('say_uno');
});

// ── Catch UNO ────────────────────────────────────────────────

function catchUno(targetId) {
  socket.emit('catch_uno', { targetId });
}
window.catchUno = catchUno;

// ═══════════════════════════════════════════════════════════════
//  GAME OVER
// ═══════════════════════════════════════════════════════════════

function showGameOver(winnerId, winnerName, points, scores) {
  showScreen('gameover');

  document.getElementById('winner-display').innerHTML = `
    🏆 Winner!<br>
    <span class="winner-name">${escHtml(winnerName)}</span><br>
    <span style="font-size:16px;color:var(--muted)">+${points} points</span>
  `;

  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const sb = document.getElementById('scoreboard');
  sb.innerHTML = '<h3 style="margin-bottom:8px;font-size:16px">Scores</h3>';
  sorted.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = `score-row${s.name === winnerName ? ' winner' : ''}`;
    row.innerHTML = `<span>${i + 1}. ${escHtml(s.name)}</span><span>${s.score} pts</span>`;
    sb.appendChild(row);
  });

  const isHost = roomState?.host === myId;
  document.getElementById('gameover-host-btns').style.display = isHost ? 'block' : 'none';
}

document.getElementById('btn-play-again').addEventListener('click', () => {
  socket.emit('play_again');
});

document.getElementById('btn-gameover-home').addEventListener('click', () => {
  location.href = '/';
});

// ═══════════════════════════════════════════════════════════════
//  CARD RENDERING
// ═══════════════════════════════════════════════════════════════

function buildCardFace(card, displayColor) {
  const label = cardLabel(card);
  return `
    <span class="card-value tl">${label}</span>
    <div class="card-oval"></div>
    <span class="card-center">${cardSymbol(card)}</span>
    <span class="card-value br">${label}</span>
  `;
}

function cardLabel(card) {
  switch (card.value) {
    case 'skip':       return '⊘';
    case 'reverse':    return '↺';
    case 'draw2':      return '+2';
    case 'wild':       return 'W';
    case 'wild_draw4': return 'W+4';
    default:           return card.value;
  }
}

function cardSymbol(card) {
  switch (card.value) {
    case 'skip':       return '⊘';
    case 'reverse':    return '↺';
    case 'draw2':      return '+2';
    case 'wild':       return '🌈';
    case 'wild_draw4': return '+4';
    default:           return card.value;
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Handle /join/:code URLs on load
(function checkJoinUrl() {
  const m = location.pathname.match(/^\/join\/([A-Z0-9]{4,8})$/i);
  if (m) {
    const code = m[1].toUpperCase();
    document.getElementById('join-code').value = code;
    showScreen('join');
  }
})();
