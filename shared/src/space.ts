// A coarse spatial registry the level generator uses to keep the climb clean:
// props must not intersect each other, nothing may hang into the headroom over
// a surface you stand on, and jump arcs / gadget travel paths stay unobstructed.
//
// Everything is a vertical prism — an oriented rectangle or a circle in the XZ
// plane, extruded over [y0, y1] — which is plenty for collider-sized checks.
import { ARCHETYPES } from './themes';
import type { PartDef, PropInstance } from './types';

export type VolKind =
  | 'solid' // something a player collides with
  | 'clear' // space a player must be able to move through
  | 'visual'; // decoration without collision — overlapping it only looks bad

export interface Vol {
  kind: VolKind;
  shape: 'box' | 'circle';
  x: number;
  z: number;
  hx: number; // box half extents along its own local X / Z axes
  hz: number;
  c: number; // cos/sin of the box's yaw; local X axis = (c, -s), local Z axis = (s, c)
  s: number;
  r: number; // circle radius
  y0: number;
  y1: number;
  /** Volumes that share an owner never conflict (a platform and the arc that lands on it). */
  owners: number[];
  tag?: string; // debugging aid
}

export const box = (kind: VolKind, x: number, z: number, hx: number, hz: number, yaw: number, y0: number, y1: number, owners: number[], tag?: string): Vol => ({
  kind, shape: 'box', x, z, hx, hz, c: Math.cos(yaw), s: Math.sin(yaw), r: 0, y0, y1, owners, tag,
});

export const circle = (kind: VolKind, x: number, z: number, r: number, y0: number, y1: number, owners: number[], tag?: string): Vol => ({
  kind, shape: 'circle', x, z, hx: 0, hz: 0, c: 1, s: 0, r, y0, y1, owners, tag,
});

/** Box spanning the segment a→b in XZ (half-width `hw`), extruded over [y0, y1]. */
export function segmentBox(kind: VolKind, ax: number, az: number, bx: number, bz: number, hw: number, y0: number, y1: number, owners: number[], tag?: string): Vol {
  const len = Math.hypot(bx - ax, bz - az);
  // local X runs along the segment: (c, -s) = (dx, dz)/len  →  c = dx/len, s = -dz/len
  const yaw = Math.atan2(-(bz - az), bx - ax);
  return box(kind, (ax + bx) / 2, (az + bz) / 2, len / 2 + hw, hw, yaw, y0, y1, owners, tag);
}

function boundRadius(v: Vol): number {
  return v.shape === 'circle' ? v.r : Math.hypot(v.hx, v.hz);
}

// separating-axis overlap of two prisms in XZ (inflated by m)
function overlapXZ(a: Vol, b: Vol, m: number): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const reach = boundRadius(a) + boundRadius(b) + m;
  if (dx * dx + dz * dz >= reach * reach) return false;
  if (a.shape === 'circle' && b.shape === 'circle') return true; // bounding test was exact
  if (a.shape === 'circle' || b.shape === 'circle') {
    const bx = a.shape === 'box' ? a : b;
    const ci = a.shape === 'box' ? b : a;
    const ox = ci.x - bx.x;
    const oz = ci.z - bx.z;
    const lx = ox * bx.c - oz * bx.s;
    const lz = ox * bx.s + oz * bx.c;
    const cx = Math.max(-bx.hx, Math.min(bx.hx, lx));
    const cz = Math.max(-bx.hz, Math.min(bx.hz, lz));
    const r = ci.r + m;
    return (lx - cx) ** 2 + (lz - cz) ** 2 < r * r;
  }
  // box-box SAT over the four face normals
  const axes = [
    [a.c, -a.s], [a.s, a.c],
    [b.c, -b.s], [b.s, b.c],
  ];
  for (const [ux, uz] of axes) {
    const pa = a.hx * Math.abs(a.c * ux - a.s * uz) + a.hz * Math.abs(a.s * ux + a.c * uz);
    const pb = b.hx * Math.abs(b.c * ux - b.s * uz) + b.hz * Math.abs(b.s * ux + b.c * uz);
    if (Math.abs(dx * ux + dz * uz) >= pa + pb + m) return false;
  }
  return true;
}

