import { MOVE, TRAVERSE, gapScaleAtZone, gravityScaleAtZone } from './constants';
import { BRIDGE, CRANK, MOVER, SEESAW, ballisticVelocity, moverPeriod } from './gadgets';
import { makeRng, type Rng } from './rng';
import { Space, box, circle, colliderRadius, propVols, segmentBox, type Vol } from './space';
import { ARCHETYPES, FINALE_THEMES, HOUSE_THEMES, type ThemeDef } from './themes';
import type { BridgeMode, CheckpointData, GadgetData, ItemSpawn, ItemType, LevelData, PropInstance, Vec3, ZoneData } from './types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export interface PathStep {
  from: Vec3;
  to: Vec3;
  kind: 'jump' | 'gadget';
  gap: number; // edge-to-edge horizontal distance
  dy: number;
  zone: number; // zone index — reachability limits scale with altitude gravity
  via?: string; // which contraption carries you across a gadget step
}

export type GadgetKind =
  | 'ladder' | 'bridge' | 'rope' | 'shuttle' | 'traverse' | 'lift' | 'spinner'
  // co-op only (never generated for a solo climber)
  | 'seesaw' | 'cranklift' | 'twinbridge' | 'duobridge';

interface GenState {
  rng: Rng;
  props: PropInstance[];
  gadgets: GadgetData[];
  items: ItemSpawn[];
  checkpoints: CheckpointData[];
  nodes: Vec3[];
  steps: PathStep[];
  space: Space;
  cur: Vec3; // top-center of the current path platform
  curR: number;
  curArch: string;
  curOwner: number;
  zone: number;
  heading: number; // walk direction in the XZ plane
  turnDir: number;
  gadgetId: number;
  itemId: number;
  nextOwner: number;
  coop: boolean;
  issues: string[];
}

const ITEM_CYCLE: ItemType[] = ['doublejump', 'grapple', 'telescope'];

export const ZONES_PER_RUN = 10;

// A run visits six of the ten indoor rooms plus the four closing sky zones, so
// the climb stays the length it was tuned for while the rooms you pass through
// change from seed to seed. Rooms are always entered in narrative order, and
// the opener is one of the three lowest so a run starts at the bottom of the house.
function pickZones(rng: Rng): ThemeDef[] {
  const opener = rng.pick(HOUSE_THEMES.filter((t) => t.floor <= 2));
  const bag = HOUSE_THEMES.filter((t) => t.floor > opener.floor);
  const middle: ThemeDef[] = [];
  const want = ZONES_PER_RUN - FINALE_THEMES.length - 1;
  while (middle.length < want && bag.length > 0) middle.push(bag.splice(rng.int(0, bag.length - 1), 1)[0]);
  middle.sort((a, b) => a.floor - b.floor);
  return [opener, ...middle, ...FINALE_THEMES];
}

/** Headroom kept clear over every surface you stand on: a full jump, plus the body. */
export function headroomAtZone(zone: number): number {
  return 1.5 + (2.0 / gravityScaleAtZone(zone)) * 0.8;
}

// ---- small geometry helpers ----

function along(p: Vec3, h: number, d: number, dy = 0): Vec3 {
  return v(p.x + Math.cos(h) * d, p.y + dy, p.z + Math.sin(h) * d);
}

/** Box aligned with heading h: `ahead` half-length along it, `side` half-width across. */
function obox(kind: Vol['kind'], cx: number, cz: number, ahead: number, side: number, h: number, y0: number, y1: number, owners: number[], tag?: string): Vol {
  return box(kind, cx, cz, ahead, side, -h, y0, y1, owners, tag);
}

function topClear(top: Vec3, r: number, zone: number, owners: number[]): Vol {
  return circle('clear', top.x, top.z, r, top.y + 0.03, top.y + headroomAtZone(zone), owners, 'head');
}

/** The body-sized tube a jump from a to b sweeps through. */
function arcVols(a: Vec3, b: Vec3, owners: number[]): Vol[] {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(2, Math.ceil(d / 1.0));
  const lift = 0.8 + Math.max(0, b.y - a.y) * 0.5;
  const out: Vol[] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const y = a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * lift + 0.7;
    out.push(circle('clear', a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 0.42, y - 0.7, y + 0.72, owners, 'arc'));
  }
  return out;
}

function headingToKeepRadiusInBand(s: GenState): number {
  // Walk tangentially around the tower axis, blending in a radial pull that
  // keeps the path inside a comfortable cylinder (so it reads as a climb, not a sprawl).
  const r = Math.hypot(s.cur.x, s.cur.z);
  const a = Math.atan2(s.cur.z, s.cur.x);
  let k: number; // radial blend: + outward, - inward
  if (r > 15) k = -0.95;
  else if (r < 8) k = 0.95;
  else k = s.rng.float(-0.25, 0.25);
  const hx = -Math.sin(a) * s.turnDir + Math.cos(a) * k;
  const hz = Math.cos(a) * s.turnDir + Math.sin(a) * k;
  return Math.atan2(hz, hx) + s.rng.float(-0.3, 0.3);
}

/** Preferred heading first, then fanning out on both sides. */
function headingCandidates(s: GenState, spread = 2.25): number[] {
  const base = headingToKeepRadiusInBand(s);
  if (s.rng.chance(0.18)) s.turnDir *= -1;
  const out = [base];
  for (let k = 1; k * 0.45 <= spread + 1e-6; k++) out.push(base + k * 0.45, base - k * 0.45);
  return out;
}

/** A seeded shuffle of archetype ids. */
function archOrder(s: GenState, ids: string[]): string[] {
  const pool = [...ids];
  const out: string[] = [];
  while (pool.length > 0) out.push(pool.splice(s.rng.int(0, pool.length - 1), 1)[0]);
  return out;
}

