# WebUNO 🃏

Multiplayer UNO for up to 6 players — playable in any browser.

## Quick Start

```bash
npm install    # already done
npm start      # starts server at http://localhost:3000
```

## Features

- Up to 6 players per room
- Room creation with shareable **6-character alphanumeric code**
- **QR code** invite (scan to join instantly)
- **Room link** copy to clipboard
- Full UNO rules: Skip, Reverse, Draw 2, Wild, Wild Draw 4
- Stackable +2 / +4 draw penalties
- UNO call button + catch-UNO mechanic (2-card penalty)
- Score tracking across rounds
- Host can restart for another round

## How to Play

1. Player 1 opens the app and clicks **Create Room**
2. Share the room code / QR / link with friends
3. Friends click **Join Room** and enter the code
4. Host clicks **Start Game** (2–6 players required)

## Rules Implemented

| Card | Effect |
|------|--------|
| Number (0–9) | Match by color or number |
| Skip | Next player loses their turn |
| Reverse | Reverses play direction (acts as Skip in 2-player) |
| Draw 2 | Next player draws 2 + loses turn (stackable) |
| Wild | Change the active color |
| Wild Draw 4 | Next player draws 4 + loses turn (stackable) |

**UNO Rule**: When you have 1 card left, press the **UNO!** button before playing. Opponents can press **Catch!** if you forget — 2-card penalty.

## Tech Stack

- **Backend**: Node.js, Express 5, Socket.IO
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **QR**: `qrcode` npm package
