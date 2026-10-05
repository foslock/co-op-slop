# Only Us 🚩

A cooperative 3D browser game for 1–4 players. Climb a procedurally generated tower of
giant household objects — from the kitchen floor, through the attic and the open sky, all
the way into deep space — together. Everyone must reach the flag at the summit; the clock
stops when the last teammate arrives.

## How it plays

- **Co-op climbing** in the spirit of *Only Up*, *Peak*, and *Fall Guys* (knockdown ragdolls included).
- **Procedural levels** from a seed: 10 themed zones (six rooms of the house picked from basement, garage,
  kitchen, living room, library, bedroom, bathroom, office, attic and backyard, then the rooftop, open sky,
  stratosphere and deep space), each with a checkpoint gate. Fall past your checkpoint and you respawn there.
  The indoor zones are real rooms — wallpapered walls with windows, floors and ceilings with a stairwell the
  tower climbs through — and above the roof the sky darkens until you're among the stars.
- **Contraptions** between platforms:
  - pressure-plate bridges that lay themselves across plank by plank (later ones only stay out while held),
  - leaning ladders, climbing ropes and slack ropes strung across gaps,
  - moving platforms: shuttles across gaps, lifts up walls, and spinning beams that line up twice a turn.
- **Two-player contraptions** (only generated when 2+ climbers start the run):
  - **Seesaw catapult** — one climber sits on the seat, a teammate lands on the raised end and flings them up
    to a ledge; whoever is up top pulls the lever to drop a weight and launch the next.
  - **Crank lift** — rises only while someone stands on a crank plate, so one climber sends the others up
    and the first one up cranks it for the last.
  - **Twin / duo bridges** — two plates on separate platforms pressed at once, or two climbers on one plate.
  - **Ledge saves** — hold Shift as you jump at a ledge you won't quite clear to hang on for up to 5 seconds;
    a teammate standing above you presses Shift to pull you up.
  - If the team shrinks to one climber mid-run, the server relaxes all of these so nobody gets stuck.
- **Thinning air**: gravity eases from 100% at ground level to 55% in deep space, so jumps get higher and
  floatier as you climb — and the generator widens the gaps to match.
- **Items** on out-of-the-way side platforms: Double Jump boots, a Telescope (hold right-click to zoom), and
  a Grappling Hook that hangs a rope from the edge you aim at, for everyone to climb. One item slot each —
  press **G** to hand your item to a nearby friend.
- **Hold hands** (**F**) — a tether that catches a teammate mid-leap.
- **Leaderboard** of fastest full-team runs, stored in Postgres.

### Controls

| Key | Action |
| --- | --- |
| WASD + mouse | Move / look |
| Space | Jump (also jumps off a rope or ladder) |
| Shift (hold) | Grab a rope or ladder, or hang on to a ledge; release to let go |
| W / S | Climb, or shimmy along a strung rope |
| A / D | Swing on a hanging rope |
| Shift (tap, next to a hanging teammate) | Pull them up |
| F | Hold hands with a nearby teammate |
| Q | Use item (grappling hook) |
| Right click (hold) | Telescope zoom |
| G | Give your item to a nearby teammate (or set it down) |
| Z | Dive (deliberate ragdoll) |
| R | Reset to your latest checkpoint (counts as a fall) |
| B | Ping your location |
| Esc | Pause menu (controls, leave game) |

## Architecture

```
shared/   TypeScript: protocol types, constants, seeded RNG, the level generator
server/   Node + ws: rooms, lobby, state relay (20 Hz), gadget logic, Postgres leaderboard
client/   Vite + Three.js + Rapier (WASM): rendering, character controller, ragdolls, UI
```

- Each browser simulates **its own** character (kinematic character controller, zero input
  latency); the server owns shared state — seed, bridges/plates, checkpoints, items, timer —
  and relays player transforms at 20 Hz with interpolation on the receiving side.
- The level is generated **deterministically from the seed and team size** on the server and
  every client, so the network never carries geometry. The generator keeps a collision registry
  of every prop, jump arc, gadget path and the headroom above each platform, so nothing
  intersects or blocks the route.
- Moving platforms run off the shared game clock, so every client sees them in the same place
  without any network traffic; riders are carried by the deck's exact rigid motion (including
  rotation) and keep its momentum when they jump off.
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
npm run check:level   # generator sanity: reachability, structure, no intersecting props or low ceilings
npm run check:level -- --sweep 300   # the same checks over 300 random seeds, solo and team
npm run typecheck
npm run build && npm start   # production build on :3001
npx tsx scripts/smoke-multiplayer.ts   # 2-player protocol test against a running server
```

Debug helpers in the browser console while in a game: `__onlyUs.tp(zoneIndex)` teleports to a
checkpoint, `__onlyUs.node(i)` to path node `i`, `__onlyUs.flag()` to the summit.

## Deploying to Render

The repo ships a [Blueprint](https://render.com/docs/blueprint-spec) (`render.yaml`):

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo, deploy. You get a web service (game +
   WebSockets on one port) and a Postgres database wired in via `DATABASE_URL`.
3. Share your `https://only-us-*.onrender.com` URL with three friends.

Note: the blueprint uses the free Postgres plan, which Render expires after 90 days — switch
the database to a paid plan if you want the leaderboard to live forever.