const pathable = (t: ThemeDef) => t.pathProps.filter((p) => ARCHETYPES[p].pathable);
/** Wide tops, so gadget landings are never a pinpoint hop. */
const wide = (t: ThemeDef) => {
  const w = pathable(t).filter((p) => ARCHETYPES[p].topRadius >= 1.1);
  return w.length > 0 ? w : pathable(t);
};
/** Body barely wider than the top, so a moving deck can park right against it. */
const snug = (ids: string[], slack: number) => ids.filter((p) => colliderRadius(p) - ARCHETYPES[p].topRadius <= slack);

// ---- placement search ----

interface Placement {
  archId: string;
  heading: number;
  top: Vec3;
  prop: PropInstance;
  owner: number;
  vols: Vol[];
  soft: number;
  hard: number;
}

type Placer = (archId: string, heading: number, owner: number) =>
  | { top: Vec3; rotY: number; extra?: Vol[]; arc?: boolean }
  | null;

interface Origin {
  top: Vec3;
  owner: number;
}

/**
 * Try archetype × heading combinations (preferred ones first) and return the
 * first placement with no conflicts at all, else the one with the fewest soft
 * conflicts. Hard conflicts disqualify unless `force` is set, which returns the
 * least-bad option so generation can always finish.
 */
function search(s: GenState, archIds: string[], headings: number[], placer: Placer, opts: { origin?: Origin; force?: boolean; budget?: number } = {}): Placement | null {
  const origin = opts.origin ?? { top: s.cur, owner: s.curOwner };
  const owner = s.nextOwner;
  const pairs: [number, number][] = [];
  for (let a = 0; a < archIds.length; a++) for (let h = 0; h < headings.length; h++) pairs.push([a, h]);
  // favour the seeded archetype first, but don't bend the path all the way round before trying another
  pairs.sort((p, q) => p[1] + p[0] * 1.6 - (q[1] + q[0] * 1.6));
  let best: Placement | null = null;
  let worst: Placement | null = null;
  for (const [ai, hi] of pairs.slice(0, opts.budget ?? (opts.force ? 400 : 90))) {
    const archId = archIds[ai];
    const heading = headings[hi];
    const p = placer(archId, heading, owner);
    if (!p) continue;
    const arch = ARCHETYPES[archId];
    const prop: PropInstance = { archetype: archId, pos: v(p.top.x, p.top.y - arch.topY, p.top.z), rotY: p.rotY, solid: true };
    const vols = [
      ...propVols(prop, owner),
      topClear(p.top, arch.topRadius, s.zone, [owner]),
      ...(p.arc === false ? [] : arcVols(origin.top, p.top, [origin.owner, owner])),
      ...(p.extra ?? []),
    ];
    const res = s.space.test(vols, !opts.force);
    const cand: Placement = { archId, heading, top: p.top, prop, owner, vols, soft: res.soft, hard: res.hard };
    if (res.hard > 0) {
      if (opts.force && (!worst || res.hard < worst.hard || (res.hard === worst.hard && res.soft < worst.soft))) worst = cand;
      continue;
    }
    if (!best || res.soft < best.soft) best = cand;
    if (res.soft === 0) break;
  }
  return best ?? worst;
}

/** Make a placement the new head of the climbing path. */
function commit(s: GenState, pl: Placement, kind: PathStep['kind'], gap: number, dy: number, via?: string) {
  commitBranch(s, pl);
  s.steps.push({ from: { ...s.cur }, to: { ...pl.top }, kind, gap, dy, zone: s.zone, via });
  s.nodes.push({ ...pl.top });
  s.cur = pl.top;
  s.curR = ARCHETYPES[pl.archId].topRadius;
  s.curArch = pl.archId;
  s.curOwner = pl.owner;
  s.heading = pl.heading;
}

/** Add a placement to the world without moving the path head (side platforms). */
function commitBranch(s: GenState, pl: Placement) {
  if (pl.hard > 0) s.issues.push(`zone ${s.zone}: forced ${pl.archId} with ${pl.hard} hard conflict(s)`);
  s.props.push(pl.prop);
  s.space.add(pl.vols);
  s.nextOwner++;
}

// ---- path steps ----

function jumpPlacer(s: GenState, gap: number, dy: number, rotY: number, align = false): Placer {
  return (archId, h) => {
    const dist = gap + s.curR + ARCHETYPES[archId].topRadius;
    // alignToPath turns the prop's local X axis perpendicular to the walk direction,
    // so arch-style props (checkpoint gates) are entered straight on.
    return { top: along(s.cur, h, dist, dy), rotY: align ? Math.PI * 1.5 - h : rotY };
  };
}