export function volsOverlap(a: Vol, b: Vol, m = 0): boolean {
  if (a.y1 + m <= b.y0 || b.y1 + m <= a.y0) return false;
  return overlapXZ(a, b, m);
}

function sharesOwner(a: Vol, b: Vol): boolean {
  for (const o of a.owners) if (b.owners.includes(o)) return true;
  return false;
}

export interface Conflict {
  a: Vol;
  b: Vol;
  hard: boolean;
}

/** How a pair of volume kinds interacts: null = never conflicts. */
function rule(a: VolKind, b: VolKind): { hard: boolean; margin: number } | null {
  if (a === 'clear' && b === 'clear') return null;
  if (a === 'solid' && b === 'solid') return { hard: true, margin: 0.08 };
  if ((a === 'solid' && b === 'clear') || (a === 'clear' && b === 'solid')) return { hard: true, margin: 0 };
  return { hard: false, margin: 0 }; // anything involving a visual
}

const BUCKET = 5; // metres of height per bucket

export class Space {
  private buckets = new Map<number, Vol[]>();
  all: Vol[] = [];

  add(vols: Vol[]) {
    for (const v of vols) {
      this.all.push(v);
      for (let b = Math.floor(v.y0 / BUCKET); b <= Math.floor(v.y1 / BUCKET); b++) {
        const list = this.buckets.get(b) ?? [];
        list.push(v);
        this.buckets.set(b, list);
      }
    }
  }

  /** Hard conflicts make a placement illegal; soft ones only cost points. */
  test(vols: Vol[], stopAtHard = true): { hard: number; soft: number; conflicts: Conflict[] } {
    let hard = 0;
    let soft = 0;
    const conflicts: Conflict[] = [];
    for (const v of vols) {
      const seen = new Set<Vol>();
      for (let b = Math.floor(v.y0 / BUCKET); b <= Math.floor(v.y1 / BUCKET); b++) {
        for (const e of this.buckets.get(b) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const r = rule(v.kind, e.kind);
          if (!r || sharesOwner(v, e)) continue;
          if (!volsOverlap(v, e, r.margin)) continue;
          conflicts.push({ a: v, b: e, hard: r.hard });
          if (r.hard) {
            hard++;
            if (stopAtHard) return { hard, soft, conflicts };
          } else soft++;
        }
      }
    }
    return { hard, soft, conflicts };
  }
}

// ---- turning props into volumes ----

interface LocalBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

// Half extents of an axis-aligned box after a tilt about X then Z (conservative).
function tilted(hx: number, hy: number, hz: number, rotX = 0, rotZ = 0): [number, number, number] {
  if (rotX) {
    const c = Math.abs(Math.cos(rotX));
    const s = Math.abs(Math.sin(rotX));
    [hy, hz] = [c * hy + s * hz, s * hy + c * hz];
  }
  if (rotZ) {
    const c = Math.abs(Math.cos(rotZ));
    const s = Math.abs(Math.sin(rotZ));
    [hx, hy] = [c * hx + s * hy, s * hx + c * hy];
  }
  return [hx, hy, hz];
}

function partBox(p: PartDef): LocalBox {
  const [a, b, c] = p.size;
  let h: [number, number, number];
  switch (p.shape) {
    case 'box': h = [a / 2, b / 2, c / 2]; break;
    case 'cyl': { const r = Math.max(a, c || a); h = [r, b / 2, r]; break; }
    case 'sphere': h = [a, b, c]; break;
    case 'torus': h = [a + b, a + b, b]; break; // three's torus lies in its local XY plane
  }
  const [hx, hy, hz] = tilted(h[0], h[1], h[2], p.rotX, p.rotZ);
  return { x: p.pos[0], y: p.pos[1], z: p.pos[2], hx, hy, hz };
}

