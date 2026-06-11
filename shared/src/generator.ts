import { MOVE, gapScaleAtZone, gravityScaleAtZone } from './constants';
import { makeRng, type Rng } from './rng';
import { ARCHETYPES, THEMES } from './themes';
import type { CheckpointData, GadgetData, ItemSpawn, ItemType, LevelData, PropInstance, Vec3, ZoneData } from './types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export interface PathStep {
  from: Vec3;
  to: Vec3;
  kind: 'jump' | 'gadget';
  gap: number; // edge-to-edge horizontal distance
  dy: number;
  zone: number; // zone index — reachability limits scale with altitude gravity
}

interface GenState {
  rng: Rng;
  props: PropInstance[];
  gadgets: GadgetData[];
  items: ItemSpawn[];
  checkpoints: CheckpointData[];
  nodes: Vec3[];
  steps: PathStep[];
  cur: Vec3; // top-center of the current path platform
  curR: number;
  heading: number; // walk direction in the XZ plane
  turnDir: number;
  gadgetId: number;
  itemId: number;
}

const ITEM_CYCLE: ItemType[] = ['doublejump', 'grapple', 'telescope'];

function headingToKeepRadiusInBand(s: GenState): number {
  // Walk tangentially around the tower axis, blending in a radial pull that
  // keeps the path inside a comfortable cylinder (so it reads as a climb, not a sprawl).
  const r = Math.hypot(s.cur.x, s.cur.z);
  const a = Math.atan2(s.cur.z, s.cur.x);
  let k: number; // radial blend: + outward, - inward
  if (r > 14) k = -0.95;
  else if (r < 8) k = 0.95;
  else k = s.rng.float(-0.25, 0.25);
  const hx = -Math.sin(a) * s.turnDir + Math.cos(a) * k;
  const hz = Math.cos(a) * s.turnDir + Math.sin(a) * k;
  return Math.atan2(hz, hx) + s.rng.float(-0.3, 0.3);
}

function placePlatform(s: GenState, theme: number, gap: number, dy: number, kind: PathStep['kind'], archOverride?: string, alignToPath = false): Vec3 {
  const themeDef = THEMES[theme];
  const archId = archOverride ?? s.rng.pick(themeDef.pathProps.filter((p) => ARCHETYPES[p].pathable));
  const arch = ARCHETYPES[archId];
  s.heading = headingToKeepRadiusInBand(s);
  if (s.rng.chance(0.18)) s.turnDir *= -1;
  const dist = gap + s.curR + arch.topRadius;
  const top = v(
    s.cur.x + Math.cos(s.heading) * dist,
    s.cur.y + dy,
    s.cur.z + Math.sin(s.heading) * dist,
  );
  // alignToPath turns the prop's local X axis perpendicular to the walk direction,
  // so arch-style props (checkpoint gates) are entered straight on.
  const rotY = alignToPath ? Math.PI * 1.5 - s.heading : s.rng.float(0, Math.PI * 2);
  s.props.push({
    archetype: archId,
    pos: v(top.x, top.y - arch.topY, top.z),
    rotY,
    solid: true,
  });
  s.steps.push({ from: { ...s.cur }, to: { ...top }, kind, gap, dy, zone: theme });
  s.nodes.push({ ...top });
  s.cur = top;
  s.curR = arch.topRadius;
  return top;
}

function placeJumpStep(s: GenState, theme: number) {
  const r = s.rng.float();
  // low gravity higher up = bigger jumps; widen everything by the damped scale
  const gs = gapScaleAtZone(theme);
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
  placePlatform(s, theme, gap, dy, 'jump');
}

