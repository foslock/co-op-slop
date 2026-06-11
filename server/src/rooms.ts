import type { WebSocket } from 'ws';
import {
  GAME, NET, generateLevel, randomSeed,
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
  // latest reported transform: x,y,z,yaw,anim,vy
  state: [number, number, number, number, number, number];
}

type Phase = 'lobby' | 'loading' | 'playing' | 'finished';

function playerInfo(p: Player): PlayerInfo {
  return { id: p.id, name: p.name, cosmetics: p.cosmetics, ready: p.ready };
}

export class Room {
  code: string;
  players = new Map<string, Player>();
  hostId = '';
  phase: Phase = 'lobby';
  seed = '';
  customSeed = '';
  startAt = 0;
  itemsTaken = new Set<number>();
  itemTypes = new Map<number, ItemType>();
  plates = new Map<number, Map<number, Set<string>>>();
  gadgetStates = new Map<number, GadgetState>();
  gadgetModes = new Map<number, { mode: string; plateCount: number }>();
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

  addPlayer(ws: WebSocket, id: string, name: string, cos: Cosmetics): Player | string {
    if (this.phase !== 'lobby') return 'Game already in progress';
    if (this.players.size >= GAME.maxPlayers) return 'Room is full';
    let finalName = name.slice(0, 16) || 'Player';
    let i = 2;
    while ([...this.players.values()].some((p) => p.name === finalName)) finalName = `${name.slice(0, 13)}-${i++}`;
    const p: Player = {
      id, ws, name: finalName, cosmetics: cos, ready: false, loaded: false,
      finished: false, falls: 0, item: null, state: [0, 1, 0, 0, 0, 0],
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
    if (this.phase === 'lobby') this.broadcast(this.lobbyMsg());
    else {
      this.broadcast(this.lobbyMsg()); // lets clients drop the avatar + update host
      if (this.phase === 'playing') this.checkAllFinished();
      if (this.phase === 'loading') this.checkAllLoaded();
    }
  }

  destroy() {
    if (this.tick) clearInterval(this.tick);
    for (const t of this.holdTimers.values()) clearTimeout(t);
    this.onEmpty();
  }

  handle(p: Player, msg: C2S) {
    switch (msg.t) {
      case 'cos':
        p.cosmetics = msg.cos;
        if (this.phase === 'lobby') this.broadcast(this.lobbyMsg());
        break;
      case 'ready':
        p.ready = msg.ready;
        this.broadcast(this.lobbyMsg());
        break;
      case 'seed':
        if (p.id === this.hostId) {
          this.customSeed = msg.seed.slice(0, 24);
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
        for (const q of this.players.values()) {
          q.loaded = false; q.finished = false; q.falls = 0; q.item = null;
          q.state = [0, 1, 0, 0, 0, 0];
        }
        this.itemsTaken.clear();
        this.plates.clear();
        this.gadgetStates.clear();
        // The server generates the same level from the seed, so it knows gadget
        // activation rules and item types without trusting clients.
        const level = generateLevel(this.seed);
        this.gadgetModes.clear();
        for (const g of level.gadgets) {
          if (g.kind === 'bridge') this.gadgetModes.set(g.id, { mode: g.mode, plateCount: g.plates.length });
        }
        this.itemTypes = new Map(level.items.map((it) => [it.id, it.type]));
        this.broadcast({ t: 'starting', seed: this.seed, now: Date.now() });
        break;
      }
      case 'loaded':
        p.loaded = true;
        this.checkAllLoaded();
        break;
      case 'state':
        p.state = [msg.p[0], msg.p[1], msg.p[2], msg.yaw, msg.anim, msg.vy];
        break;
      case 'plate': {
        if (this.phase !== 'playing') break;
        let plateMap = this.plates.get(msg.gadget);
        if (!plateMap) { plateMap = new Map(); this.plates.set(msg.gadget, plateMap); }
        let set = plateMap.get(msg.plate);
        if (!set) { set = new Set(); plateMap.set(msg.plate, set); }
        if (msg.on) set.add(p.id);
        else set.delete(p.id);
        this.recomputeGadget(msg.gadget);
        break;
      }
      case 'checkpoint':
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
        this.broadcast({ t: 'pickup', player: p.id, item: msg.item });
        break;
      }
      case 'give': {
        const target = this.players.get(msg.to);
        if (!target || !p.item || target.item) break;
        target.item = p.item;
        p.item = null;
        this.broadcast({ t: 'item', player: p.id, item: null });
        this.broadcast({ t: 'item', player: target.id, item: target.item });
        break;
      }
      case 'grapple':
        if (p.item !== 'grapple') break;
        p.item = null;
        this.broadcast({ t: 'item', player: p.id, item: null });
        this.broadcast({ t: 'rope', top: msg.top, length: msg.length, by: p.id });
        break;
      case 'grab':
        this.broadcast({ t: 'grab', from: p.id, target: msg.target, on: msg.on }, p.id);
        break;
      case 'knock':
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
        this.broadcast({ t: 'lobbyAgain' });
        this.broadcast(this.lobbyMsg());
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
    let total = 0;
    if (plateMap) {
      for (const [idx, set] of plateMap) {
        counts[idx] = set.size;
        total += set.size;
      }
    }
    for (let i = 0; i < counts.length; i++) counts[i] = counts[i] ?? 0;
    // Mode rules. Without registered metadata (clients know the level; server just
    // needs activation semantics), infer: duo gadgets are flagged by clients via
    // plate index 0 needing 2; we keep it simple and derive from gadgetModes if set.
    const meta = this.gadgetModes.get(id);
    const mode = meta?.mode ?? 'latch';
    let active = prev.active;
    let latched = prev.latched;
    if (mode === 'latch') {
      if (total > 0) latched = true;
      active = latched;
    } else if (mode === 'duo') {
      if ((counts[0] ?? 0) >= 2) latched = true;
      active = latched;
    } else {
      // hold: active while anyone is on a plate, with a grace period after release
      const timer = this.holdTimers.get(id);
      if (total > 0) {
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
        }, HOLD_GRACE_MS));
      }
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

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }
}
