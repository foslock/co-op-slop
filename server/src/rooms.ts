import type { WebSocket } from 'ws';
import {
  COSMETIC_COLORS, CRANK, EYES, GAME, HATS, NET, SEESAW, generateLevel, randomSeed,
  type C2S, type Cosmetics, type GadgetState, type ItemType, type PlayerInfo, type S2C,
} from 'shared';
import { saveRun, topRuns } from './db';

const HOLD_GRACE_MS = 2500;

interface Player {
  id: string;
  ws: WebSocket;
  name: string;
  cosmetics: Cosmetics;
  ready: boolean;
  loaded: boolean;
  finished: boolean;
  falls: number;
  item: ItemType | null;
  itemId: number | null; // which spawn the held item came from, so it can be dropped back
  // latest reported transform: x,y,z,yaw,anim,vy
  state: [number, number, number, number, number, number];
}

type Phase = 'lobby' | 'loading' | 'playing' | 'finished';

// latch: first press keeps it on · hold: on while pressed, with a grace period ·
// duo: two climbers on plate 0 · twin: plates 0 and 1 pressed together ·
// crank: on while any crank plate is pressed (plate 2 is the lift deck, which
// only counts once the team is down to a single climber)
type GadgetMode = 'latch' | 'hold' | 'duo' | 'twin' | 'crank';

function playerInfo(p: Player): PlayerInfo {
  return { id: p.id, name: p.name, cosmetics: p.cosmetics, ready: p.ready };
}

/** Nicknames are shown to everyone: no markup, no control characters, sane length. */
export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function cleanCosmetics(raw: unknown): Cosmetics {
  const c = (raw ?? {}) as Partial<Cosmetics>;
  const idx = (n: unknown, len: number) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) < len ? (n as number) : 0);
  return { color: idx(c.color, COSMETIC_COLORS.length), hat: idx(c.hat, HATS.length), eyes: idx(c.eyes, EYES.length) };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const vec3 = (a: unknown): a is [number, number, number] => Array.isArray(a) && a.length === 3 && a.every(finite);

export class Room {
  code: string;
  players = new Map<string, Player>();
  hostId = '';
  phase: Phase = 'lobby';
  seed = '';
  customSeed = '';
  teamSize = 1;
  assist = false; // team shrank to one climber mid-run: co-op contraptions relax
  startAt = 0;
  itemsTaken = new Set<number>();
  itemTypes = new Map<number, ItemType>();
  plates = new Map<number, Map<number, Set<string>>>();
  gadgetStates = new Map<number, GadgetState>();
  gadgetModes = new Map<number, GadgetMode>();
  seesaws = new Set<number>();
  seesawReadyAt = new Map<number, number>();
  holdTimers = new Map<number, ReturnType<typeof setTimeout>>();
  tick: ReturnType<typeof setInterval> | null = null;
  onEmpty: () => void;

  constructor(code: string, onEmpty: () => void) {
    this.code = code;
    this.onEmpty = onEmpty;
  }

