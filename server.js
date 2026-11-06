const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Game State ───────────────────────────────────────────────────────────────

const rooms = {}; // roomCode -> Room

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── UNO Card Engine ──────────────────────────────────────────────────────────

const COLORS = ['red', 'green', 'blue', 'yellow'];
const WILDS = ['wild', 'wild_draw4'];
const NUMBER_VALUES = ['0','1','2','3','4','5','6','7','8','9'];
const ACTION_VALUES = ['skip','reverse','draw2'];

function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    // One 0 per color
    deck.push({ color, value: '0', id: `${color}_0_a` });
    // Two of each 1-9 and action cards
    for (const v of [...NUMBER_VALUES.slice(1), ...ACTION_VALUES]) {
      deck.push({ color, value: v, id: `${color}_${v}_a` });
      deck.push({ color, value: v, id: `${color}_${v}_b` });
    }
  }
  // Wild cards (4 each)
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild', id: `wild_${i}` });
    deck.push({ color: 'wild', value: 'wild_draw4', id: `wild_draw4_${i}` });
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

function dealCards(deck, count) {
  return deck.splice(0, count);
}

function canPlay(card, topCard, currentColor) {
  if (card.value === 'wild' || card.value === 'wild_draw4') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function isWild(card) {
  return card.value === 'wild' || card.value === 'wild_draw4';
}

// ─── Room Logic ───────────────────────────────────────────────────────────────

function createRoom(hostSocketId, hostName) {
  let code;
  do { code = generateRoomCode(); } while (rooms[code]);

  rooms[code] = {
    code,
    host: hostSocketId,
    players: [{
      id: hostSocketId,
      name: hostName,
      hand: [],
      score: 0,
      connected: true,
      saidUno: false
    }],
    status: 'waiting', // waiting | playing | finished
    deck: [],
    discardPile: [],
    currentPlayerIndex: 0,
    direction: 1, // 1 = clockwise, -1 = counter
    currentColor: null,
    drawStack: 0,    // stacked +2 / +4
    turnTimer: null,
    round: 0
  };
  return rooms[code];
}

function getRoom(code) {
  return rooms[code.toUpperCase()] || null;
}

function getRoomBySocket(socketId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === socketId)) || null;
}

function removePlayerFromRoom(room, socketId) {
  room.players = room.players.filter(p => p.id !== socketId);
  if (room.players.length === 0) {
    delete rooms[room.code];
    return null;
  }
  if (room.host === socketId && room.players.length > 0) {
    room.host = room.players[0].id;
  }
  return room;
}

function startGame(room) {
  room.status = 'playing';
  room.round++;
  room.deck = shuffle(buildDeck());
  room.discardPile = [];
  room.direction = 1;
  room.drawStack = 0;
  room.currentPlayerIndex = 0;

  // Deal 7 cards each
  for (const player of room.players) {
    player.hand = dealCards(room.deck, 7);
    player.saidUno = false;
  }

  // Flip first card (must be a number)
  let firstCard;
  do {
    firstCard = room.deck.shift();
    if (isWild(firstCard) || ACTION_VALUES.includes(firstCard.value)) {
      room.deck.push(firstCard); // put back and reshuffle
      shuffle(room.deck);
    } else break;
  } while (true);

  room.discardPile.push(firstCard);
  room.currentColor = firstCard.color;
}

function getPublicRoom(room) {
  return {
    code: room.code,
    host: room.host,
    status: room.status,
    direction: room.direction,
    currentColor: room.currentColor,
    currentPlayerIndex: room.currentPlayerIndex,
    drawStack: room.drawStack,
    round: room.round,
    topCard: room.discardPile[room.discardPile.length - 1] || null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      score: p.score,
      connected: p.connected,
      saidUno: p.saidUno
    }))
  };
}

function getPrivateHand(room, socketId) {
  const player = room.players.find(p => p.id === socketId);
  return player ? player.hand : [];
}

function advanceTurn(room, steps = 1) {
  const n = room.players.length;
  room.currentPlayerIndex = ((room.currentPlayerIndex + room.direction * steps) % n + n) % n;
}

