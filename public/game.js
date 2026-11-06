/* ── WebUNO client ── */

const socket = io();

// ── State ─────────────────────────────────────────────────────
let myId          = null;
let myName        = '';
let roomCode      = null;
let roomState     = null;
let myHand        = [];
let pendingWild   = null;   // card awaiting color choice
let awaitDrawPlay = false;  // drew a playable card; can play or pass

// ── Helpers ───────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function toast(msg, type = '', ms = 2800) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── Socket lifecycle ──────────────────────────────────────────
socket.on('connect', () => {
  myId = socket.id;
  // Handle /join/CODE URL
  const m = location.pathname.match(/^\/join\/([A-Z0-9]{4,8})$/i);
  if (m) {
    $('join-code').value = m[1].toUpperCase();
    show('s-join');
  }
});

socket.on('disconnect', () => toast('Disconnected', 'err'));

socket.on('error', ({ message }) => toast(message, 'err'));

// ── Room events ───────────────────────────────────────────────
socket.on('room_created', ({ code }) => {
  roomCode = code;
  show('s-lobby');
  fetchInvite(code);
  history.replaceState({}, '', '/');
});

socket.on('room_joined', ({ code }) => {
  roomCode = code;
  show('s-lobby');
  fetchInvite(code);
  history.replaceState({}, '', '/');
});

socket.on('room_update', state => {
  roomState = state;
  if (state.status === 'waiting') renderLobby(state);
  else if (state.status === 'playing') renderGame(state);
  // 'finished' handled by game_over event; renderGame keeps board visible until then
});

socket.on('hand_update', ({ hand }) => {
  myHand = hand;
  if (roomState?.status === 'playing') renderHand();
});

socket.on('game_started', () => {
  awaitDrawPlay = false;
  pendingWild   = null;
  show('s-game');
});

socket.on('can_play_drawn', ({ card }) => {
  awaitDrawPlay = true;
  // hand_update arrives with the new card already included;
  // renderHand will highlight only that card
  renderHand();
  $('btn-pass').style.display = 'inline-flex';
  toast('Tap the drawn card to play it, or pass');
});

socket.on('cards_drawn', ({ playerName, count }) => {
  if (playerName !== myName)
    toast(`${playerName} drew ${count} card${count > 1 ? 's' : ''}`);
});

socket.on('card_played', ({ playerName, card }) => {
  if (playerName !== myName)
    toast(`${playerName} played ${cardLabel(card)}`);
});

socket.on('uno_called',       ({ playerName }) => toast(`${playerName} — UNO! 🃏`, 'ok'));
socket.on('uno_caught',       ({ catcherName, targetName }) =>
  toast(`${catcherName} caught ${targetName}! +2 cards`, 'err'));
socket.on('player_disconnected', ({ playerName }) =>
  toast(`${playerName} disconnected`, 'err'));

socket.on('return_to_lobby', () => {
  awaitDrawPlay = false;
  pendingWild   = null;
  show('s-lobby');
  fetchInvite(roomCode);
});

socket.on('game_over', ({ winnerId, winnerName, points, scores }) => {
  show('s-gameover');

  $('go-winner').innerHTML =
    `<span>${esc(winnerName)}</span> wins!<br>` +
    `<small style="font-size:14px;color:var(--muted)">+${points} pts</small>`;

  const sb = $('go-scores');
  sb.innerHTML = '';
  [...scores].sort((a,b) => b.score - a.score).forEach((s, i) => {
    const r = document.createElement('div');
    r.className = 'score-row' + (i === 0 ? ' top' : '');
    r.innerHTML = `<span>${i+1}. ${esc(s.name)}</span><span>${s.score}</span>`;
    sb.appendChild(r);
  });

  $('go-host-btn').style.display = roomState?.host === myId ? 'block' : 'none';
});

// ═══════════════════════════════════════════════════════════════
//  HOME
// ═══════════════════════════════════════════════════════════════
$('btn-create').onclick     = () => { show('s-create'); $('create-name').focus(); };
$('btn-join-home').onclick  = () => { show('s-join');   $('join-name').focus();   };
$('btn-create-back').onclick = () => show('s-home');
$('btn-join-back').onclick   = () => show('s-home');

// ── Create ─────────────────────────────────────────────────────
$('btn-create-confirm').onclick = doCreate;
$('create-name').addEventListener('keydown', e => e.key === 'Enter' && doCreate());

function doCreate() {
  const name = $('create-name').value.trim();
  if (!name) { toast('Enter your name', 'err'); return; }
  myName = name;
  socket.emit('create_room', { name });
}