function placeJumpStep(s: GenState, theme: ThemeDef, zi: number, only?: string[], climb = false) {
  const r = climb ? 0 : s.rng.float();
  // low gravity higher up = bigger jumps; widen everything by the damped scale
  const gs = gapScaleAtZone(zi);
  let gap: number, dy: number;
  if (r < 0.42) {
    gap = s.rng.float(0.3, 1.0) * gs; dy = s.rng.float(0.9, 1.4) * gs; // step up
  } else if (r < 0.78) {
    gap = s.rng.float(2.0, 3.0) * gs; dy = s.rng.float(-0.2, 0.5); // hop across
  } else if (r < 0.9) {
    gap = s.rng.float(3.0, MOVE.maxGapDown - 0.3) * gs; dy = s.rng.float(-1.8, -0.6); // long hop down
  } else {
    gap = s.rng.float(0.2, 0.6); dy = s.rng.float(1.3, MOVE.maxStepUp) * gs; // tall step
  }
  const rotY = s.rng.float(0, Math.PI * 2);
  const ids = archOrder(s, only && only.length > 0 ? only : pathable(theme));
  const heads = headingCandidates(s);
  let pl = search(s, ids, heads, jumpPlacer(s, gap, dy, rotY));
  if (!pl) {
    // Boxed in. Try, in order: the same hop in any direction with any prop, a
    // tight tall step up out of the clutter, and a long hop down and away.
    const all = [...heads, ...heads.map((h) => h + Math.PI)];
    const props = archOrder(s, pathable(theme));
    const reliefs: [number, number][] = [[gap, dy], [0.35, MOVE.maxStepUp * gs * 0.92], [2.6 * gs, 0.3], [3.4 * gs, -1.4]];
    for (const [rg, rdy] of reliefs) {
      pl = search(s, props, all, jumpPlacer(s, rg, rdy, rotY), { budget: 400 });
      if (pl) { gap = rg; dy = rdy; break; }
    }
    // still stuck: climb straight out of it with a ladder or rope
    if (!pl && (placeLadder(s, theme, zi) || placeRope(s, theme, zi))) return;
    if (!pl) pl = search(s, props, all, jumpPlacer(s, gap, dy, rotY), { force: true })!;
  }
  commit(s, pl, 'jump', gap, dy);
}

/**
 * A fixed pad (checkpoint/summit): try a few spacings in every direction; if the
 * path is boxed in, climb out with a ladder or rope and try again before forcing.
 */
function padPlacement(s: GenState, theme: ThemeDef, zi: number, archId: string, spacings: [number, number][], align: boolean): { pl: Placement; gap: number; dy: number } {
  for (let attempt = 0; attempt < 3; attempt++) {
    const heads = headingCandidates(s, Math.PI);
    for (const [gap, dy] of spacings) {
      const pl = search(s, [archId], heads, jumpPlacer(s, gap, dy, 0, align), { budget: 400 });
      if (pl) return { pl, gap, dy };
    }
    if (attempt < 2 && !placeLadder(s, theme, zi) && !placeRope(s, theme, zi)) break;
  }
  const [gap, dy] = spacings[0];
  return { pl: search(s, [archId], headingCandidates(s, Math.PI), jumpPlacer(s, gap, dy, 0, align), { force: true })!, gap, dy };
}

function placeCheckpoint(s: GenState, theme: ThemeDef, zi: number) {
  // Checkpoint pad marks the theme change; easy step up onto it, arch facing the approach.
  const gs = gapScaleAtZone(zi);
  const { pl, gap, dy } = padPlacement(s, theme, zi, 'checkpoint_pad', [[s.rng.float(1.2, 2.0), s.rng.float(0.8, 1.2)], [1.0 * gs, 1.4 * gs], [2.4 * gs, 0.4], [0.5, 1.45 * gs]], true);
  commit(s, pl, 'jump', gap, dy);
  const top = pl.top;
  // the gate's pillars are decoration — keep later jumps from passing through them
  const px = -Math.sin(pl.heading) * 2.3;
  const pz = Math.cos(pl.heading) * 2.3;
  const pillarOwner = s.nextOwner++;
  s.space.add([
    circle('visual', top.x + px, top.z + pz, 0.3, top.y, top.y + 3.6, [pillarOwner], 'pillar'),
    circle('visual', top.x - px, top.z - pz, 0.3, top.y, top.y + 3.6, [pillarOwner], 'pillar'),
  ]);
  s.checkpoints.push({ index: zi, pos: v(top.x, top.y + 0.05, top.z), zone: zi, rotY: Math.PI * 1.5 - pl.heading });
}

// ---- gadgets ----

function bridgePlates(near: Vec3, nearR: number, far: Vec3, farR: number, h: number, mode: BridgeMode): Vec3[] {
  const plates: Vec3[] = [along(near, h, -nearR * 0.3)];
  if (mode === 'hold') plates.push(along(far, h, farR * 0.3));
  return plates;
}

function placeBridge(s: GenState, theme: ThemeDef, zi: number, mode: BridgeMode): boolean {
  const near = { ...s.cur };
  const nearR = s.curR;
  const nearOwner = s.curOwner;
  // Far platform at the same height across a gap far too wide to jump.
  // Scale by the FULL jump-range gain so floaty late-game jumps can't skip the bridge.
  const span = s.rng.float(6.5, 9) / gravityScaleAtZone(zi);
  const rotY = s.rng.float(0, Math.PI * 2);
  const head = headroomAtZone(zi);
  const pl = search(s, archOrder(s, wide(theme)), headingCandidates(s, 1.35), (archId, h, owner) => {
    const farR = ARCHETYPES[archId].topRadius;
    const far = along(near, h, span + nearR + farR);
    const ne = along(near, h, nearR * 0.75);
    const fe = along(far, h, -farR * 0.75);
    return {
      top: far, rotY, arc: false,
      extra: [
        segmentBox('solid', ne.x, ne.z, fe.x, fe.z, BRIDGE.width / 2, near.y - BRIDGE.thickness, near.y, [nearOwner, owner], 'deck'),
        segmentBox('clear', ne.x, ne.z, fe.x, fe.z, BRIDGE.width / 2, near.y + 0.03, near.y + head, [nearOwner, owner], 'deckwalk'),
      ],
    };
  });
  if (!pl) return false;
  const id = s.gadgetId++;
  commit(s, pl, 'gadget', span, 0, `bridge:${mode}`);
  const far = pl.top;
  const farR = s.curR;
  const h = pl.heading;
  const nearEdge = along(near, h, nearR * 0.75);
  const farEdge = along(far, h, -farR * 0.75);
  const length = Math.hypot(farEdge.x - nearEdge.x, farEdge.z - nearEdge.z) + 0.8;
  let finalMode = mode;
  const plates = bridgePlates(near, nearR, far, farR, h, mode);
  if (mode === 'twin') {
    // The second plate sits on a side platform a hop away from the near end, so
    // the pair has to split up and press both at once.
    const gs = gapScaleAtZone(zi);
    const gap = s.rng.float(1.6, 2.4) * gs;
    const dy = s.rng.float(-0.3, 0.5);
    const side = s.rng.chance(0.5) ? 1 : -1;
    const sideRot = s.rng.float(0, Math.PI * 2);
    const heads = [0, 0.35, -0.35, 0.7, -0.7].map((o) => h + side * (Math.PI / 2 + 0.25) + o)
      .concat([0, 0.35, -0.35].map((o) => h - side * (Math.PI / 2 + 0.25) + o));
    const branch = search(s, archOrder(s, pathable(theme)), heads, (archId, hh) => ({
      top: along(near, hh, gap + nearR + ARCHETYPES[archId].topRadius, dy), rotY: sideRot,
    }), { origin: { top: near, owner: nearOwner } });
    if (branch) {
      commitBranch(s, branch);
      plates.push(v(branch.top.x, branch.top.y, branch.top.z));
    } else finalMode = 'duo';
  }
  s.gadgets.push({ kind: 'bridge', id, near: nearEdge, rotY: h, length, mode: finalMode, plates });
  return true;
}

