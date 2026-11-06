const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const QRCode  = require('qrcode');
const os      = require('os');

// Resolve LAN IP once at startup so QR codes work across devices
function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}
const PORT   = process.env.PORT   || 3000;
const LAN_IP = process.env.HOST_IP || getLanIp();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── In-memory store ──────────────────────────────────────────
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Deck ─────────────────────────────────────────────────────
const COLORS       = ['red','green','blue','yellow'];
const ACTION_VALUES = ['skip','reverse','draw2'];

function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: '0', id: `${color}_0_a` });
    for (const v of ['1','2','3','4','5','6','7','8','9',...ACTION_VALUES]) {
      deck.push({ color, value: v, id: `${color}_${v}_a` });
      deck.push({ color, value: v, id: `${color}_${v}_b` });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild',       id: `wild_${i}` });
    deck.push({ color: 'wild', value: 'wild_draw4', id: `wd4_${i}` });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isWild(card) {
  return card.value === 'wild' || card.value === 'wild_draw4';
}

function canPlay(card, topCard, currentColor) {
  if (isWild(card)) return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function calcScore(hand) {
  return hand.reduce((sum, c) => {
    if (c.value === 'wild' || c.value === 'wild_draw4') return sum + 50;
    if (ACTION_VALUES.includes(c.value)) return sum + 20;
    return sum + parseInt(c.value, 10);
  }, 0);
}

// ── Room helpers ─────────────────────────────────────────────

function getRoom(code) {
  return rooms[code?.toUpperCase()] || null;
}

function getRoomBySocket(id) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === id)) || null;
}

function publicRoom(room) {
  return {
    code:               room.code,
    host:               room.host,
    status:             room.status,
    direction:          room.direction,
    currentColor:       room.currentColor,
    currentPlayerIndex: room.currentPlayerIndex,
    drawStack:          room.drawStack,
    round:              room.round,
    topCard:            room.discardPile[room.discardPile.length - 1] || null,
    players: room.players.map(p => ({
      id:         p.id,
      name:       p.name,
      handCount:  p.hand.length,
      score:      p.score,
      connected:  p.connected,
      saidUno:    p.saidUno
    }))
  };
}

function broadcast(room) {
  io.to(room.code).emit('room_update', publicRoom(room));
  for (const p of room.players) {
    io.to(p.id).emit('hand_update', { hand: p.hand });
  }
}

function drawCards(room, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) reshuffleDiscard(room);
    if (room.deck.length === 0) break;
    drawn.push(room.deck.shift());
  }
  return drawn;
}

function reshuffleDiscard(room) {
  if (room.discardPile.length <= 1) return;
  const top = room.discardPile.pop();
  room.deck = shuffle([...room.discardPile]);
  room.discardPile = [top];
}

function advanceTurn(room, extraSkips = 0) {
  const n = room.players.length;
  // Move 1 (normal advance) + extraSkips (for skip/draw effects)
  const steps = 1 + extraSkips;
  room.currentPlayerIndex =
    ((room.currentPlayerIndex + room.direction * steps) % n + n) % n;
}

function startGame(room) {
  room.status             = 'playing';
  room.round++;
  room.deck               = shuffle(buildDeck());
  room.discardPile        = [];
  room.direction          = 1;
  room.drawStack          = 0;
  room.currentPlayerIndex = 0;
  room.awaitingDrawPlay   = null; // socket id that may play drawn card

  for (const p of room.players) {
    p.hand    = room.deck.splice(0, 7);
    p.saidUno = false;
  }

  // First card must be a number
  let first;
  do {
    first = room.deck.shift();
    if (isWild(first) || ACTION_VALUES.includes(first.value)) {
      room.deck.push(first);
      shuffle(room.deck);
      first = null;
    }
  } while (!first);

  room.discardPile.push(first);
  room.currentColor = first.color;
}