function placeBridge(s: GenState, theme: number, zone: number) {
  const mode = zone < 3 ? 'latch' : zone < 7 ? 'hold' : s.rng.chance(0.5) ? 'duo' : 'hold';
  const near = { ...s.cur };
  const nearR = s.curR;
  const id = s.gadgetId++;
  // Far platform at the same height across a gap far too wide to jump.
  const themeDef = THEMES[theme];
  const farArchId = s.rng.pick(themeDef.pathProps.filter((p) => ARCHETYPES[p].pathable && ARCHETYPES[p].topRadius >= 1.1));
  // scale by the FULL jump-range gain so floaty late-game jumps can't skip the bridge
  const span = s.rng.float(6.5, 9) / gravityScaleAtZone(zone);
  const far = placePlatform(s, theme, span, 0, 'gadget', farArchId);
  const farR = s.curR;
  const dir = Math.atan2(far.z - near.z, far.x - near.x);
  const nearEdge = v(near.x + Math.cos(dir) * nearR * 0.75, near.y, near.z + Math.sin(dir) * nearR * 0.75);
  const farEdge = v(far.x - Math.cos(dir) * farR * 0.75, far.y, far.z - Math.sin(dir) * farR * 0.75);
  const length = Math.hypot(farEdge.x - nearEdge.x, farEdge.z - nearEdge.z) + 0.8;
  const plates: Vec3[] = [v(near.x - Math.cos(dir) * nearR * 0.3, near.y, near.z - Math.sin(dir) * nearR * 0.3)];
  if (mode === 'hold') {
    plates.push(v(far.x + Math.cos(dir) * farR * 0.3, far.y, far.z + Math.sin(dir) * farR * 0.3));
  }
  s.gadgets.push({ kind: 'bridge', id, near: nearEdge, rotY: dir, length, mode, plates });
}

function placeLadder(s: GenState, theme: number) {
  const id = s.gadgetId++;
  const from = { ...s.cur };
  const fromR = s.curR;
  const rise = s.rng.float(5.5, 7.5);
  const top = placePlatform(s, theme, -s.curR * 0.4, rise, 'gadget'); // nearly directly above
  const dir = Math.atan2(top.z - from.z, top.x - from.x);
  const base = v(from.x + Math.cos(dir) * fromR * 0.5, from.y, from.z + Math.sin(dir) * fromR * 0.5);
  s.gadgets.push({ kind: 'ladder', id, base, height: top.y - from.y + 0.5, rotY: dir });
}

function placeRope(s: GenState, theme: number) {
  const id = s.gadgetId++;
  const from = { ...s.cur };
  const rise = s.rng.float(6.5, 9);
  const top = placePlatform(s, theme, -s.curR * 0.2, rise, 'gadget');
  const topR = s.curR;
  const dir = Math.atan2(from.z - top.z, from.x - top.x); // from platform edge back toward previous platform
  const anchor = v(top.x + Math.cos(dir) * topR * 0.7, top.y + 0.3, top.z + Math.sin(dir) * topR * 0.7);
  const length = anchor.y - (from.y + 1.0);
  s.gadgets.push({ kind: 'rope', id, top: anchor, length });
}

function placeItemBranch(s: GenState, theme: number, type: ItemType) {
  // A platform off to the side of the path, a jumpable detour away.
  const themeDef = THEMES[theme];
  const archId = s.rng.pick(themeDef.pathProps.filter((p) => ARCHETYPES[p].pathable));
  const arch = ARCHETYPES[archId];
  const side = s.rng.chance(0.5) ? 1 : -1;
  const dir = s.heading + side * s.rng.float(1.5, 1.9);
  const gap = s.rng.float(2.2, 2.9) * gapScaleAtZone(theme);
  const dist = gap + s.curR + arch.topRadius;
  const top = v(s.cur.x + Math.cos(dir) * dist, s.cur.y + s.rng.float(-0.4, 0.4), s.cur.z + Math.sin(dir) * dist);
  s.props.push({ archetype: archId, pos: v(top.x, top.y - arch.topY, top.z), rotY: s.rng.float(0, Math.PI * 2), solid: true });
  s.items.push({ id: s.itemId++, type, pos: v(top.x, top.y + 0.7, top.z) });
}