// ── Join ───────────────────────────────────────────────────────
$('btn-join-confirm').onclick = doJoin;
$('join-code').addEventListener('keydown', e => e.key === 'Enter' && doJoin());
$('join-name').addEventListener('keydown', e => e.key === 'Enter' && doJoin());
$('join-code').addEventListener('input', function() {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function doJoin() {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  if (!name)          { toast('Enter your name', 'err'); return; }
  if (code.length < 4){ toast('Enter the room code', 'err'); return; }
  myName = name;
  socket.emit('join_room', { name, code });
}

// ═══════════════════════════════════════════════════════════════
//  LOBBY
// ═══════════════════════════════════════════════════════════════
const PCOLORS = ['#e63946','#2a9d5c','#3b82f6','#f59e0b','#8b5cf6','#f97316'];

function renderLobby(state) {
  $('lcode').textContent = state.code;

  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `
      <div class="p-avatar" style="background:${PCOLORS[i % PCOLORS.length]}">${esc(p.name[0].toUpperCase())}</div>
      <span class="p-name">${esc(p.name)}${p.id === myId ? '<span class="p-you">(you)</span>' : ''}</span>
      ${p.id === state.host ? '<span class="p-host">host</span>' : ''}
    `;
    list.appendChild(div);
  });

  const isHost = state.host === myId;
  $('host-section').style.display  = isHost ? 'flex' : 'none';
  $('guest-section').style.display = isHost ? 'none' : 'block';

  if (isHost) {
    const n   = state.players.length;
    const btn = $('btn-start');
    btn.disabled = n < 2;
    $('lobby-hint').textContent =
      n >= 6 ? 'Room full — ready!' :
      n >= 2 ? `${n}/6 players — ready to start` :
               `Waiting for players… ${n}/6`;
  }
}

async function fetchInvite(code) {
  $('lcode').textContent = code;

  $('btn-copy-code').onclick = () =>
    navigator.clipboard.writeText(code)
      .then(() => toast('Code copied', 'ok'));

  try {
    const res  = await fetch(`/api/qr/${code}`);
    const data = await res.json();
    $('qr-img').src           = data.qr;
    $('invite-link').value    = data.url;
    $('btn-copy-link').onclick = () =>
      navigator.clipboard.writeText(data.url)
        .then(() => toast('Link copied', 'ok'));
  } catch { /* QR unavailable */ }
}

$('btn-start').onclick = () => socket.emit('start_game');

// ═══════════════════════════════════════════════════════════════
//  GAME
// ═══════════════════════════════════════════════════════════════

function renderGame(state) {
  renderOpponents(state);
  renderDiscard(state);
  renderStatus(state);
  renderHand();
  updateDrawPile(state);
}

// ── Opponents ──────────────────────────────────────────────────
function renderOpponents(state) {
  const area = $('opp-area');
  area.innerHTML = '';
  state.players.filter(p => p.id !== myId).forEach(p => {
    const isActive = state.players[state.currentPlayerIndex]?.id === p.id;
    const div = document.createElement('div');
    div.className = `opp-slot${isActive ? ' active' : ''}${!p.connected ? ' offline' : ''}`;

    const show = Math.min(p.handCount, 6);
    let minis = '<div class="opp-minis">';
    for (let i = 0; i < show; i++) minis += '<div class="mini-card"></div>';
    minis += '</div>';

    // Catch UNO button: show when player has 1 card, hasn't called UNO, and it's NOT their turn
    const canCatch = p.handCount === 1 && !p.saidUno && !isActive;
    const catchHtml = canCatch
      ? `<button class="catch-btn" onclick="catchUno('${p.id}')">Catch UNO</button>`
      : '';

    div.innerHTML = `
      <span class="opp-name">${esc(p.name)}</span>
      ${minis}
      <span class="opp-count">${p.handCount}</span>
      ${p.saidUno ? '<span class="uno-tag">UNO!</span>' : ''}
      ${catchHtml}
    `;
    area.appendChild(div);
  });
}

// ── Discard pile ───────────────────────────────────────────────
function renderDiscard(state) {
  const el = $('discard-pile');
  if (!state.topCard) { el.className = 'card'; el.innerHTML = ''; return; }
  const col = state.currentColor || state.topCard.color;
  el.className = `card c-${col}`;
  el.innerHTML = cardFaceHtml(state.topCard);
}

// ── Status row ─────────────────────────────────────────────────
function renderStatus(state) {
  $('st-dir').textContent = state.direction === 1 ? '↻' : '↺';

  const dot = $('st-color');
  dot.className = `cdot ${state.currentColor || 'wild'}`;

  const turnEl  = $('st-turn');
  const current = state.players[state.currentPlayerIndex];
  if (!current) return;
  if (current.id === myId) {
    turnEl.textContent = 'Your turn';
    turnEl.className   = 'my-turn';
  } else {
    turnEl.textContent = `${current.name}'s turn`;
    turnEl.className   = '';
  }
}