function placeLadder(s: GenState, theme: ThemeDef, zi: number): boolean {
  const A = { ...s.cur };
  const aR = s.curR;
  const aOwner = s.curOwner;
  const rise = s.rng.float(5.5, 7.5);
  const rotY = s.rng.float(0, Math.PI * 2);
  // The next prop stands just clear of this platform's edge; the ladder leans
  // from our rim up against its top edge.
  const geom = (archId: string, h: number) => {
    const topR = ARCHETYPES[archId].topRadius;
    const top = along(A, h, aR + colliderRadius(archId) + 0.3, rise);
    return {
      top,
      base: along(A, h, aR - 0.25),
      rungTop: along(top, h, -(topR - 0.15), 0.35),
      exit: along(top, h, -topR * 0.35, 0.05),
    };
  };
  const pl = search(s, archOrder(s, pathable(theme)), headingCandidates(s, 1.8), (archId, h, owner) => {
    const g = geom(archId, h);
    const run = Math.hypot(g.rungTop.x - g.base.x, g.rungTop.z - g.base.z);
    const mid = along(g.base, h, run / 2 - 0.2);
    return {
      top: g.top, rotY, arc: false,
      extra: [obox('clear', mid.x, mid.z, run / 2 + 0.55, 1.05, h, A.y + 0.05, g.rungTop.y, [aOwner, owner], 'ladder')],
    };
  });
  if (!pl) return false;
  const id = s.gadgetId++;
  const g = geom(pl.archId, pl.heading);
  commit(s, pl, 'gadget', 0, rise, 'ladder');
  s.gadgets.push({ kind: 'ladder', id, base: g.base, top: g.rungTop, rotY: pl.heading, exit: g.exit });
  return true;
}

function placeRope(s: GenState, theme: ThemeDef, zi: number): boolean {
  const A = { ...s.cur };
  const aR = s.curR;
  const aOwner = s.curOwner;
  const rise = s.rng.float(6.5, 9);
  const rotY = s.rng.float(0, Math.PI * 2);
  // The rope hangs from a short hook arm reaching past the upper prop's body,
  // so it dangles in open air just beyond this platform's rim.
  const geomFor = (archId: string, h: number) => {
    const out = colliderRadius(archId) + 0.35;
    const top = along(A, h, aR + 0.65 + out, rise);
    const anchor = along(top, h, -out, 0.45);
    return { top, anchor, exit: along(top, h, -ARCHETYPES[archId].topRadius * 0.3, 0.05) };
  };
  const pl = search(s, archOrder(s, pathable(theme)), headingCandidates(s, 1.8), (archId, h) => {
    const g = geomFor(archId, h);
    const c = along(g.anchor, h, -0.25);
    return {
      top: g.top, rotY, arc: false,
      extra: [circle('clear', c.x, c.z, 0.42, A.y + 0.3, g.anchor.y - 0.25, [aOwner], 'rope')],
    };
  });
  if (!pl) return false;
  const id = s.gadgetId++;
  const g = geomFor(pl.archId, pl.heading);
  commit(s, pl, 'gadget', 0, rise, 'rope');
  s.gadgets.push({ kind: 'rope', id, top: g.anchor, length: g.anchor.y - (A.y + 0.9), exit: g.exit });
  return true;
}

// A slack rope between two platform edges, strung across a gap nothing can jump.
// You drop off the near edge onto it, hang, and shimmy across the dip.
function placeTraverse(s: GenState, theme: ThemeDef, zi: number): boolean {
  const A = { ...s.cur };
  const aR = s.curR;
  const aOwner = s.curOwner;
  const span = s.rng.float(7.5, 10.5) / gravityScaleAtZone(zi);
  const rotY = s.rng.float(0, Math.PI * 2);
  const ends = (archId: string, h: number) => {
    const bR = ARCHETYPES[archId].topRadius;
    const far = along(A, h, span + aR + bR);
    return {
      far,
      a: along(A, h, aR * 0.92, TRAVERSE.anchorHeight),
      b: along(far, h, -bR * 0.92, TRAVERSE.anchorHeight),
      exitA: along(A, h, aR * 0.35, 0.05),
      exitB: along(far, h, -bR * 0.35, 0.05),
    };
  };
  const pl = search(s, archOrder(s, wide(theme)), headingCandidates(s, 1.35), (archId, h, owner) => {
    const e = ends(archId, h);
    return {
      top: e.far, rotY, arc: false,
      extra: [segmentBox('clear', e.a.x, e.a.z, e.b.x, e.b.z, 0.7, A.y - 4.3, A.y + 1.3, [aOwner, owner], 'traverse')],
    };
  });
  if (!pl) return false;
  const id = s.gadgetId++;
  const e = ends(pl.archId, pl.heading);
  commit(s, pl, 'gadget', span, 0, 'traverse');
  s.gadgets.push({ kind: 'traverse', id, a: e.a, b: e.b, deckY: A.y, exitA: e.exitA, exitB: e.exitB });
  return true;
}