function placeDecor(s: GenState, theme: number, yStart: number, yEnd: number) {
  const themeDef = THEMES[theme];
  const count = s.rng.int(8, 12);
  for (let i = 0; i < count; i++) {
    const archId = s.rng.pick(themeDef.decorProps);
    const ang = s.rng.float(0, Math.PI * 2);
    const rad = s.rng.float(24, 38);
    s.props.push({
      archetype: archId,
      pos: v(Math.cos(ang) * rad, s.rng.float(yStart, yEnd), Math.sin(ang) * rad),
      rotY: s.rng.float(0, Math.PI * 2),
      solid: false,
    });
  }
}

export function generateLevel(seed: string): LevelData {
  return generateLevelDebug(seed).level;
}

export function generateLevelDebug(seed: string): { level: LevelData; steps: PathStep[] } {
  const rng = makeRng(seed);
  const s: GenState = {
    rng,
    props: [],
    gadgets: [],
    items: [],
    checkpoints: [],
    nodes: [],
    steps: [],
    cur: v(0, 1.0, 0),
    curR: 6.4,
    heading: rng.float(0, Math.PI * 2),
    turnDir: rng.chance(0.5) ? 1 : -1,
    gadgetId: 1,
    itemId: 1,
  };

  s.props.push({ archetype: 'base_pad', pos: v(0, 0, 0), rotY: 0, solid: true });
  const spawn = v(0, 1.05, 0);
  s.checkpoints.push({ index: 0, pos: spawn, zone: 0, rotY: 0 });
  s.nodes.push(v(0, 1.0, 0));

  const zones: ZoneData[] = [];
  let itemCycle = rng.int(0, ITEM_CYCLE.length - 1);

  for (let zi = 0; zi < THEMES.length; zi++) {
    const yStart = s.cur.y;

    if (zi > 0) {
      // Checkpoint pad marks the theme change; easy step up onto it, arch facing the approach.
      const top = placePlatform(s, zi, rng.float(1.2, 2.0), rng.float(0.8, 1.2), 'jump', 'checkpoint_pad', true);
      s.checkpoints.push({ index: zi, pos: v(top.x, top.y + 0.05, top.z), zone: zi, rotY: Math.PI * 1.5 - s.heading });
    }

    const nodes = rng.int(14, 18);
    let sinceGadget = 0;
    let nextGadgetAt = rng.int(4, 7);
    const itemNodes = new Set<number>();
    while (itemNodes.size < (zi === 0 ? 1 : rng.int(1, 2))) itemNodes.add(rng.int(3, nodes - 1));

    for (let n = 0; n < nodes; n++) {
      sinceGadget++;
      if (sinceGadget >= nextGadgetAt && zi + n > 2) {
        const kind = rng.float();
        if (kind < 0.4) placeBridge(s, zi, zi);
        else if (kind < 0.7) placeLadder(s, zi);
        else placeRope(s, zi);
        sinceGadget = 0;
        nextGadgetAt = rng.int(5, 8);
      } else {
        placeJumpStep(s, zi);
      }
      if (itemNodes.has(n)) {
        placeItemBranch(s, zi, ITEM_CYCLE[itemCycle++ % ITEM_CYCLE.length]);
      }
    }

    placeDecor(s, zi, yStart + 2, s.cur.y);
    zones.push({ index: zi, theme: THEMES[zi].id, label: THEMES[zi].label, yStart, yEnd: s.cur.y });
  }

  // Summit: one final pad with the flag.
  const summit = placePlatform(s, THEMES.length - 1, rng.float(1.0, 1.8), rng.float(1.0, 1.4), 'jump', 'summit_pad');
  zones[zones.length - 1].yEnd = summit.y;
  const flagPos = v(summit.x, summit.y, summit.z);

  const level: LevelData = {
    seed,
    zones,
    props: s.props,
    gadgets: s.gadgets,
    items: s.items,
    checkpoints: s.checkpoints,
    flagPos,
    spawn,
    totalHeight: summit.y,
    nodes: s.nodes,
  };
  return { level, steps: s.steps };
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
