// Protocol-level 2-player smoke test against a running server: npx tsx scripts/smoke-multiplayer.ts [port]
// Creates a room, joins a second player, starts a run, presses a plate, transfers an
// item, and finishes — asserting the key server broadcasts along the way.
import WebSocket from 'ws';
import { generateLevel, type C2S, type S2C } from 'shared';

const PORT = process.argv[2] ?? '3001';
const url = `ws://localhost:${PORT}/ws`;

class Client {
  ws: WebSocket;
  name: string;
  id = '';
  inbox: S2C[] = [];
  constructor(name: string) {
    this.name = name;
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => this.inbox.push(JSON.parse(raw.toString())));
  }
  open(): Promise<void> {
    return new Promise((res) => this.ws.on('open', () => res()));
  }
  send(msg: C2S) {
    this.ws.send(JSON.stringify(msg));
  }
  async expect<T extends S2C['t']>(type: T, timeoutMs = 4000): Promise<Extract<S2C, { t: T }>> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const idx = this.inbox.findIndex((m) => m.t === type);
      if (idx >= 0) return this.inbox.splice(idx, 1)[0] as Extract<S2C, { t: T }>;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${this.name}: timed out waiting for '${type}'. inbox: ${this.inbox.map((m) => m.t).join(',')}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const cos = { color: 0, hat: 0, eyes: 0 };
  const a = new Client('alice');
  const b = new Client('bob');
  await Promise.all([a.open(), b.open()]);

  // --- lobby ---
  a.send({ t: 'create', name: 'alice', cos });
  const joinedA = await a.expect('joined');
  a.id = joinedA.you;
  const code = joinedA.code;
  console.log('room created:', code);

  b.send({ t: 'join', code, name: 'bob', cos });
  const joinedB = await b.expect('joined');
  b.id = joinedB.you;
  assert(joinedB.players.length === 2, 'bob sees 2 players');

  b.send({ t: 'ready', ready: true });
  await a.expect('lobby');
  a.send({ t: 'seed', seed: 'smoketest' });
  a.send({ t: 'start' });
  const startingA = await a.expect('starting');
  const startingB = await b.expect('starting');
  assert(startingA.seed === 'smoketest' && startingB.seed === 'smoketest', 'both got the seed');
  console.log('game starting with seed:', startingA.seed);

  const level = generateLevel('smoketest');
  a.send({ t: 'loaded' });
  b.send({ t: 'loaded' });
  const go = await a.expect('go');
  await b.expect('go');
  assert(go.startAt > go.now, 'countdown scheduled');
  console.log('go received, countdown', go.startAt - go.now, 'ms');

  // --- state relay ---
  a.send({ t: 'state', p: [1, 2, 3], yaw: 0.5, anim: 1, vy: 0 });
  const t0 = Date.now();
  let sawAliceState = false;
  while (Date.now() - t0 < 3000 && !sawAliceState) {
    const s = await b.expect('S');
    const row = s.players[a.id];
    if (row && row[0] === 1 && row[2] === 3) sawAliceState = true;
  }
  assert(sawAliceState, "bob received alice's transform via broadcast");
  console.log('state relay OK');

  // --- gadget: press the first bridge plate ---
  const bridge = level.gadgets.find((g) => g.kind === 'bridge');
  if (bridge) {
    a.send({ t: 'plate', gadget: bridge.id, plate: 0, on: true });
    const gs = await b.expect('gadget');
    assert(gs.id === bridge.id, 'gadget broadcast for the right bridge');
    assert(gs.state.plates[0] === 1, 'one player on plate 0');
    console.log(`bridge ${bridge.id} (${bridge.mode}) plate pressed → active=${gs.state.active}`);
  } else {
    console.log('no bridge in this seed (skipping plate test)');
  }

  // --- items: pickup + give ---
  const item = level.items[0];
  a.send({ t: 'pickup', item: item.id });
  const pk = await b.expect('pickup');
  assert(pk.player === a.id && pk.item === item.id, 'pickup broadcast');
  a.send({ t: 'give', to: b.id });
  const gave = await b.expect('item');
  assert(gave.player === a.id && gave.item === null || gave.item === item.type, 'item transfer broadcast');
  console.log(`item ${item.type} picked up and given away OK`);

  // --- checkpoint + fell + grab + ping + knock relays ---
  a.send({ t: 'checkpoint', index: 1 });
  await b.expect('checkpoint');
  a.send({ t: 'fell' });
  await b.expect('fell');
  a.send({ t: 'grab', target: b.id, on: true });
  await b.expect('grab');
  a.send({ t: 'knock', vel: [1, 2, 3] });
  await b.expect('knock');
  a.send({ t: 'ping' });
  await b.expect('ping');
  console.log('event relays OK (checkpoint, fell, grab, knock, ping)');

  // --- finish (after the countdown elapses, like real players) ---
  await new Promise((r) => setTimeout(r, Math.max(0, go.startAt - go.now + 100)));
  a.send({ t: 'flag' });
  const f1 = await b.expect('flag');
  assert(f1.done.length === 1, 'one finisher so far');
  b.send({ t: 'flag' });
  const fin = await a.expect('finish');
  assert(fin.durationMs > 0, 'duration recorded');
  assert(fin.top.some((r) => r.names.includes('alice') && r.names.includes('bob')), 'run saved to leaderboard');
  console.log(`finished in ${fin.durationMs}ms, rank ${fin.rank}, leaderboard rows: ${fin.top.length}`);

  // --- back to lobby ---
  a.send({ t: 'again' });
  await b.expect('lobbyAgain');
  console.log('play-again OK');

  a.ws.close();
  b.ws.close();
  console.log('\nALL MULTIPLAYER CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