// A deck that shuttles back and forth across a gap too wide to jump.
function placeShuttle(s: GenState, theme: ThemeDef, zi: number): boolean {
  const A = { ...s.cur };
  const aR = s.curR;
  const aOwner = s.curOwner;
  const aBody = colliderRadius(s.curArch);
  const span = s.rng.float(7, 10) / gravityScaleAtZone(zi);
  const dy = s.rng.chance(0.4) ? s.rng.float(-1.2, 1.6) : 0;
  const size: [number, number, number] = [2.8, 0.4, 2.3];
  const rotY = s.rng.float(0, Math.PI * 2);
  const phase = s.rng.float(0, 1);
  const head = headroomAtZone(zi);
  const ends = (archId: string, h: number) => {
    const bR = ARCHETYPES[archId].topRadius;
    const far = along(A, h, span + aR + bR, dy);
    const a = along(A, h, Math.max(aR + MOVER.edgeGap, aBody * 0.92 + 0.1) + size[0] / 2);
    const b = along(far, h, -(Math.max(bR + MOVER.edgeGap, colliderRadius(archId) * 0.92 + 0.1) + size[0] / 2));
    return { far, a, b };
  };
  const ids = archOrder(s, wide(theme));
  const preferred = [...snug(ids, 0.7), ...ids.filter((i) => !snug([i], 0.7).length)];
  const pl = search(s, preferred, headingCandidates(s, 1.35), (archId, h, owner) => {
    const { far, a, b } = ends(archId, h);
    const travel = Math.hypot(b.x - a.x, b.z - a.z);
    if (travel < 2.5) return null;
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return {
      top: far, rotY, arc: false,
      extra: [
        obox('solid', mx, mz, travel / 2 + size[0] / 2, size[2] / 2 + 0.1, h, lo - size[1], hi, [aOwner, owner], 'shuttle'),
        obox('clear', mx, mz, travel / 2 + size[0] / 2, size[2] / 2, h, lo + 0.03, hi + head, [aOwner, owner], 'shuttleride'),
      ],
    };
  });
  if (!pl) return false;
  const id = s.gadgetId++;
  const { a, b } = ends(pl.archId, pl.heading);
  commit(s, pl, 'gadget', span, dy, 'shuttle');
  const travel = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  s.gadgets.push({
    kind: 'mover', id, motion: 'shuttle', a, b, size, rotY: pl.heading,
    period: moverPeriod(travel, MOVER.shuttleSpeed), phase, rest: MOVER.rest,
  });
  return true;
}

// A lift shaft beside the platform: the deck rides up to the next prop and back.
// With `crank`, it only rises while someone stands on a crank plate (co-op).
function placeLift(s: GenState, theme: ThemeDef, zi: number, crank: boolean): boolean {
  const A = { ...s.cur };
  const aR = s.curR;
  const aOwner = s.curOwner;
  const aBody = colliderRadius(s.curArch);
  const rise = crank ? s.rng.float(7, 9) / Math.pow(gravityScaleAtZone(zi), 0.8) : s.rng.float(6, 8.5);
  const size: [number, number, number] = crank ? CRANK.deck : [2.6, 0.4, 2.6];
  const half = size[0] / 2;
  const rotY = s.rng.float(0, Math.PI * 2);
  const phase = s.rng.float(0, 1);
  const head = headroomAtZone(zi);
  const geom = (archId: string, h: number) => {
    const d1 = Math.max(aR + MOVER.edgeGap, aBody * 0.92 + 0.1) + half;
    const top = along(A, h, d1 + half + 0.25 + colliderRadius(archId), rise);
    return { top, lo: along(A, h, d1), hi: along(A, h, d1, rise) };
  };
  const ids = archOrder(s, pathable(theme));
  const preferred = [...snug(ids, 0.6), ...ids.filter((i) => !snug([i], 0.6).length)];
  const pl = search(s, preferred, headingCandidates(s, 1.8), (archId, h, owner) => {
    const g = geom(archId, h);
    return {
      top: g.top, rotY, arc: false,
      extra: [
        obox('solid', g.lo.x, g.lo.z, half + 0.05, size[2] / 2 + 0.05, h, A.y - size[1], A.y + rise, [aOwner, owner], 'shaft'),
        obox('clear', g.lo.x, g.lo.z, half, size[2] / 2, h, A.y + 0.03, A.y + rise + head, [aOwner, owner], 'shaftride'),
      ],
    };
  });
  if (!pl) return false;
  const id = s.gadgetId++;
  const g = geom(pl.archId, pl.heading);
  const h = pl.heading;
  commit(s, pl, 'gadget', 0, rise, crank ? 'cranklift' : 'lift');
  if (crank) {
    const bR = s.curR;
    s.gadgets.push({
      kind: 'cranklift', id, base: g.lo, rise, rotY: h,
      plates: [along(A, h, -aR * 0.55), along(pl.top, h, bR * 0.45)],
    });
  } else {
    s.gadgets.push({
      kind: 'mover', id, motion: 'lift', a: g.lo, b: g.hi, size, rotY: h,
      period: moverPeriod(rise, MOVER.liftSpeed), phase, rest: MOVER.rest,
    });
  }
  return true;
}

