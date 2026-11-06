/* ── WebUNO client ── */

const socket = io();

// ── State ─────────────────────────────────────────────────────
let myId          = null;
let myName        = '';
let roomCode      = null;
let roomState     = null;
let myHand        = [];
let pendingWild   = null;   // card waiting for color pick
let awaitDrawPlay = false;  // drew 1 card; can play it or pass
let _drawnCardId  = null;   // id of the drawn card eligible to play
let lastTopCardId = null;   // track discard changes for flip animation

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

// ── Socket lifecycle ──────────────────────────────────────────
socket.on('connect', () => {
  myId = socket.id;
  // Handle /join/CODE URLs (from QR code or shared link)
  checkJoinUrl();
});
socket.on('disconnect',  () => toast('Disconnected', 'err'));
socket.on('error',       ({ message }) => toast(message, 'err'));

// Check URL on load AND on every reconnect
function checkJoinUrl() {
  const m = location.pathname.match(/^\/join\/([A-Z0-9]{4,8})$/i);
  if (!m) return;
  const code = m[1].toUpperCase();
  // Pre-fill code field
  $('join-code').value = code;
  // Only switch to join screen if we're on home (not already in a game/lobby)
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen || activeScreen.id === 's-home') {
    show('s-join');
    $('join-name').focus();
  }
}

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

