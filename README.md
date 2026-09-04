# RPS

A two-player Rock-Paper-Scissors card game with public HP wagers, sequential
face-down pair choices and reveals, optional HP-paid draws, hand growth,
triples, and five-of-a-kind showdowns. Play online or against the computer.

## Development

```powershell
npm.cmd install
npm.cmd test
npm.cmd run dev
```

The client runs at `http://localhost:5173` and proxies Socket.IO traffic to the
authoritative server at `http://localhost:3001`.

## Structure

- `packages/game-core`: deterministic rules and computer opponent
- `packages/protocol`: privacy-safe client/server message types
- `apps/server`: room, timer, reconnection, and match authority
- `apps/client`: Vite, Phaser effects, and the game interface
