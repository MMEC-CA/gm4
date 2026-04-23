# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deploy

Pushes to `main` auto-deploy via GitHub Actions. Manual deploy:

```
npx wrangler@4 deploy
```

No build step — files are deployed as-is. No npm packages; pure vanilla JS.

## Architecture

Two-tier, zero-dependency stack:

**Backend** (`src/`)
- `src/worker.js` — Worker entry point. Routes WebSocket upgrades at `*/api/signal/ws` to the `SignalingRoom` Durable Object; serves all other requests as static assets via `env.ASSETS`.
- `src/signaling-do.js` — `SignalingRoom` Durable Object. Pure in-memory WebSocket hub: tracks connected peers, broadcasts join/leave events, relays WebRTC signaling messages between peers. No persistent storage.

**Frontend** (`gm4/`)
- `gm4/game.js` — The entire game (~1400 lines). HTML5 Canvas2D rendering, game loop at 60fps, physics, AI, weapons, WebRTC peer connections, and DataChannel state sync all in one file. No frameworks.
- `gm4/index.html` — Minimal wrapper that loads `game.js`.

**Signaling flow**: Peers connect via WebSocket → discover peer IDs → establish RTCPeerConnection with DataChannel → game state broadcast P2P. The host (lowest peerId) coordinates countdown/start.

**Track collision** uses Signed Distance Functions (SDF).

**Room grouping**: no `room` param → auto-group by WAN IP; `room=<code>` → explicit room (e.g. from QR code).

## Versioning

Every code change requires a new version tag in `const VERSION` near the top of `gm4/game.js`, format: `YYYY-MM-DD-aa`. The suffix starts at `-aa` for the first change of the day, then increments (`-ab`, `-ac`, …), resetting to `-aa` on each new day.
