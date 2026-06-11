# Only Us 🚩

A cooperative 3D browser game for 1–4 players. Climb a procedurally generated tower of
giant household objects — from the kitchen floor, through the attic and the open sky, all
the way into deep space — together. Everyone must reach the flag at the summit; the clock
stops when the last teammate arrives.

## How it plays

- **Co-op climbing** in the spirit of *Only Up*, *Peak*, and *Fall Guys* (knockdown ragdolls included).
- **Procedural levels** from a seed: 10 themed zones (kitchen → living room → bedroom → bathroom →
  office → attic → rooftop → open sky → stratosphere → deep space), each with a checkpoint banner.
  Fall past your checkpoint and you respawn there.
- **Teamwork gadgets** between platforms: pressure-plate bridges (later ones need a plate on each
  side, or two players standing at once), ladders, and climbing ropes.
- **Thinning air**: gravity eases from 100% at ground level to 55% in deep space, so jumps get
  higher and floatier as you climb — and the generator widens the gaps to match.
- **Items** on out-of-the-way side platforms: Double Jump boots, a Telescope (hold right-click to
  zoom), and a Grappling Hook that hangs a rope everyone can climb. One item slot each — press
  **G** to hand your item to a nearby friend.
- **Hold hands** (**F**) — a tether that catches a teammate mid-leap.
- **Leaderboard** of fastest full-team runs, stored in Postgres.

### Controls

| Key | Action |
| --- | --- |
| WASD + mouse | Move / look |
| Space | Jump |
| E | Let go of a rope/ladder (grabbing is automatic when you touch one) |
| F | Hold hands with a nearby teammate |
| Q | Use item (grappling hook) |
| Right click (hold) | Telescope zoom |
| G | Give your item to a nearby teammate |
| Z | Dive (deliberate ragdoll) |
| B | Ping your location |

## Architecture

```
shared/   TypeScript: protocol types, constants, seeded RNG, the level generator
server/   Node + ws: rooms, lobby, state relay (20 Hz), gadget logic, Postgres leaderboard
client/   Vite + Three.js + Rapier (WASM): rendering, character controller, ragdolls, UI
```

- Each browser simulates **its own** character (kinematic character controller, zero input
  latency); the server owns shared state — seed, bridges/plates, checkpoints, items, timer —
  and relays player transforms at 20 Hz with interpolation on the receiving side.
- The level is generated **deterministically from the seed** on the server and every client,
  so the network never carries geometry.
- No accounts: pick a nickname, customize your bean (color / hat / eyes), share the 4-letter
  room code.

## Local development

```bash
npm install
npm run dev        # server on :3001, client on :5173 (proxies /ws and /api)
```

Open http://localhost:5173 — create a room in one tab, join with the code from another tab.
Without `DATABASE_URL` the leaderboard lives in memory.

Useful checks:

```bash
npm run check:level   # generator sanity: jump reachability, checkpoint ordering
npm run typecheck
npm run build && npm start   # production build on :3001
npx tsx scripts/smoke-multiplayer.ts   # 2-player protocol test against a running server
```

Debug helpers in the browser console while in a game: `__onlyUs.tp(zoneIndex)` teleports to a
checkpoint, `__onlyUs.flag()` to the summit.

## Deploying to Render

The repo ships a [Blueprint](https://render.com/docs/blueprint-spec) (`render.yaml`):

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo, deploy. You get a web service (game +
   WebSockets on one port) and a Postgres database wired in via `DATABASE_URL`.
3. Share your `https://only-us-*.onrender.com` URL with three friends.

Note: the blueprint uses the free Postgres plan, which Render expires after 90 days — switch
the database to a paid plan if you want the leaderboard to live forever.
