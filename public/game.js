/* ── WebUNO client ── */

const socket = io();

// ── State ─────────────────────────────────────────────────────
let myId          = null;
let myName        = '';
let roomCode      = null;
let roomState     = null;
let myHand        = [];
let pendingWild   = null;
let awaitDrawPlay = false;
let _drawnCardId  = null;
let lastTopCardId = null;

// ── Helpers ───────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const esc = s  => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
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

// ═══════════════════════════════════════════════════════════════
//  URL-BASED JOIN — runs immediately on page load
//  This handles QR code scans and shared links like /join/ABCDEF
// ═══════════════════════════════════════════════════════════════

function getJoinCodeFromUrl() {
  // Match /join/CODE or ?code=CODE or ?room=CODE
  const pathMatch  = location.pathname.match(/\/join\/([A-Z0-9]{4,8})/i);
  const paramCode  = new URLSearchParams(location.search).get('code') ||
                     new URLSearchParams(location.search).get('room');
  return (pathMatch?.[1] || paramCode || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
}

// Called on page load immediately (before socket connects)
(function initFromUrl() {
  const code = getJoinCodeFromUrl();
  if (!code) return;
  // Pre-fill and show join screen right away — no need to wait for socket
  $('join-code').value = code;
  show('s-join');
  $('join-name').focus();
})();

// ── Socket lifecycle ──────────────────────────────────────────
socket.on('connect', () => {
  myId = socket.id;
  // If we're on the join screen (came from QR), ensure code is still filled
  const activeScreen = document.querySelector('.screen.active')?.id;
  if (activeScreen === 's-join') {
    const code = getJoinCodeFromUrl();
    if (code && !$('join-code').value) $('join-code').value = code;
  }
});

socket.on('disconnect', () => toast('Disconnected from server', 'err'));
socket.on('error', ({ message }) => toast(message, 'err'));

// ── Room events ───────────────────────────────────────────────
socket.on('room_created', ({ code }) => {
  roomCode = code;
  history.replaceState({}, '', '/');
  show('s-lobby');
  fetchInvite(code);
});

socket.on('room_joined', ({ code }) => {
  roomCode = code;
  history.replaceState({}, '', '/');
  show('s-lobby');
  fetchInvite(code);
});

socket.on('room_update', state => {
  roomState = state;
  if (state.status === 'waiting') renderLobby(state);
  else if (state.status === 'playing') renderGame(state);
});

socket.on('hand_update', ({ hand }) => {
  myHand = hand;
  if (roomState?.status === 'playing') renderHand();
});

socket.on('game_started', () => {
  awaitDrawPlay = false;
  pendingWild   = null;
  _drawnCardId  = null;
  lastTopCardId = null;
  show('s-game');
});

socket.on('can_play_drawn', ({ card }) => {
  _drawnCardId  = card.id;
  awaitDrawPlay = true;
  renderHand('draw');
  $('btn-pass').style.display = 'inline-flex';
  toast('Play the drawn card or pass');
});

socket.on('cards_drawn', ({ playerName, count }) => {
  if (playerName !== myName)
    toast(`${playerName} drew ${count} card${count > 1 ? 's' : ''}`);
});

socket.on('card_played', ({ playerName, card }) => {
  if (playerName !== myName)
    toast(`${playerName} played ${cardLabel(card)}`);
});

socket.on('uno_called',          ({ playerName }) => toast(`${playerName} — UNO!`, 'ok'));
socket.on('uno_caught',          ({ catcherName, targetName }) =>
  toast(`${catcherName} caught ${targetName}! +2 cards`, 'err'));
socket.on('player_disconnected', ({ playerName }) =>
  toast(`${playerName} disconnected`, 'err'));

socket.on('return_to_lobby', () => {
  awaitDrawPlay = false; pendingWild = null; _drawnCardId = null;
  show('s-lobby');
  fetchInvite(roomCode);
});

socket.on('game_over', ({ winnerName, points, scores }) => {
  show('s-gameover');
  $('go-winner').innerHTML =
    `${esc(winnerName)} wins!<br>` +
    `<small style="font-size:13px;font-family:var(--font-body);color:var(--text2)">+${points} pts</small>`;
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
$('btn-create').onclick      = () => { show('s-create'); $('create-name').focus(); };
$('btn-join-home').onclick   = () => { show('s-join');   $('join-name').focus();   };
$('btn-create-back').onclick = () => show('s-home');
$('btn-join-back').onclick   = () => show('s-home');

// ── Create ────────────────────────────────────────────────────
$('btn-create-confirm').onclick = doCreate;
$('create-name').addEventListener('keydown', e => e.key === 'Enter' && doCreate());

function doCreate() {
  const name = $('create-name').value.trim();
  if (!name) { toast('Enter your name', 'err'); return; }
  myName = name;
  socket.emit('create_room', { name });
}

// ── Join ──────────────────────────────────────────────────────
$('btn-join-confirm').onclick = doJoin;
$('join-code').addEventListener('keydown', e => e.key === 'Enter' && doJoin());
$('join-name').addEventListener('keydown', e => e.key === 'Enter' && doJoin());
$('join-code').addEventListener('input', function() {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function doJoin() {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  if (!name)           { toast('Enter your name', 'err'); return; }
  if (code.length < 4) { toast('Enter the room code', 'err'); return; }
  myName = name;
  socket.emit('join_room', { name, code });
}

// ═══════════════════════════════════════════════════════════════
//  LOBBY
// ═══════════════════════════════════════════════════════════════
const PCOLORS = ['#c0392b','#1a7a3a','#1a4fa0','#b8860b','#7b2d8b','#c05c1a'];

function renderLobby(state) {
  $('lcode').textContent = state.code;
  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `
      <div class="p-avatar" style="background:${PCOLORS[i % PCOLORS.length]}">${esc(p.name[0].toUpperCase())}</div>
      <span class="p-name">${esc(p.name)}${p.id === myId ? '<span class="p-you"> (you)</span>' : ''}</span>
      ${p.id === state.host ? '<span class="p-host">Host</span>' : ''}
    `;
    list.appendChild(div);
  });

  const isHost = state.host === myId;
  $('host-section').style.display  = isHost ? 'flex' : 'none';
  $('guest-section').style.display = isHost ? 'none' : 'block';

  if (isHost) {
    const n = state.players.length;
    $('btn-start').disabled = n < 2;
    $('lobby-hint').textContent =
      n >= 6 ? 'Room full — ready to start!' :
      n >= 2 ? `${n}/6 players — ready to start` :
               `Waiting for players… ${n}/6 (need 2+)`;
  }
}

async function fetchInvite(code) {
  $('lcode').textContent = code;
  $('btn-copy-code').onclick = () =>
    navigator.clipboard.writeText(code).then(() => toast('Code copied', 'ok'));

  try {
    const r = await fetch(`/api/qr/${code}`);
    const d = await r.json();
    $('qr-img').src = d.qr;
    $('invite-link').value = d.url;
    $('btn-copy-link').onclick = () =>
      navigator.clipboard.writeText(d.url).then(() => toast('Link copied', 'ok'));
  } catch { /* QR unavailable */ }
}

$('btn-start').onclick = () => socket.emit('start_game');

// Leave lobby
$('btn-leave-lobby').onclick = () => {
  socket.disconnect();
  myId = null; myName = ''; roomCode = null; roomState = null;
  show('s-home');
  // Reconnect for future use
  socket.connect();
};

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

// ── Opponents ─────────────────────────────────────────────────
function renderOpponents(state) {
  const area = $('opp-area');
  area.innerHTML = '';
  state.players.filter(p => p.id !== myId).forEach(p => {
    const isActive = state.players[state.currentPlayerIndex]?.id === p.id;
    const div = document.createElement('div');
    div.className = `opp-slot${isActive ? ' active' : ''}${!p.connected ? ' offline' : ''}`;

    const showCards = Math.min(p.handCount, 7);
    let minis = '<div class="opp-minis">';
    for (let i = 0; i < showCards; i++) minis += '<div class="mini-card"></div>';
    minis += '</div>';

    const canCatch = p.handCount === 1 && !p.saidUno && !isActive;
    div.innerHTML = `
      <span class="opp-name">${esc(p.name)}</span>
      ${minis}
      <span class="opp-count">${p.handCount}</span>
      ${p.saidUno ? '<span class="uno-tag">UNO!</span>' : ''}
      ${canCatch ? `<button class="catch-btn" onclick="catchUno('${p.id}')">Catch!</button>` : ''}
    `;
    area.appendChild(div);
  });
}

// ── Discard ───────────────────────────────────────────────────
function renderDiscard(state) {
  const wrap = $('discard-wrap');
  if (!state.topCard) { wrap.innerHTML = ''; lastTopCardId = null; return; }

  const isNew = state.topCard.id !== lastTopCardId;
  lastTopCardId = state.topCard.id;

  const col = state.currentColor || state.topCard.color;
  const el  = buildCard(state.topCard, col);
  el.style.position = 'absolute';
  if (isNew) el.classList.add('flip-in');

  wrap.innerHTML = '';
  wrap.appendChild(el);
}

// ── Status ────────────────────────────────────────────────────
function renderStatus(state) {
  $('st-dir').textContent = state.direction === 1 ? '↻' : '↺';
  $('st-color').className = `cdot ${state.currentColor || 'wild'}`;

  const cur = state.players[state.currentPlayerIndex];
  const el  = $('st-turn');
  if (!cur) return;
  if (cur.id === myId) {
    el.textContent = 'Your turn';
    el.className   = 'my-turn';
  } else {
    el.textContent = `${cur.name}'s turn`;
    el.className   = '';
  }
}

// ── Draw pile ─────────────────────────────────────────────────
function updateDrawPile(state) {
  const isMyTurn = state.players[state.currentPlayerIndex]?.id === myId;
  const dp = $('draw-pile');
  dp.style.opacity = isMyTurn ? '1' : '0.4';
  dp.style.cursor  = isMyTurn ? 'pointer' : 'default';
  $('draw-label').textContent = state.drawStack > 0 ? `+${state.drawStack}` : 'DRAW';
}

$('draw-pile').onclick = () => {
  if (!roomState || roomState.status !== 'playing') return;
  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  if (!isMyTurn)    { toast("Not your turn", 'err', 1500); return; }
  if (awaitDrawPlay){ return; }
  socket.emit('draw_card');
};

// ── My hand ───────────────────────────────────────────────────
function renderHand(mode = '') {
  const container = $('my-hand');
  container.innerHTML = '';
  if (!roomState) return;

  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  const topCard  = roomState.topCard;

  myHand.forEach((card, idx) => {
    let playable = false;
    if (isMyTurn) {
      playable = awaitDrawPlay
        ? card.id === _drawnCardId
        : clientCanPlay(card, topCard, roomState.currentColor, roomState.drawStack);
    }

    const wrap = document.createElement('div');
    wrap.className = `hcard-wrap ${playable ? 'playable' : 'dim'}`;
    wrap.style.animationDelay = `${idx * 30}ms`;
    if (mode === 'draw' && idx === myHand.length - 1)
      wrap.classList.add('draw-anim');

    const el = buildCard(card, card.color);
    wrap.appendChild(el);
    if (playable) wrap.onclick = () => handlePlay(card);
    container.appendChild(wrap);
  });

  const me = roomState.players.find(p => p.id === myId);
  $('btn-uno').style.display =
    (myHand.length === 1 && isMyTurn && me && !me.saidUno) ? 'inline-flex' : 'none';
}

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
  awaitDrawPlay = false; _drawnCardId = null;
  $('btn-pass').style.display = 'none';
}

// Color picker
document.querySelectorAll('.cbtn').forEach(btn => {
  btn.onclick = () => {
    if (!pendingWild) return;
    socket.emit('play_card', { cardId: pendingWild.id, chosenColor: btn.dataset.color });
    pendingWild = null; awaitDrawPlay = false; _drawnCardId = null;
    $('btn-pass').style.display     = 'none';
    $('color-picker').style.display = 'none';
  };
});

$('btn-pass').onclick = () => {
  socket.emit('pass_turn');
  awaitDrawPlay = false; _drawnCardId = null;
  $('btn-pass').style.display = 'none';
};

$('btn-uno').onclick = () => socket.emit('say_uno');

function catchUno(targetId) { socket.emit('catch_uno', { targetId }); }
window.catchUno = catchUno;

// ── Leave game ────────────────────────────────────────────────
$('btn-leave-game').onclick = () => {
  $('leave-confirm').style.display = 'flex';
};
$('btn-leave-cancel').onclick = () => {
  $('leave-confirm').style.display = 'none';
};
$('btn-leave-confirm').onclick = () => {
  $('leave-confirm').style.display = 'none';
  doLeave();
};

function doLeave() {
  socket.disconnect();
  myId = null; myName = ''; roomCode = null; roomState = null;
  myHand = []; awaitDrawPlay = false; pendingWild = null; _drawnCardId = null; lastTopCardId = null;
  show('s-home');
  socket.connect();
}

// ── Game over actions ─────────────────────────────────────────
$('btn-play-again').onclick = () => socket.emit('play_again');
$('btn-go-home').onclick    = () => { location.href = '/'; };

// ═══════════════════════════════════════════════════════════════
//  CARD BUILDER
// ═══════════════════════════════════════════════════════════════
function buildCard(card, colorHint) {
  const isWild = card.value === 'wild' || card.value === 'wild_draw4';
  const isNum  = !isNaN(parseInt(card.value, 10));
  const isAct  = ['skip','reverse','draw2'].includes(card.value);
  const col    = colorHint || card.color;

  const el = document.createElement('div');
  const colorCls = { red:'cr', green:'cg', blue:'cb', yellow:'cy', wild:'cw' }[col] || 'cw';
  const typeCls  = isNum ? 'num' : isAct ? 'act' : isWild ? (card.value === 'wild_draw4' ? 'w4' : '') : '';
  el.className   = `ucard ${colorCls} ${typeCls}`.trim();

  if (isWild) {
    const bg = document.createElement('div');
    bg.className = 'wild-bg';
    el.appendChild(bg);
  }

  const oval = document.createElement('div');
  oval.className = 'oval';
  el.appendChild(oval);

  const tl = document.createElement('div');
  tl.className = 'idx tl';
  tl.innerHTML = idxHtml(card);
  el.appendChild(tl);

  const cc = document.createElement('div');
  cc.className = 'center';
  if (!isWild) cc.textContent = centerSym(card);
  el.appendChild(cc);

  const br = document.createElement('div');
  br.className = 'idx br';
  br.innerHTML = idxHtml(card);
  el.appendChild(br);

  return el;
}

function idxHtml(card) {
  switch (card.value) {
    case 'skip':       return '<span>⊘</span>';
    case 'reverse':    return '<span>↺</span>';
    case 'draw2':      return '<span>+2</span>';
    case 'wild':       return '<span>W</span>';
    case 'wild_draw4': return '<span>W</span><span style="font-size:8px;margin-top:1px">+4</span>';
    default:           return `<span>${card.value}</span>`;
  }
}

function centerSym(card) {
  switch (card.value) {
    case 'skip':    return '⊘';
    case 'reverse': return '↺';
    case 'draw2':   return '+2';
    default:        return card.value;
  }
}

function cardLabel(card) {
  const cn = { red:'Red', green:'Green', blue:'Blue', yellow:'Yellow', wild:'Wild' };
  switch (card.value) {
    case 'skip':       return `${cn[card.color]} Skip`;
    case 'reverse':    return `${cn[card.color]} Reverse`;
    case 'draw2':      return `${cn[card.color]} +2`;
    case 'wild':       return 'Wild';
    case 'wild_draw4': return 'Wild +4';
    default:           return `${cn[card.color]} ${card.value}`;
  }
}