// ── Socket handlers ──────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  // ─ create_room ─
  socket.on('create_room', ({ name }) => {
    name = (name || '').trim().slice(0, 20);
    if (!name) { socket.emit('error', { message: 'Name is required' }); return; }

    let code;
    do { code = generateCode(); } while (rooms[code]);

    rooms[code] = {
      code, host: socket.id,
      players: [{ id: socket.id, name, hand: [], score: 0, connected: true, saidUno: false }],
      status: 'waiting',
      deck: [], discardPile: [],
      currentPlayerIndex: 0, direction: 1,
      currentColor: null, drawStack: 0,
      round: 0, awaitingDrawPlay: null
    };
    socket.join(code);
    socket.emit('room_created', { code });
    broadcast(rooms[code]);
  });

  // ─ join_room ─
  socket.on('join_room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim().slice(0, 20);

    const room = getRoom(code);
    if (!room)                           { socket.emit('error', { message: 'Room not found' }); return; }
    if (room.status !== 'waiting')       { socket.emit('error', { message: 'Game already in progress' }); return; }
    if (room.players.length >= 6)        { socket.emit('error', { message: 'Room is full (max 6)' }); return; }
    if (!name)                           { socket.emit('error', { message: 'Name is required' }); return; }
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      socket.emit('error', { message: 'That name is already taken' }); return;
    }

    room.players.push({ id: socket.id, name, hand: [], score: 0, connected: true, saidUno: false });
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcast(room);
  });

  // ─ start_game ─
  socket.on('start_game', () => {
    const room = getRoomBySocket(socket.id);
    if (!room)                           { socket.emit('error', { message: 'Not in a room' }); return; }
    if (room.host !== socket.id)         { socket.emit('error', { message: 'Only the host can start' }); return; }
    if (room.players.length < 2)         { socket.emit('error', { message: 'Need at least 2 players' }); return; }
    if (room.status !== 'waiting')       { socket.emit('error', { message: 'Game already started' }); return; }

    startGame(room);
    io.to(room.code).emit('game_started', {});
    broadcast(room);
  });

  // ─ play_card ─
  socket.on('play_card', ({ cardId, chosenColor }) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error', { message: 'Not your turn' }); return;
    }

    // If awaitingDrawPlay is set, only that socket can play and only that card
    if (room.awaitingDrawPlay && room.awaitingDrawPlay !== socket.id) {
      socket.emit('error', { message: 'Not your turn' }); return;
    }

    const player   = room.players.find(p => p.id === socket.id);
    const cardIdx  = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) { socket.emit('error', { message: 'Card not found in hand' }); return; }

    const card    = player.hand[cardIdx];
    const topCard = room.discardPile[room.discardPile.length - 1];

    // Draw-stack stacking rules
    if (room.drawStack > 0) {
      if (topCard.value === 'draw2'      && card.value !== 'draw2')      { socket.emit('error', { message: 'Stack with +2 or draw cards' }); return; }
      if (topCard.value === 'wild_draw4' && card.value !== 'wild_draw4') { socket.emit('error', { message: 'Stack with +4 or draw cards' }); return; }
    }

    if (!canPlay(card, topCard, room.currentColor)) {
      socket.emit('error', { message: 'That card cannot be played' }); return;
    }

    // Validate wild color choice
    if (isWild(card)) {
      if (!COLORS.includes(chosenColor)) {
        socket.emit('error', { message: 'Choose a valid color' }); return;
      }
    }

    // Commit the play
    player.hand.splice(cardIdx, 1);
    player.saidUno       = false;
    room.awaitingDrawPlay = null;
    room.discardPile.push(card);
    room.currentColor = isWild(card) ? chosenColor : card.color;

    io.to(room.code).emit('card_played', {
      playerId:   socket.id,
      playerName: player.name,
      card,
      currentColor: room.currentColor
    });

    // Win check
    if (player.hand.length === 0) {
      const pts = room.players.filter(p => p.id !== socket.id)
                              .reduce((s, p) => s + calcScore(p.hand), 0);
      player.score += pts;
      room.status   = 'finished';
      io.to(room.code).emit('game_over', {
        winnerId:   socket.id,
        winnerName: player.name,
        points:     pts,
        scores:     room.players.map(p => ({ name: p.name, score: p.score }))
      });
      broadcast(room);
      return;
    }

    // Apply effect then advance
    if (card.value === 'reverse') {
      if (room.players.length === 2) {
        advanceTurn(room, 1); // acts as skip in 2-player
      } else {
        room.direction *= -1;
        advanceTurn(room, 0);
      }
    } else if (card.value === 'skip') {
      advanceTurn(room, 1); // skip next player
    } else if (card.value === 'draw2') {
      room.drawStack += 2;
      advanceTurn(room, 1); // next player is forced to draw or stack
    } else if (card.value === 'wild_draw4') {
      room.drawStack += 4;
      advanceTurn(room, 1);
    } else {
      advanceTurn(room, 0);
    }

    broadcast(room);
  });

  // ─ draw_card ─
  socket.on('draw_card', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error', { message: 'Not your turn' }); return;
    }
    if (room.awaitingDrawPlay === socket.id) {
      // Already drew — ignore double-draw
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    const count  = room.drawStack > 0 ? room.drawStack : 1;
    room.drawStack = 0;

    const drawn = drawCards(room, count);
    player.hand.push(...drawn);
    player.saidUno = false;

    io.to(room.code).emit('cards_drawn', {
      playerId:   socket.id,
      playerName: player.name,
      count:      drawn.length
    });

    // When drawing for a penalty (count > 1), always skip turn
    if (count > 1) {
      advanceTurn(room, 0);
      broadcast(room);
      return;
    }

    // Drew exactly 1: check if that card is playable
    const drawn1 = drawn[0];
    const topCard = room.discardPile[room.discardPile.length - 1];
    if (drawn1 && canPlay(drawn1, topCard, room.currentColor)) {
      room.awaitingDrawPlay = socket.id;
      socket.emit('can_play_drawn', { card: drawn1 });
      broadcast(room); // hand_update goes out here
      return;
    }

    // Card not playable — just pass
    advanceTurn(room, 0);
    broadcast(room);
  });

  // ─ pass_turn ─ (after drawing a playable card but choosing not to play it)
  socket.on('pass_turn', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    if (room.awaitingDrawPlay !== socket.id) return;
    room.awaitingDrawPlay = null;
    advanceTurn(room, 0);
    broadcast(room);
  });

  // ─ say_uno ─
  socket.on('say_uno', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.hand.length !== 1) return;
    player.saidUno = true;
    io.to(room.code).emit('uno_called', { playerId: socket.id, playerName: player.name });
    broadcast(room);
  });

  // ─ catch_uno ─
  socket.on('catch_uno', ({ targetId }) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.hand.length !== 1 || target.saidUno) return;

    const drawn = drawCards(room, 2);
    target.hand.push(...drawn);
    io.to(room.code).emit('uno_caught', {
      catcherName: room.players.find(p => p.id === socket.id)?.name || '?',
      targetName:  target.name
    });
    broadcast(room);
  });

  // ─ play_again ─
  socket.on('play_again', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.host !== socket.id) return;
    room.status = 'waiting';
    io.to(room.code).emit('return_to_lobby', {});
    broadcast(room);
  });

  // ─ disconnect ─
  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    if (room.status === 'waiting') {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { delete rooms[room.code]; return; }
      if (room.host === socket.id) room.host = room.players[0].id;
      broadcast(room);
    } else {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
        io.to(room.code).emit('player_disconnected', { playerName: player.name });
        broadcast(room);
      }
    }
  });
});

// ── HTTP ─────────────────────────────────────────────────────

app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json({ code: room.code, players: room.players.length, status: room.status });
});

app.get('/api/qr/:code', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Not found' });
  try {
    // Always use LAN IP so QR works when scanned from other devices
    const url = `http://${LAN_IP}:${PORT}/join/${room.code}`;
    const qr  = await QRCode.toDataURL(url, { width: 256, margin: 2,
      color: { dark: '#111827', light: '#f9fafb' } });
    res.json({ qr, url });
  } catch (e) {
    console.error('QR error', e);
    res.status(500).json({ error: 'QR failed' });
  }
});

app.get('/{*path}', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);


// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebUNO → http://localhost:${PORT}`);
  console.log(`WebUNO → http://${LAN_IP}:${PORT}  (share this for QR/LAN)`);
});