// A long beam turning around its middle. Twice a revolution it lines up with
// both platforms: hop on at one tip and ride (or run) to the other side.
function placeSpinner(s: GenState, theme: ThemeDef, zi: number): boolean {
  if (colliderRadius(s.curArch) - s.curR > 0.35) return false;
  const A = { ...s.cur };
  const aR = s.curR;
  const aOwner = s.curOwner;
  const gap = s.rng.float(6.5, 8.5) / gravityScaleAtZone(zi);
  const half = gap / 2 - 0.45;
  const rotY = s.rng.float(0, Math.PI * 2);
  const phase = s.rng.float(0, 1);
  const spin: 1 | -1 = s.rng.chance(0.5) ? 1 : -1;
  const head = headroomAtZone(zi);
  const ids = snug(archOrder(s, wide(theme)), 0.35);
  if (ids.length === 0) return false;
  const pl = search(s, ids, headingCandidates(s, 1.35), (archId, h, owner) => {
    const bR = ARCHETYPES[archId].topRadius;
    const hub = along(A, h, aR + gap / 2);
    return {
      top: along(A, h, aR + gap + bR), rotY, arc: false,
      extra: [
        circle('solid', hub.x, hub.z, half + 0.1, A.y - 0.5, A.y, [aOwner, owner], 'spinner'),
        circle('clear', hub.x, hub.z, half, A.y + 0.03, A.y + head, [aOwner, owner], 'spinride'),
      ],
    };
  });
  if (!pl) return false;
  const id = s.gadgetId++;
  const hub = along(A, pl.heading, aR + gap / 2);
  commit(s, pl, 'gadget', gap, 0, 'spinner');
  const period = Math.min(16, Math.max(10, half * 2.3));
  // phase so the beam starts lined up with the path at a random point of its turn
  s.gadgets.push({
    kind: 'mover', id, motion: 'spinner', a: hub, b: hub, size: [half * 2, 0.45, 1.6], rotY: pl.heading,
    period, phase, rest: 0, spin,
  });
  return true;
}

// Co-op: a seesaw on its own drum. One climber sits on the seat end; a teammate
// lands on the raised slam end and flings them up to a ledge nobody can jump to.
function placeSeesaw(s: GenState, theme: ThemeDef, zi: number): boolean {
  // 1) the drum, reached by an ordinary short hop
  const gap = s.rng.float(1.0, 1.8) * gapScaleAtZone(zi);
  const dy = s.rng.float(-0.4, 0.5);
  const heads = headingCandidates(s);
  const basePl = search(s, ['coop_seesaw'], [...heads, ...heads.map((h) => h + Math.PI)], jumpPlacer(s, gap, dy, 0));
  if (!basePl) return false;
  commit(s, basePl, 'jump', gap, dy);
  const base = basePl.top;
  const baseOwner = basePl.owner;
  // 2) the landing ledge, high above and beyond the seat end
  const rise = s.rng.float(6.2, 7.4) / Math.pow(gravityScaleAtZone(zi), 0.8);
  const reach = s.rng.float(3.6, 5.2);
  const rotY = s.rng.float(0, Math.PI * 2);
  const g = MOVE.gravity * gravityScaleAtZone(zi);
  const seatOff = SEESAW.halfLength * Math.cos(SEESAW.tilt);
  const pl = search(s, archOrder(s, wide(theme)), headingCandidates(s, 1.8), (archId, h, owner) => {
    const tR = ARCHETYPES[archId].topRadius;
    const seat = along(base, h, seatOff, 0.3);
    const target = along(base, h, seatOff + reach + tR, rise);
    const vols: Vol[] = [
      // plank sweep (both tilts) and the weight crane at the slam end
      obox('solid', base.x, base.z, SEESAW.halfLength + 0.15, SEESAW.plankWidth / 2 + 0.1, h, base.y, base.y + 2.1, [baseOwner], 'plank'),
      circle('solid', ...xz(along(base, h, -(seatOff + 0.55))), 0.25, base.y, base.y + 5.3, [baseOwner], 'crane'),
    ];
    // launch arc
    const vel = ballisticVelocity(seat, target, g, SEESAW.apexAbove);
    for (let i = 1; i < 10; i++) {
      const t = (vel.time * i) / 10;
      const px = seat.x + vel.x * t;
      const pz = seat.z + vel.z * t;
      const py = seat.y + vel.y * t - 0.5 * g * t * t + 0.7;
      vols.push(circle('clear', px, pz, 0.55, py - 0.75, py + 0.75, [baseOwner, owner], 'launch'));
    }
    return { top: target, rotY, arc: false, extra: vols };
  });
  if (!pl) return true; // the drum still works as a plain platform
  const id = s.gadgetId++;
  const h = pl.heading;
  commit(s, pl, 'gadget', reach, rise, 'seesaw');
  const tR = s.curR;
  const perp = h + Math.PI / 2;
  s.gadgets.push({
    kind: 'seesaw', id,
    pivot: v(base.x, base.y + SEESAW.pivotHeight, base.z),
    rotY: h + Math.PI, // seat end faces the ledge, slam end faces away
    target: { ...pl.top },
    lever: along(pl.top, perp, tR * 0.5),
  });
  return true;
}

function xz(p: Vec3): [number, number] {
  return [p.x, p.z];
}