  send(p: Player, msg: S2C) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: S2C, except?: string) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id !== except && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
  }

  lobbyMsg(): S2C {
    return {
      t: 'lobby',
      players: [...this.players.values()].map(playerInfo),
      hostId: this.hostId,
      seed: this.customSeed,
    };
  }

  addPlayer(ws: WebSocket, id: string, rawName: unknown, cos: unknown): Player | string {
    if (this.phase !== 'lobby') return 'Game already in progress';
    if (this.players.size >= GAME.maxPlayers) return 'Room is full';
    const name = cleanName(rawName) || 'Player';
    let finalName = name;
    let i = 2;
    while ([...this.players.values()].some((p) => p.name === finalName)) finalName = `${name.slice(0, 13)}-${i++}`;
    const p: Player = {
      id, ws, name: finalName, cosmetics: cleanCosmetics(cos), ready: false, loaded: false,
      finished: false, falls: 0, item: null, itemId: null, state: [0, 1, 0, 0, 0, 0],
    };
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    this.broadcast(this.lobbyMsg());
    return p;
  }

  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    // free any plates they were standing on
    for (const [gid, plateMap] of this.plates) {
      let changed = false;
      for (const set of plateMap.values()) changed = set.delete(id) || changed;
      if (changed) this.recomputeGadget(gid);
    }
    if (this.players.size === 0) {
      this.destroy();
      return;
    }
    if (this.hostId === id) this.hostId = [...this.players.keys()][0];
    // an item walks out with its holder otherwise — put it back where they were
    if (this.phase === 'playing' && p.item && p.itemId !== null) {
      this.itemsTaken.delete(p.itemId);
      this.broadcast({ t: 'dropped', player: p.id, item: p.itemId, p: [p.state[0], p.state[1], p.state[2]] });
    }
    this.broadcast(this.lobbyMsg()); // lets clients drop the avatar + update host
    if (this.phase === 'playing') {
      // a team of one can't work the two-player contraptions any more
      if (this.players.size === 1 && this.teamSize >= 2 && !this.assist) {
        this.assist = true;
        this.broadcast({ t: 'assist', on: true });
        for (const gid of this.gadgetModes.keys()) this.recomputeGadget(gid);
      }
      this.checkAllFinished();
    }
    if (this.phase === 'loading') this.checkAllLoaded();
  }

  // Host shut the room down: tell everyone, then drop the room so the code can't
  // be rejoined. Clients go home on 'roomClosed'; we close the sockets too so a
  // stale client can't keep talking to a dead room.
  closeRoom() {
    const all = [...this.players.values()];
    this.broadcast({ t: 'roomClosed' });
    this.players.clear();
    this.destroy();
    for (const p of all) p.ws.close();
  }

  destroy() {
    if (this.tick) clearInterval(this.tick);
    for (const t of this.holdTimers.values()) clearTimeout(t);
    this.onEmpty();
  }

  handle(p: Player, msg: C2S) {
    switch (msg.t) {
      case 'cos':
        p.cosmetics = cleanCosmetics(msg.cos);
        if (this.phase === 'lobby') this.broadcast(this.lobbyMsg());
        break;
      case 'ready':
        p.ready = msg.ready === true;
        this.broadcast(this.lobbyMsg());
        break;
      case 'seed':
        if (p.id === this.hostId && typeof msg.seed === 'string') {
          this.customSeed = msg.seed.replace(/[^\w-]/g, '').slice(0, 24);
          this.broadcast(this.lobbyMsg());
        }
        break;
      case 'start': {
        if (p.id !== this.hostId || this.phase !== 'lobby') break;
        const allReady = [...this.players.values()].every((q) => q.ready || q.id === this.hostId);
        if (!allReady) {
          this.send(p, { t: 'error', msg: 'Not everyone is ready yet' });
          break;
        }
        this.phase = 'loading';
        this.seed = this.customSeed || randomSeed();
        this.teamSize = this.players.size;
        this.assist = false;
        for (const q of this.players.values()) {
          q.loaded = false; q.finished = false; q.falls = 0; q.item = null; q.itemId = null;
          q.state = [0, 1, 0, 0, 0, 0];
        }
        this.itemsTaken.clear();
        this.plates.clear();
        this.gadgetStates.clear();
        for (const t of this.holdTimers.values()) clearTimeout(t);
        this.holdTimers.clear();
        // The server generates the same level from the seed, so it knows gadget
        // activation rules and item types without trusting clients.
        const level = generateLevel(this.seed, this.teamSize);
        this.gadgetModes.clear();
        this.seesaws.clear();
        this.seesawReadyAt.clear();
        for (const g of level.gadgets) {
          if (g.kind === 'bridge') this.gadgetModes.set(g.id, g.mode);
          else if (g.kind === 'cranklift') this.gadgetModes.set(g.id, 'crank');
          else if (g.kind === 'seesaw') this.seesaws.add(g.id);
        }
        this.itemTypes = new Map(level.items.map((it) => [it.id, it.type]));
        this.broadcast({ t: 'starting', seed: this.seed, teamSize: this.teamSize, now: Date.now() });
        break;
      }
      case 'loaded':
        p.loaded = true;
        this.checkAllLoaded();
        break;
      case 'state':
        if (!vec3(msg.p) || !finite(msg.yaw) || !finite(msg.anim) || !finite(msg.vy)) break;
        p.state = [msg.p[0], msg.p[1], msg.p[2], msg.yaw, msg.anim, msg.vy];
        break;
      case 'plate': {
        if (this.phase !== 'playing' || !this.gadgetModes.has(msg.gadget) || !Number.isInteger(msg.plate)) break;
        let plateMap = this.plates.get(msg.gadget);
        if (!plateMap) { plateMap = new Map(); this.plates.set(msg.gadget, plateMap); }
        let set = plateMap.get(msg.plate);
        if (!set) { set = new Set(); plateMap.set(msg.plate, set); }
        if (msg.on) set.add(p.id);
        else set.delete(p.id);
        this.recomputeGadget(msg.gadget);
        break;
      }
      case 'slam': {
        // Seesaw flip — from a climber landing on the slam end, or the lever up top.
        if (this.phase !== 'playing' || !this.seesaws.has(msg.gadget)) break;
        const now = Date.now();
        if (now < (this.seesawReadyAt.get(msg.gadget) ?? 0)) break;
        this.seesawReadyAt.set(msg.gadget, now + SEESAW.cooldownMs);
        this.broadcast({ t: 'launch', gadget: msg.gadget, by: p.id, lever: msg.lever === true });
        break;
      }
      case 'help': {
        if (this.phase !== 'playing' || !this.players.has(msg.target) || msg.target === p.id) break;
        this.broadcast({ t: 'help', from: p.id, target: msg.target });
        break;
      }
      case 'checkpoint':
        if (!Number.isInteger(msg.index)) break;
        this.broadcast({ t: 'checkpoint', player: p.id, index: msg.index });
        break;
      case 'fell':
        p.falls++;
        this.broadcast({ t: 'fell', player: p.id }, p.id);
        break;
      case 'pickup': {
        if (this.itemsTaken.has(msg.item) || p.item) break;
        const type = this.itemTypes.get(msg.item);
        if (!type) break;
        this.itemsTaken.add(msg.item);
        p.item = type;
        p.itemId = msg.item;
        this.broadcast({ t: 'pickup', player: p.id, item: msg.item });
        break;
      }
      case 'give': {
        const target = this.players.get(msg.to);
        if (!target || target === p || !p.item || target.item) break;
        target.item = p.item;
        target.itemId = p.itemId;
        p.item = null;
        p.itemId = null;
        this.broadcast({ t: 'item', player: p.id, item: null });
        this.broadcast({ t: 'item', player: target.id, item: target.item });
        break;
      }
      case 'drop': {
        // Back into the world where it was dropped — anyone can pick it up again.
        if (!p.item || p.itemId === null || !vec3(msg.p)) break;
        const id = p.itemId;
        this.itemsTaken.delete(id);
        p.item = null;
        p.itemId = null;
        this.broadcast({ t: 'dropped', player: p.id, item: id, p: msg.p });
        break;
      }
      case 'grapple':
        if (p.item !== 'grapple' || !vec3(msg.top) || !finite(msg.length)) break;
        p.item = null;
        p.itemId = null;
        this.broadcast({ t: 'item', player: p.id, item: null });
        this.broadcast({ t: 'rope', top: msg.top, length: Math.min(45, Math.max(3, msg.length)), exit: vec3(msg.exit) ? msg.exit : undefined, by: p.id });
        break;
      case 'grab':
        if (!this.players.has(msg.target)) break;
        this.broadcast({ t: 'grab', from: p.id, target: msg.target, on: msg.on === true }, p.id);
        break;
      case 'knock':
        if (!vec3(msg.vel)) break;
        this.broadcast({ t: 'knock', player: p.id, vel: msg.vel }, p.id);
        break;
      case 'ping':
        this.broadcast({ t: 'ping', player: p.id, p: [p.state[0], p.state[1], p.state[2]] });
        break;
      case 'flag': {
        if (this.phase !== 'playing' || p.finished) break;
        p.finished = true;
        const done = [...this.players.values()].filter((q) => q.finished).map((q) => q.id);
        this.broadcast({ t: 'flag', player: p.id, done });
        this.checkAllFinished();
        break;
      }
      case 'again':
        if (p.id !== this.hostId || this.phase === 'lobby') break;
        this.phase = 'lobby';
        for (const q of this.players.values()) q.ready = false;
        if (this.tick) { clearInterval(this.tick); this.tick = null; }
        for (const t of this.holdTimers.values()) clearTimeout(t);
        this.holdTimers.clear();
        this.broadcast({ t: 'lobbyAgain' });
        this.broadcast(this.lobbyMsg());
        break;
      case 'close':
        if (p.id !== this.hostId) break;
        this.closeRoom();
        break;
      case 'leave':
        // handled by connection close in index.ts; nothing to do here
        break;
    }
  }

  checkAllLoaded() {
    if (this.phase !== 'loading') return;
    if (![...this.players.values()].every((p) => p.loaded)) return;
    this.phase = 'playing';
    this.startAt = Date.now() + GAME.countdownMs;
    this.broadcast({ t: 'go', now: Date.now(), startAt: this.startAt });
    // someone may have left while everyone loaded
    if (this.players.size === 1 && this.teamSize >= 2) {
      this.assist = true;
      this.broadcast({ t: 'assist', on: true });
    }
    this.tick = setInterval(() => this.broadcastStates(), 1000 / NET.broadcastHz);
  }

  broadcastStates() {
    const players: Record<string, [number, number, number, number, number, number]> = {};
    for (const p of this.players.values()) players[p.id] = p.state;
    this.broadcast({ t: 'S', time: Date.now(), players });
  }

  recomputeGadget(id: number) {
    const plateMap = this.plates.get(id);
    const prev = this.gadgetStates.get(id) ?? { active: false, latched: false, since: 0, plates: [] };
    const counts: number[] = [];
    if (plateMap) for (const [idx, set] of plateMap) counts[idx] = set.size;
    for (let i = 0; i < counts.length; i++) counts[i] = counts[i] ?? 0;
    const at = (i: number) => counts[i] ?? 0;
    const mode = this.gadgetModes.get(id) ?? 'latch';
    let active = prev.active;
    let latched = prev.latched;
    const holdWithGrace = (pressed: boolean, graceMs: number) => {
      const timer = this.holdTimers.get(id);
      if (pressed) {
        if (timer) { clearTimeout(timer); this.holdTimers.delete(id); }
        active = true;
      } else if (prev.active && !timer) {
        this.holdTimers.set(id, setTimeout(() => {
          this.holdTimers.delete(id);
          const cur = this.gadgetStates.get(id);
          if (!cur || !cur.active) return;
          const next: GadgetState = { ...cur, active: false, since: Date.now() };
          this.gadgetStates.set(id, next);
          this.broadcast({ t: 'gadget', id, state: next });
        }, graceMs));
      }
    };
    switch (mode) {
      case 'latch':
        if (at(0) + at(1) > 0) latched = true;
        active = latched;
        break;
      case 'duo':
        if (at(0) >= (this.assist ? 1 : 2)) latched = true;
        active = latched;
        break;
      case 'twin':
        if (this.assist ? at(0) + at(1) > 0 : at(0) > 0 && at(1) > 0) latched = true;
        active = latched;
        break;
      case 'hold':
        holdWithGrace(at(0) + at(1) > 0, HOLD_GRACE_MS);
        break;
      case 'crank':
        holdWithGrace(at(0) + at(1) > 0 || (this.assist && at(2) > 0), CRANK.graceMs);
        break;
    }
    const changed = active !== prev.active || latched !== prev.latched ||
      JSON.stringify(counts) !== JSON.stringify(prev.plates);
    if (changed) {
      const next: GadgetState = {
        active, latched, plates: counts,
        since: active !== prev.active ? Date.now() : prev.since,
      };
      this.gadgetStates.set(id, next);
      this.broadcast({ t: 'gadget', id, state: next });
    }
  }

  async checkAllFinished() {
    if (this.phase !== 'playing') return;
    const all = [...this.players.values()];
    if (all.length === 0 || !all.every((p) => p.finished)) return;
    this.phase = 'finished';
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    const durationMs = Math.max(1, Date.now() - this.startAt);
    const names = all.map((p) => p.name);
    const falls: Record<string, number> = {};
    for (const p of all) falls[p.id] = p.falls;
    let rank: number | null = null;
    let top: Awaited<ReturnType<typeof topRuns>> = [];
    try {
      rank = await saveRun(names, this.seed, durationMs);
      top = await topRuns(10);
    } catch (err) {
      console.error('[db] failed to save run', err);
    }
    this.broadcast({ t: 'finish', durationMs, falls, rank, top });
  }
}

const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class RoomManager {
  rooms = new Map<string, Room>();

  create(): Room {
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, () => this.rooms.delete(code));
    this.rooms.set(code, room);
    return room;
  }

  get(code: unknown): Room | undefined {
    return typeof code === 'string' ? this.rooms.get(code.toUpperCase()) : undefined;
  }
}
