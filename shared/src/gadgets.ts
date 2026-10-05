// Shared tunables and deterministic motion for the moving contraptions.
//
// Moving platforms run off the shared game clock (seconds since the run's GO),
// so every client computes the same pose for the same moment without any
// network traffic. The co-op contraptions (seesaw, crank lift) are driven by
// server state instead and only need the geometry helpers here.
import type { GadgetData, Vec3 } from './types';

export const MOVER = {
  shuttleSpeed: 2.3, // m/s while travelling
  liftSpeed: 1.9,
  rest: 1.7, // seconds parked at each end
  spinnerPeriod: [10, 13] as const, // seconds per revolution
  edgeGap: 0.35, // horizontal gap between a parked deck and the platform it serves
};

export const SEESAW = {
  halfLength: 2.5, // pivot to plank end
  pivotHeight: 0.9, // fulcrum height above the base's top surface
  tilt: 0.3, // radians the plank rests at (seat end down)
  plankWidth: 1.5,
  plankThickness: 0.28,
  flipTime: 0.16, // seconds for the slam to flip the plank
  holdTime: 0.9, // seconds the plank stays flipped before easing back
  resetTime: 1.2,
  cooldownMs: 2200,
  apexAbove: 2.6, // launched climbers peak this far above the target's surface
  seatRadius: 0.95, // how close to the seat end your feet must be to get flung
};

export const CRANK = {
  riseSpeed: 2.1, // m/s while a crank plate is held
  fallSpeed: 2.8,
  deck: [2.6, 0.4, 2.6] as [number, number, number],
  graceMs: 450, // stepping off a crank plate doesn't instantly drop the lift
};

export const BRIDGE = {
  buildTime: 1.5, // seconds for the planks to lay themselves across
  plankLength: 0.9,
  width: 1.9,
  thickness: 0.4,
};

// ---- easing ----
const smooth = (u: number) => u * u * (3 - 2 * u);

/** Travel progress 0..1 between the parked ends for a ping-pong mover at time t. */
export function pingPong(t: number, period: number, rest: number, phase: number): number {
  const half = period / 2;
  const travel = Math.max(0.01, half - rest);
  let c = ((t / period + phase) % 1 + 1) % 1 * period; // 0..period
  if (c < rest) return 0;
  c -= rest;
  if (c < travel) return smooth(c / travel);
  c -= travel;
  if (c < rest) return 1;
  c -= rest;
  return 1 - smooth(Math.min(1, c / travel));
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

type MoverData = Extract<GadgetData, { kind: 'mover' }>;

/** Where a moving platform's deck (top-center) is at game time t (seconds since GO). */
export function moverPose(g: MoverData, t: number, out: Pose = { x: 0, y: 0, z: 0, rotY: 0 }): Pose {
  if (g.motion === 'spinner') {
    out.x = g.a.x;
    out.y = g.a.y;
    out.z = g.a.z;
    out.rotY = g.rotY + Math.PI * 2 * (t / g.period + g.phase) * (g.spin ?? 1);
    return out;
  }
  const u = pingPong(t, g.period, g.rest, g.phase);
  out.x = g.a.x + (g.b.x - g.a.x) * u;
  out.y = g.a.y + (g.b.y - g.a.y) * u;
  out.z = g.a.z + (g.b.z - g.a.z) * u;
  out.rotY = g.rotY;
  return out;
}

/** Full cycle time for a ping-pong mover covering `dist` metres at `speed`. */
export function moverPeriod(dist: number, speed: number, rest = MOVER.rest): number {
  return 2 * (dist / speed + rest);
}

type SeesawData = Extract<GadgetData, { kind: 'seesaw' }>;

/**
 * World position of a point along the plank's top surface. `along` runs from
 * -1 (seat end) to +1 (slam end); `tilt` is the plank angle, positive = seat down.
 */
export function seesawPoint(g: SeesawData, along: number, tilt: number): Vec3 {
  const dx = Math.cos(g.rotY);
  const dz = Math.sin(g.rotY);
  const r = along * SEESAW.halfLength;
  const h = Math.cos(tilt) * r;
  return {
    x: g.pivot.x + dx * h,
    y: g.pivot.y + Math.sin(tilt) * r + SEESAW.plankThickness / 2,
    z: g.pivot.z + dz * h,
  };
}

/**
 * Initial velocity that carries a climber from `from` to land on `to`, peaking
 * `apexAbove` metres over the higher of the two. Gravity is the effective value
 * (already scaled for altitude).
 */
export function ballisticVelocity(from: Vec3, to: Vec3, gravity: number, apexAbove: number): Vec3 & { time: number } {
  const apex = Math.max(from.y, to.y) + apexAbove;
  const vy = Math.sqrt(2 * gravity * (apex - from.y));
  const tUp = vy / gravity;
  const tDown = Math.sqrt((2 * (apex - to.y)) / gravity);
  const time = tUp + tDown;
  return { x: (to.x - from.x) / time, y: vy, z: (to.z - from.z) / time, time };
}