function reshuffleDiscardIntoDeck(room) {
  if (room.discardPile.length <= 1) return;
  const top = room.discardPile.pop();
  room.deck = shuffle([...room.discardPile]);
  room.discardPile = [top];
}

function drawCards(room, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) reshuffleDiscardIntoDeck(room);
    if (room.deck.length === 0) break;
    drawn.push(room.deck.shift());
  }
  return drawn;
}

function checkWinner(room) {
  return room.players.find(p => p.hand.length === 0) || null;
}

function calcScore(hand) {
  return hand.reduce((sum, c) => {
    if (c.value === 'wild' || c.value === 'wild_draw4') return sum + 50;
    if (['skip','reverse','draw2'].includes(c.value)) return sum + 20;
    return sum + parseInt(c.value, 10);
  }, 0);
}

function broadcastRoom(room) {
  const pub = getPublicRoom(room);
  io.to(room.code).emit('room_update', pub);
  // Also send each player their private hand
  for (const player of room.players) {
    io.to(player.id).emit('hand_update', { hand: player.hand });
  }
}

// ─── Socket Events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Create room
  socket.on('create_room', ({ name }) => {
    if (!name || name.trim().length < 1) {
      socket.emit('error', { message: 'Name is required' });
      return;
    }
    const room = createRoom(socket.id, name.trim().slice(0, 20));
    socket.join(room.code);
    socket.emit('room_created', { code: room.code });
    broadcastRoom(room);
  });

  // Join room
  socket.on('join_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }
    if (room.status !== 'waiting') { socket.emit('error', { message: 'Game already started' }); return; }
    if (room.players.length >= 6) { socket.emit('error', { message: 'Room is full (max 6 players)' }); return; }
    if (!name || name.trim().length < 1) { socket.emit('error', { message: 'Name is required' }); return; }

    // Check name uniqueness
    const trimmed = name.trim().slice(0, 20);
    if (room.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      socket.emit('error', { message: 'Name already taken in this room' });
      return;
    }

    room.players.push({
      id: socket.id,
      name: trimmed,
      hand: [],
      score: 0,
      connected: true,
      saidUno: false
    });
    socket.join(room.code);
    socket.emit('room_joined', { code: room.code });
    broadcastRoom(room);
  });

  // Start game (host only)
  socket.on('start_game', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) { socket.emit('error', { message: 'Not in a room' }); return; }
    if (room.host !== socket.id) { socket.emit('error', { message: 'Only the host can start' }); return; }
    if (room.players.length < 2) { socket.emit('error', { message: 'Need at least 2 players' }); return; }
    if (room.status !== 'waiting') { socket.emit('error', { message: 'Game already started' }); return; }

    startGame(room);
    io.to(room.code).emit('game_started', {});
    broadcastRoom(room);
  });

  // Play card
  socket.on('play_card', ({ cardId, chosenColor }) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) { socket.emit('error', { message: 'Card not in hand' }); return; }

    const card = player.hand[cardIndex];
    const topCard = room.discardPile[room.discardPile.length - 1];

    // If there's a draw stack, can only play matching draw card
    if (room.drawStack > 0) {
      if (topCard.value === 'draw2' && card.value !== 'draw2') {
        socket.emit('error', { message: 'You must play a Draw 2 or draw cards' });
        return;
      }
      if (topCard.value === 'wild_draw4' && card.value !== 'wild_draw4') {
        socket.emit('error', { message: 'You must play a Wild Draw 4 or draw cards' });
        return;
      }
    }

    if (!canPlay(card, topCard, room.currentColor)) {
      socket.emit('error', { message: 'Cannot play this card' });
      return;
    }

    // Remove from hand
    player.hand.splice(cardIndex, 1);
    player.saidUno = false;

    // Place on discard
    room.discardPile.push(card);

    // Handle wild color
    if (isWild(card)) {
      if (!chosenColor || !COLORS.includes(chosenColor)) {
        room.currentColor = COLORS[Math.floor(Math.random() * 4)];
      } else {
        room.currentColor = chosenColor;
      }
    } else {
      room.currentColor = card.color;
    }

    // Apply card effects
    let skipNext = false;
    if (card.value === 'reverse') {
      if (room.players.length === 2) {
        skipNext = true; // reverse acts as skip in 2-player
      } else {
        room.direction *= -1;
      }
    } else if (card.value === 'skip') {
      skipNext = true;
    } else if (card.value === 'draw2') {
      room.drawStack += 2;
      skipNext = true;
    } else if (card.value === 'wild_draw4') {
      room.drawStack += 4;
      skipNext = true;
    }

    // Check win
    if (player.hand.length === 0) {
      // Award score
      const pts = room.players.filter(p => p.id !== socket.id).reduce((s, p) => s + calcScore(p.hand), 0);
      player.score += pts;
      room.status = 'finished';
      io.to(room.code).emit('game_over', {
        winnerId: socket.id,
        winnerName: player.name,
        points: pts,
        scores: room.players.map(p => ({ name: p.name, score: p.score }))
      });
      broadcastRoom(room);
      return;
    }

    // Advance turn
    if (skipNext) {
      advanceTurn(room, 2);
    } else {
      advanceTurn(room, 1);
    }

    // If next player needs to draw (non-stacking scenario resolved)
    if (room.drawStack > 0 && !['draw2', 'wild_draw4'].includes(card.value)) {
      // This case shouldn't happen but guard
    }

    io.to(room.code).emit('card_played', {
      playerId: socket.id,
      playerName: player.name,
      card,
      currentColor: room.currentColor
    });

    broadcastRoom(room);
  });

  // Draw card(s)
  socket.on('draw_card', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    const count = room.drawStack > 0 ? room.drawStack : 1;
    room.drawStack = 0;

    const drawn = drawCards(room, count);
    player.hand.push(...drawn);
    player.saidUno = false;

    io.to(room.code).emit('cards_drawn', {
      playerId: socket.id,
      playerName: player.name,
      count: drawn.length
    });

    // If drew 1 (no penalty), check if they can play
    if (count === 1) {
      const topCard = room.discardPile[room.discardPile.length - 1];
      const drawnCard = drawn[0];
      if (drawnCard && canPlay(drawnCard, topCard, room.currentColor)) {
        // Player can optionally play the drawn card — handled by client
        socket.emit('can_play_drawn', { card: drawnCard });
        broadcastRoom(room);
        return; // don't advance yet
      }
    }

    advanceTurn(room, 1);
    broadcastRoom(room);
  });

  // Pass after drawing (if drawn card can't be played)
  socket.on('pass_turn', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) return;
    advanceTurn(room, 1);
    broadcastRoom(room);
  });

  // Say UNO
  socket.on('say_uno', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (player.hand.length === 1) {
      player.saidUno = true;
      io.to(room.code).emit('uno_called', { playerId: socket.id, playerName: player.name });
      broadcastRoom(room);
    }
  });

  // Catch UNO (someone forgot to call UNO)
  socket.on('catch_uno', ({ targetId }) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.hand.length !== 1 || target.saidUno) return;
    // Penalize target with 2 cards
    const drawn = drawCards(room, 2);
    target.hand.push(...drawn);
    io.to(room.code).emit('uno_caught', {
      catcherId: socket.id,
      catcherName: room.players.find(p => p.id === socket.id)?.name,
      targetId,
      targetName: target.name
    });
    broadcastRoom(room);
  });

  // Play again (host only)
  socket.on('play_again', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    if (room.host !== socket.id) { socket.emit('error', { message: 'Only host can restart' }); return; }
    room.status = 'waiting';
    io.to(room.code).emit('return_to_lobby', {});
    broadcastRoom(room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    if (room.status === 'waiting') {
      removePlayerFromRoom(room, socket.id);
      if (rooms[room.code]) broadcastRoom(room);
    } else {
      // Mark as disconnected during game
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
        io.to(room.code).emit('player_disconnected', { playerId: socket.id, playerName: player.name });
        broadcastRoom(room);
      }
    }
  });
});

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ code: room.code, playerCount: room.players.length, status: room.status });
});

app.get('/api/qr/:code', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  try {
    const url = `${req.protocol}://${req.get('host')}/join/${room.code}`;
    const qr = await QRCode.toDataURL(url, { width: 256, margin: 1 });
    res.json({ qr, url });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// SPA fallback
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WebUNO server running at http://localhost:${PORT}`);
});