interface ArchShape {
  colliders: LocalBox[]; // cylinders are stored with hx = hz = r and flagged round
  round: boolean[];
  visual: LocalBox; // union of all parts
}

const shapeCache = new Map<string, ArchShape>();

function archShape(id: string): ArchShape {
  const cached = shapeCache.get(id);
  if (cached) return cached;
  const arch = ARCHETYPES[id];
  const colliders: LocalBox[] = [];
  const round: boolean[] = [];
  for (const c of arch.colliders) {
    if (c.shape === 'cyl') {
      colliders.push({ x: c.pos[0], y: c.pos[1], z: c.pos[2], hx: c.size[0], hy: c.size[1] / 2, hz: c.size[0] });
      round.push(true);
    } else {
      const [hx, hy, hz] = tilted(c.size[0] / 2, c.size[1] / 2, c.size[2] / 2, c.rotX, c.rotZ);
      colliders.push({ x: c.pos[0], y: c.pos[1], z: c.pos[2], hx, hy, hz });
      round.push(false);
    }
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of [...arch.parts, ...(arch.interact?.parts.map((q) => ({ ...q, pos: [q.pos[0] + arch.interact!.pivot[0], q.pos[1] + arch.interact!.pivot[1], q.pos[2] + arch.interact!.pivot[2]] as [number, number, number] })) ?? [])]) {
    const b = partBox(p);
    x0 = Math.min(x0, b.x - b.hx); x1 = Math.max(x1, b.x + b.hx);
    y0 = Math.min(y0, b.y - b.hy); y1 = Math.max(y1, b.y + b.hy);
    z0 = Math.min(z0, b.z - b.hz); z1 = Math.max(z1, b.z + b.hz);
  }
  const shape: ArchShape = {
    colliders,
    round,
    visual: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2 },
  };
  shapeCache.set(id, shape);
  return shape;
}

// prop-local offset → world, matching three's Y rotation (x' = c·x + s·z, z' = −s·x + c·z)
function toWorld(prop: PropInstance, lx: number, lz: number): [number, number] {
  const c = Math.cos(prop.rotY);
  const s = Math.sin(prop.rotY);
  return [prop.pos.x + c * lx + s * lz, prop.pos.z - s * lx + c * lz];
}

/** Collider and decoration volumes for a placed prop. */
export function propVols(prop: PropInstance, owner: number): Vol[] {
  const sh = archShape(prop.archetype);
  const out: Vol[] = [];
  sh.colliders.forEach((b, i) => {
    const [x, z] = toWorld(prop, b.x, b.z);
    const y0 = prop.pos.y + b.y - b.hy;
    const y1 = prop.pos.y + b.y + b.hy;
    out.push(sh.round[i]
      ? circle('solid', x, z, b.hx, y0, y1, [owner], prop.archetype)
      : box('solid', x, z, b.hx, b.hz, prop.rotY, y0, y1, [owner], prop.archetype));
  });
  const v = sh.visual;
  const [vx, vz] = toWorld(prop, v.x, v.z);
  // visuals are allowed to brush their neighbours a little before it counts
  out.push(box('visual', vx, vz, v.hx * 0.82, v.hz * 0.82, prop.rotY, prop.pos.y + v.y - v.hy * 0.85, prop.pos.y + v.y + v.hy * 0.85, [owner], prop.archetype));
  return out;
}

/** Horizontal radius of an archetype's colliders around its origin. */
export function colliderRadius(id: string): number {
  const sh = archShape(id);
  let r = 0;
  sh.colliders.forEach((b, i) => {
    const off = Math.hypot(b.x, b.z);
    r = Math.max(r, off + (sh.round[i] ? b.hx : Math.hypot(b.hx, b.hz)));
  });
  return r;
}