function placeCrankLift(s: GenState, theme: ThemeDef, zi: number): boolean {
  // the bottom crank plate needs room to sit well away from the shaft
  if (s.curR < 1.3) {
    const roomy = pathable(theme).filter((p) => ARCHETYPES[p].topRadius >= 1.3);
    placeJumpStep(s, theme, zi, roomy.length > 0 ? roomy : wide(theme));
  }
  return placeLift(s, theme, zi, true);
}

function placeGadget(s: GenState, theme: ThemeDef, zi: number, kind: GadgetKind): boolean {
  switch (kind) {
    case 'ladder': return placeLadder(s, theme, zi);
    case 'rope': return placeRope(s, theme, zi);
    case 'bridge': return placeBridge(s, theme, zi, zi < 3 ? 'latch' : 'hold');
    case 'traverse': return placeTraverse(s, theme, zi);
    case 'shuttle': return placeShuttle(s, theme, zi);
    case 'lift': return placeLift(s, theme, zi, false);
    case 'spinner': {
      if (colliderRadius(s.curArch) - s.curR > 0.35) {
        const ok = snug(wide(theme), 0.35);
        if (ok.length === 0) return false;
        placeJumpStep(s, theme, zi, ok);
      }
      return placeSpinner(s, theme, zi);
    }
    case 'seesaw': return placeSeesaw(s, theme, zi);
    case 'cranklift': return placeCrankLift(s, theme, zi);
    case 'twinbridge': return placeBridge(s, theme, zi, 'twin');
    case 'duobridge': return placeBridge(s, theme, zi, 'duo');
  }
}

const SOLO_POOL: { kind: GadgetKind; w: number; from: number }[] = [
  { kind: 'ladder', w: 1, from: 0 },
  { kind: 'bridge', w: 1.1, from: 0 },
  { kind: 'rope', w: 0.9, from: 1 },
  { kind: 'shuttle', w: 1.2, from: 1 },
  { kind: 'traverse', w: 1, from: 2 },
  { kind: 'lift', w: 0.9, from: 2 },
  { kind: 'spinner', w: 1, from: 3 },
];

const COOP_POOL: { kind: GadgetKind; w: number; from: number }[] = [
  { kind: 'seesaw', w: 1.3, from: 2 },
  { kind: 'cranklift', w: 1.1, from: 3 },
  { kind: 'twinbridge', w: 0.9, from: 4 },
  { kind: 'duobridge', w: 0.6, from: 6 },
];