socket.on('uno_called',       ({ playerName }) => toast(`${playerName} — UNO! 🃏`, 'ok'));
socket.on('uno_caught',       ({ catcherName, targetName }) =>
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
    `<span>${esc(winnerName)}</span> wins!<br>` +
    `<small style="font-size:13px;color:var(--muted)">+${points} pts</small>`;
  const sb = $('go-scores');
  sb.innerHTML = '';
  [...scores].sort((a,b)=>b.score-a.score).forEach((s,i)=>{
    const r = document.createElement('div');
    r.className = 'score-row' + (i===0 ? ' top' : '');
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

// ── Create ─────────────────────────────────────────────────────
$('btn-create-confirm').onclick = doCreate;
$('create-name').addEventListener('keydown', e => e.key==='Enter' && doCreate());
function doCreate() {
  const name = $('create-name').value.trim();
  if (!name) { toast('Enter your name','err'); return; }
  myName = name;
  socket.emit('create_room', { name });
}

// ── Join ───────────────────────────────────────────────────────
$('btn-join-confirm').onclick = doJoin;
$('join-code').addEventListener('keydown', e => e.key==='Enter' && doJoin());
$('join-name').addEventListener('keydown', e => e.key==='Enter' && doJoin());
$('join-code').addEventListener('input', function() {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
});
function doJoin() {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  if (!name)           { toast('Enter your name','err'); return; }
  if (code.length < 4) { toast('Enter the room code','err'); return; }
  myName = name;
  socket.emit('join_room', { name, code });
}

// ═══════════════════════════════════════════════════════════════
//  LOBBY
// ═══════════════════════════════════════════════════════════════
const PCOLORS = ['#e63946','#1db954','#2563eb','#f59e0b','#8b5cf6','#f97316'];

function renderLobby(state) {
  $('lcode').textContent = state.code;
  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `
      <div class="p-avatar" style="background:${PCOLORS[i%PCOLORS.length]}">${esc(p.name[0].toUpperCase())}</div>
      <span class="p-name">${esc(p.name)}${p.id===myId?'<span class="p-you">(you)</span>':''}</span>
      ${p.id===state.host?'<span class="p-host">host</span>':''}
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
      n>=6 ? 'Room full — ready!' :
      n>=2 ? `${n}/6 players — ready` :
             `Waiting… ${n}/6 (need 2+)`;
  }
}

async function fetchInvite(code) {
  $('lcode').textContent = code;
  $('btn-copy-code').onclick = () =>
    navigator.clipboard.writeText(code).then(() => toast('Code copied','ok'));
  try {
    const r = await fetch(`/api/qr/${code}`);
    const d = await r.json();
    $('qr-img').src = d.qr;
    $('invite-link').value = d.url;
    $('btn-copy-link').onclick = () =>
      navigator.clipboard.writeText(d.url).then(() => toast('Link copied','ok'));
  } catch { /* silent */ }
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
    div.className = `opp-slot${isActive?' active':''}${!p.connected?' offline':''}`;

    const show = Math.min(p.handCount, 7);
    let minis = '<div class="opp-minis">';
    for (let i = 0; i < show; i++) minis += '<div class="mini-card"></div>';
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

// ── Discard pile ───────────────────────────────────────────────
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

// ── Status ─────────────────────────────────────────────────────
function renderStatus(state) {
  $('st-dir').textContent = state.direction === 1 ? '↻' : '↺';
  $('st-color').className = `cdot ${state.currentColor || 'wild'}`;
  const cur = state.players[state.currentPlayerIndex];
  const el  = $('st-turn');
  if (!cur) return;
  if (cur.id === myId) { el.textContent = 'Your turn'; el.className = 'my-turn'; }
  else                 { el.textContent = `${cur.name}'s turn`; el.className = ''; }
}

// ── Draw pile ──────────────────────────────────────────────────
function updateDrawPile(state) {
  const isMyTurn = state.players[state.currentPlayerIndex]?.id === myId;
  const dp = $('draw-pile');
  dp.style.opacity = isMyTurn ? '1' : '0.45';
  dp.style.cursor  = isMyTurn ? 'pointer' : 'default';
  $('draw-label').textContent = state.drawStack > 0 ? `+${state.drawStack}` : 'DRAW';
}

$('draw-pile').onclick = () => {
  if (!roomState || roomState.status !== 'playing') return;
  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  if (!isMyTurn)    { toast("Not your turn",'err',1500); return; }
  if (awaitDrawPlay){ return; }
  socket.emit('draw_card');
};

// ── My hand ─────────────────────────────────────────────────────
function renderHand(mode = '') {
  const container = $('my-hand');
  container.innerHTML = '';
  if (!roomState) return;

  const isMyTurn = roomState.players[roomState.currentPlayerIndex]?.id === myId;
  const topCard  = roomState.topCard;

  myHand.forEach((card, idx) => {
    let playable = false;
    if (isMyTurn) {
      if (awaitDrawPlay) {
        playable = card.id === _drawnCardId;
      } else {
        playable = clientCanPlay(card, topCard, roomState.currentColor, roomState.drawStack);
      }
    }

    const wrap = document.createElement('div');
    wrap.className = `hcard-wrap ${playable ? 'playable' : 'dim'}`;
    // Stagger deal animation
    wrap.style.animationDelay = `${idx * 35}ms`;
    if (mode === 'draw' && idx === myHand.length - 1)
      wrap.classList.add('draw-anim');

    const el = buildCard(card, card.color);
    wrap.appendChild(el);
    if (playable) wrap.onclick = () => handlePlay(card);
    container.appendChild(wrap);
  });

  // UNO button
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
    $('btn-pass').style.display    = 'none';
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

$('btn-play-again').onclick = () => socket.emit('play_again');
$('btn-go-home').onclick    = () => { location.href = '/'; };

// Run URL check immediately on page load too (catches fast connections)
checkJoinUrl();

// ═══════════════════════════════════════════════════════════════
//  CARD BUILDER
//  Renders a proper UNO card as a DOM element
// ═══════════════════════════════════════════════════════════════

/**
 * colorClass: 'red' | 'green' | 'blue' | 'yellow' | 'wild'
 * displayColor: overrides wild color for the cdot (not needed here)
 */
function buildCard(card, colorHint) {
  const isWild = card.value === 'wild' || card.value === 'wild_draw4';
  const isNum  = !isNaN(parseInt(card.value, 10));
  const isAct  = ['skip','reverse','draw2'].includes(card.value);
  const col    = colorHint || card.color;

  const el = document.createElement('div');
  const colorCls = colorShort(col);
  const typeCls  = isNum ? 'num' : isAct ? 'act' : isWild ? (card.value==='wild_draw4'?'w4':'') : '';
  el.className   = `ucard ${colorCls} ${typeCls}`.trim();

  // Wild quadrant background div
  if (isWild) {
    const bg = document.createElement('div');
    bg.className = 'wild-bg';
    el.appendChild(bg);
  }

  // Inner oval
  const oval = document.createElement('div');
  oval.className = 'oval';
  el.appendChild(oval);

  // Top-left index
  const tl = document.createElement('div');
  tl.className = 'idx tl';
  tl.innerHTML = indexHtml(card);
  el.appendChild(tl);

  // Center symbol
  const cc = document.createElement('div');
  cc.className = 'center';
  if (isWild) {
    // center is a colored circle (styled via CSS)
    // add nothing — CSS ::after handles +4
  } else {
    cc.textContent = centerSymbol(card);
  }
  el.appendChild(cc);

  // Bottom-right index (rotated 180°)
  const br = document.createElement('div');
  br.className = 'idx br';
  br.innerHTML = indexHtml(card);
  el.appendChild(br);

  return el;
}

function colorShort(c) {
  return { red:'cr', green:'cg', blue:'cb', yellow:'cy', wild:'cw' }[c] || 'cw';
}

// Corner index label — number or icon
function indexHtml(card) {
  switch (card.value) {
    case 'skip':       return '<span>⊘</span>';
    case 'reverse':    return '<span>↺</span>';
    case 'draw2':      return '<span>+2</span>';
    case 'wild':       return '<span>W</span>';
    case 'wild_draw4': return '<span>W</span><span style="font-size:9px">+4</span>';
    default:           return `<span>${card.value}</span>`;
  }
}

// Large center symbol
function centerSymbol(card) {
  switch (card.value) {
    case 'skip':    return '⊘';
    case 'reverse': return '↺';
    case 'draw2':   return '+2';
    default:        return card.value; // number
  }
}

// Human-readable label for toasts
function cardLabel(card) {
  const colorName = { red:'Red', green:'Green', blue:'Blue', yellow:'Yellow', wild:'Wild' };
  switch (card.value) {
    case 'skip':       return `${colorName[card.color]} Skip`;
    case 'reverse':    return `${colorName[card.color]} Reverse`;
    case 'draw2':      return `${colorName[card.color]} +2`;
    case 'wild':       return 'Wild';
    case 'wild_draw4': return 'Wild +4';
    default:           return `${colorName[card.color]} ${card.value}`;
  }
}