// ── Draw pile ──────────────────────────────────────────────────
function updateDrawPile(state) {
  const isMyTurn = state.players[state.currentPlayerIndex]?.id === myId;
  const dp = $('draw-pile');
  dp.style.opacity = isMyTurn ? '1' : '0.5';
  dp.style.cursor  = isMyTurn ? 'pointer' : 'default';

  const lbl = $('draw-label');
  lbl.textContent = state.drawStack > 0 ? `+${state.drawStack}` : 'DRAW';
}

$('draw-pile').onclick = () => {
  if (!roomState || roomState.status !== 'playing') return;
  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  if (!isMyTurn)    { toast("Not your turn", 'err', 1500); return; }
  if (awaitDrawPlay){ return; } // must play or pass the drawn card first
  socket.emit('draw_card');
};

// ── My hand ─────────────────────────────────────────────────────
function renderHand() {
  const container = $('my-hand');
  container.innerHTML = '';
  if (!roomState) return;

  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  const topCard  = roomState.topCard;

  myHand.forEach(card => {
    let playable = false;
    if (isMyTurn) {
      if (awaitDrawPlay) {
        // Only the most recently drawn card is eligible — last card in hand
        // Server sends can_play_drawn with the card; we match by id
        playable = card.id === _drawnCardId;
      } else {
        playable = clientCanPlay(card, topCard, roomState.currentColor, roomState.drawStack);
      }
    }

    const el = document.createElement('div');
    el.className = `hand-card c-${card.color}${playable ? ' playable' : ' dim'}`;
    el.innerHTML  = cardFaceHtml(card);
    el.title      = cardLabel(card);
    if (playable) el.onclick = () => handlePlay(card);
    container.appendChild(el);
  });

  // UNO button
  const me = roomState.players.find(p => p.id === myId);
  $('btn-uno').style.display =
    (myHand.length === 1 && isMyTurn && me && !me.saidUno) ? 'inline-flex' : 'none';
}

// Track which card was drawn (set by can_play_drawn)
let _drawnCardId = null;
socket.on('can_play_drawn', ({ card }) => { _drawnCardId = card.id; });

function clientCanPlay(card, topCard, currentColor, drawStack) {
  if (!topCard) return true;
  if (drawStack > 0) {
    if (topCard.value === 'draw2'      && card.value !== 'draw2')      return false;
    if (topCard.value === 'wild_draw4' && card.value !== 'wild_draw4') return false;
  }
  if (card.value === 'wild' || card.value === 'wild_draw4') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function handlePlay(card) {
  if (card.value === 'wild' || card.value === 'wild_draw4') {
    pendingWild = card;
    $('color-picker').style.display = 'flex';
    return;
  }
  socket.emit('play_card', { cardId: card.id, chosenColor: null });
  awaitDrawPlay = false;
  _drawnCardId  = null;
  $('btn-pass').style.display = 'none';
}

// Color picker
document.querySelectorAll('.cbtn').forEach(btn => {
  btn.onclick = () => {
    if (!pendingWild) return;
    socket.emit('play_card', { cardId: pendingWild.id, chosenColor: btn.dataset.color });
    pendingWild   = null;
    awaitDrawPlay = false;
    _drawnCardId  = null;
    $('btn-pass').style.display    = 'none';
    $('color-picker').style.display = 'none';
  };
});

// Pass button
$('btn-pass').onclick = () => {
  socket.emit('pass_turn');
  awaitDrawPlay = false;
  _drawnCardId  = null;
  $('btn-pass').style.display = 'none';
};

// UNO button
$('btn-uno').onclick = () => socket.emit('say_uno');

// Catch UNO (called from inline onclick)
function catchUno(targetId) { socket.emit('catch_uno', { targetId }); }
window.catchUno = catchUno;

// ── Game over ──────────────────────────────────────────────────
$('btn-play-again').onclick = () => socket.emit('play_again');
$('btn-go-home').onclick    = () => { location.href = '/'; };

// ═══════════════════════════════════════════════════════════════
//  Card rendering
// ═══════════════════════════════════════════════════════════════
function cardFaceHtml(card) {
  const lbl = cardLabel(card);
  return `<span class="cv tl">${lbl}</span>
          <span class="cc">${cardSymbol(card)}</span>
          <span class="cv br">${lbl}</span>`;
}

function cardLabel(card) {
  switch (card.value) {
    case 'skip':       return '⊘';
    case 'reverse':    return '↺';
    case 'draw2':      return '+2';
    case 'wild':       return 'W';
    case 'wild_draw4': return '+4';
    default:           return card.value;
  }
}

function cardSymbol(card) {
  switch (card.value) {
    case 'skip':       return '⊘';
    case 'reverse':    return '↺';
    case 'draw2':      return '+2';
    case 'wild':       return '●';
    case 'wild_draw4': return '+4';
    default:           return card.value;
  }
}