function weightedPick<T extends { w: number }>(rng: Rng, pool: T[]): T {
  const total = pool.reduce((a, p) => a + p.w, 0);
  let r = rng.float(0, total);
  for (const p of pool) {
    r -= p.w;
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

/** Which path nodes of a zone become contraptions, and which ones. */
function planGadgets(s: GenState, zi: number, nodes: number, lastCoop: GadgetKind | null): Map<number, GadgetKind> {
  const count = zi === 0 ? 1 : zi < 4 ? 2 : 3;
  const kinds: GadgetKind[] = [];
  let pool = SOLO_POOL.filter((p) => p.from <= zi);
  while (kinds.length < count && pool.length > 0) {
    const pick = weightedPick(s.rng, pool);
    kinds.push(pick.kind);
    pool = pool.filter((p) => p !== pick);
  }
  if (s.coop && zi >= 2) {
    const coop = COOP_POOL.filter((p) => p.from <= zi && p.kind !== lastCoop);
    if (coop.length > 0) kinds.splice(s.rng.int(0, kinds.length), 0, weightedPick(s.rng, coop).kind);
  }
  const plan = new Map<number, GadgetKind>();
  const start = zi === 0 ? 6 : 3;
  const span = Math.max(kinds.length, nodes - 2 - start);
  const stride = span / kinds.length;
  kinds.forEach((k, i) => plan.set(start + Math.floor(i * stride + s.rng.float(0, stride * 0.45)), k));
  return plan;
}

function placeItemBranch(s: GenState, theme: ThemeDef, zi: number, type: ItemType) {
  // A platform off to the side of the path, a jumpable detour away.
  const side = s.rng.chance(0.5) ? 1 : -1;
  const turn = s.rng.float(1.5, 1.9);
  const gap = s.rng.float(2.2, 2.9) * gapScaleAtZone(zi);
  const dy = s.rng.float(-0.4, 0.4);
  const rotY = s.rng.float(0, Math.PI * 2);
  const heads = [0, 0.3, -0.3, 0.6, -0.6].map((o) => s.heading + side * turn + o)
    .concat([0, 0.3, -0.3, 0.6].map((o) => s.heading - side * turn + o));
  const pl = search(s, archOrder(s, pathable(theme)), heads, (archId, h) => ({
    top: along(s.cur, h, gap + s.curR + ARCHETYPES[archId].topRadius, dy), rotY,
  }));
  if (!pl) return; // no room for a detour here — the item simply isn't placed
  commitBranch(s, pl);
  s.items.push({ id: s.itemId++, type, pos: v(pl.top.x, pl.top.y + 0.7, pl.top.z) });
}

function placeDecor(s: GenState, theme: ThemeDef, yStart: number, yEnd: number) {
  const count = s.rng.int(10, 15);
  for (let i = 0; i < count; i++) {
    const archId = s.rng.pick(theme.decorProps);
    const ang = s.rng.float(0, Math.PI * 2);
    const rad = s.rng.float(24, 38);
    s.props.push({
      archetype: archId,
      // stay clear of the ceiling slab between storeys
      pos: v(Math.cos(ang) * rad, s.rng.float(yStart, Math.max(yStart, yEnd - 5)), Math.sin(ang) * rad),
      rotY: s.rng.float(0, Math.PI * 2),
      solid: false,
    });
  }
}

export function generateLevel(seed: string, teamSize = 1): LevelData {
  return generateLevelDebug(seed, teamSize).level;
}

export function generateLevelDebug(seed: string, teamSize = 1): { level: LevelData; steps: PathStep[]; issues: string[]; space: Space } {
  const rng = makeRng(seed);
  const s: GenState = {
    rng,
    props: [],
    gadgets: [],
    items: [],
    checkpoints: [],
    nodes: [],
    steps: [],
    space: new Space(),
    cur: v(0, 1.0, 0),
    curR: 6.4,
    curArch: 'base_pad',
    curOwner: 0,
    zone: 0,
    heading: rng.float(0, Math.PI * 2),
    turnDir: rng.chance(0.5) ? 1 : -1,
    gadgetId: 1,
    itemId: 1,
    nextOwner: 1,
    coop: teamSize >= 2,
    issues: [],
  };

  const basePad: PropInstance = { archetype: 'base_pad', pos: v(0, 0, 0), rotY: 0, solid: true };
  s.props.push(basePad);
  s.space.add([...propVols(basePad, 0), topClear(s.cur, 6.4, 0, [0])]);
  const spawn = v(0, 1.05, 0);
  s.checkpoints.push({ index: 0, pos: spawn, zone: 0, rotY: 0 });
  s.nodes.push(v(0, 1.0, 0));

  const order = pickZones(rng);
  const zones: ZoneData[] = [];
  let itemCycle = rng.int(0, ITEM_CYCLE.length - 1);
  let lastCoop: GadgetKind | null = null;

  for (let zi = 0; zi < order.length; zi++) {
    const theme = order[zi];
    s.zone = zi;
    const yStart = s.cur.y;

    if (zi > 0) placeCheckpoint(s, theme, zi);

    // team runs gain extra height from the co-op contraptions, so their zones
    // are a couple of hops shorter to keep the whole climb a similar length
    const nodes = rng.int(14, 18) - (s.coop && zi >= 2 ? 2 : 0);
    const plan = planGadgets(s, zi, nodes, lastCoop);
    const itemNodes = new Set<number>();
    while (itemNodes.size < (zi === 0 ? 1 : rng.int(1, 2))) itemNodes.add(rng.int(3, nodes - 1));

    for (let n = 0; n < nodes; n++) {
      const kind = plan.get(n);
      const placed = kind ? placeGadget(s, theme, zi, kind) : false;
      if (kind && placed && COOP_POOL.some((p) => p.kind === kind)) lastCoop = kind;
      // every zone must end clearly above where it started: from mid-zone on,
      // fall back to step-ups whenever the climb is behind schedule
      const behind = n >= nodes / 2 && s.cur.y < yStart + (n / nodes) * 9;
      if (!placed) placeJumpStep(s, theme, zi, undefined, behind);
      if (itemNodes.has(n)) placeItemBranch(s, theme, zi, ITEM_CYCLE[itemCycle++ % ITEM_CYCLE.length]);
    }

    placeDecor(s, theme, yStart + 2, s.cur.y);
    zones.push({ index: zi, theme: theme.id, label: theme.label, yStart, yEnd: s.cur.y });
  }

  // Summit: one final pad with the flag.
  const gsTop = gapScaleAtZone(order.length - 1);
  const sp = padPlacement(s, order[order.length - 1], order.length - 1, 'summit_pad', [[rng.float(1.0, 1.8), rng.float(1.0, 1.4)], [0.6, 1.45 * gsTop], [2.4 * gsTop, 0.5]], false);
  commit(s, sp.pl, 'jump', sp.gap, sp.dy);
  const summit = sp.pl.top;
  zones[zones.length - 1].yEnd = summit.y;

  const level: LevelData = {
    seed,
    teamSize,
    zones,
    props: s.props,
    gadgets: s.gadgets,
    items: s.items,
    checkpoints: s.checkpoints,
    flagPos: v(summit.x, summit.y, summit.z),
    spawn,
    totalHeight: summit.y,
    nodes: s.nodes,
  };
  return { level, steps: s.steps, issues: s.issues, space: s.space };
}

export interface LevelIssue {
  step: number;
  msg: string;
}

// Sanity-check that every jump on the main path is humanly possible with MOVE
// constants, accounting for the per-zone gravity reduction.
export function validateLevel(steps: PathStep[]): LevelIssue[] {
  const issues: LevelIssue[] = [];
  steps.forEach((st, i) => {
    if (st.kind !== 'jump') return;
    const gs = gapScaleAtZone(st.zone);
    if (st.dy > MOVE.maxStepUp * gs + 0.05) issues.push({ step: i, msg: `step up ${st.dy.toFixed(2)}m exceeds ${(MOVE.maxStepUp * gs).toFixed(2)} (zone ${st.zone})` });
    if (st.dy >= -0.5 && st.gap > MOVE.maxGapShort * gs + 0.05) issues.push({ step: i, msg: `gap ${st.gap.toFixed(2)}m exceeds ${(MOVE.maxGapShort * gs).toFixed(2)} (zone ${st.zone})` });
    if (st.dy < -0.5 && st.gap > MOVE.maxGapDown * gs + 0.05) issues.push({ step: i, msg: `down-gap ${st.gap.toFixed(2)}m exceeds ${(MOVE.maxGapDown * gs).toFixed(2)} (zone ${st.zone})` });
    if (st.dy > 0.6 * gs && st.gap > 2.2 * gs) issues.push({ step: i, msg: `combined rise ${st.dy.toFixed(2)}m over gap ${st.gap.toFixed(2)}m too hard (zone ${st.zone})` });
  });
  return issues;
}

