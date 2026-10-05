export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Cosmetics {
  color: number; // index into COSMETIC_COLORS
  hat: number; // index into HATS
  eyes: number; // index into EYES
}

export interface PlayerInfo {
  id: string;
  name: string;
  cosmetics: Cosmetics;
  ready: boolean;
}

// ---- Level data (deterministically generated from a seed on every peer) ----

export type PartShape = 'box' | 'cyl' | 'sphere' | 'torus';

export interface PartDef {
  shape: PartShape;
  // box: [w,h,d] · cyl: [rTop,h,rBottom] · sphere: [rx,ry,rz] · torus: [radius,tube,arcFraction]
  size: [number, number, number];
  pos: [number, number, number];
  rotX?: number;
  rotZ?: number;
  color: number;
}

export interface ColliderDef {
  shape: 'box' | 'cyl';
  size: [number, number, number]; // box: [w,h,d] · cyl: [r,h,_]
  pos: [number, number, number];
  // Tilt, applied before the prop's own Y rotation. Lets a prop carry a sloped
  // walkable face (leaning broom handles, ramps) instead of only axis-aligned boxes.
  rotX?: number;
  rotZ?: number;
}

// Purely cosmetic response to being touched: a few parts of the prop are built
// as their own little group and animated on contact, with a sound. Nothing here
// affects collision or gameplay.
export type InteractKind =
  | 'spin' // whirls around its own Y axis
  | 'spinz' // whirls around Z, for wheels and dials facing the viewer
  | 'swing' // rocks back and forth
  | 'bob' // bounces on the spot
  | 'pop'; // launches up and drops back

export type InteractSound = 'ding' | 'squeak' | 'clack' | 'whirr' | 'chime';

export interface InteractDef {
  parts: PartDef[]; // positioned relative to `pivot`, kept out of the merged mesh
  pivot: [number, number, number]; // prop-local origin the parts move around
  kind: InteractKind;
  sound: InteractSound;
  radius: number; // how close the player has to get, in metres
  duration: number; // seconds the animation runs
  hint?: string; // one-off toast the first time anyone sets it off
}

export interface Archetype {
  id: string;
  parts: PartDef[];
  colliders: ColliderDef[];
  interact?: InteractDef;
  topY: number; // height of the standable top surface above the prop origin
  topRadius: number; // usable standing radius on that surface
  pathable: boolean; // can be used as a platform on the climbing path
}

export interface PropInstance {
  archetype: string;
  pos: Vec3; // prop origin (top surface sits at pos.y + topY)
  rotY: number;
  solid: boolean; // decorative far-field props skip colliders
}

export interface CheckpointData {
  index: number;
  pos: Vec3; // standing position players respawn at
  zone: number;
  rotY: number; // orientation of the arch/banner (aligned to the path's approach direction)
}

// latch: one press keeps it out for good · hold: out while a plate is pressed
// (with a grace period) · duo: two climbers on the plate at once (co-op only) ·
// twin: two plates on separate platforms pressed at the same time (co-op only)
export type BridgeMode = 'latch' | 'hold' | 'duo' | 'twin';

export type MoverMotion =
  | 'shuttle' // ping-pongs horizontally across a gap
  | 'lift' // ping-pongs vertically up a wall
  | 'spinner'; // a long beam turning around its middle, bridging two platforms twice a turn

export type GadgetData =
  | {
      kind: 'bridge';
      id: number;
      near: Vec3; // near edge anchor (y = deck surface height)
      rotY: number; // direction angle from near platform toward far platform
      length: number;
      mode: BridgeMode;
      plates: Vec3[]; // standing positions of pressure plates
    }
  // A ladder leaning from the lower platform's edge up against the next prop.
  // `exit` is where you're set down after climbing off the top.
  | { kind: 'ladder'; id: number; base: Vec3; top: Vec3; rotY: number; exit: Vec3 }
  | { kind: 'rope'; id: number; top: Vec3; length: number; exit: Vec3 }
  // A slack rope strung between two platform edges across an unjumpable gap.
  // Simulated as a verlet string on each client; you hang under it and shimmy
  // across. `a`/`b` are the anchor knots, `deckY` the platform surface they sit
  // on, and `exitA`/`exitB` where you haul yourself up at each end.
  | { kind: 'traverse'; id: number; a: Vec3; b: Vec3; deckY: number; exitA: Vec3; exitB: Vec3 }
  // A deck that moves on the shared game clock (see shared/gadgets.ts moverPose).
  | {
      kind: 'mover';
      id: number;
      motion: MoverMotion;
      a: Vec3; // deck top-center at one end of travel (spinner: the hub)
      b: Vec3; // deck top-center at the other end (spinner: same as a)
      size: [number, number, number]; // deck [length along rotY, thickness, width]
      rotY: number; // deck heading (spinner: heading at t = 0)
      period: number; // seconds per full cycle (there and back / one revolution)
      phase: number; // 0..1 cycle offset
      rest: number; // seconds parked at each end (ping-pong movers)
      spin?: 1 | -1; // spinner turning direction
    }
  // Co-op: a plank on a fulcrum. Landing on the raised slam end flings whoever
  // sits on the seat end up to `target`; the lever there drops a weight onto the
  // slam end so the last climber can be launched too.
  | {
      kind: 'seesaw';
      id: number;
      pivot: Vec3; // fulcrum top, plank center
      rotY: number; // plank heading from the seat end toward the slam end
      target: Vec3; // landing spot for launched climbers (top surface)
      lever: Vec3; // lever plate standing position, on the target platform
    }
  // Co-op: a lift that rises while somebody stands on a crank plate and sinks
  // back when nobody does — so one climber has to stay behind to send it up.
  | {
      kind: 'cranklift';
      id: number;
      base: Vec3; // deck top-center at the bottom of the shaft
      rise: number;
      rotY: number; // heading from the lower platform toward the shaft
      plates: Vec3[]; // [bottom crank, top crank] standing positions
    };

export type ItemType = 'doublejump' | 'telescope' | 'grapple';

export interface ItemSpawn {
  id: number;
  type: ItemType;
  pos: Vec3;
}

export interface ZoneData {
  index: number;
  theme: string;
  label: string;
  yStart: number;
  yEnd: number;
}

export interface LevelData {
  seed: string;
  teamSize: number; // co-op contraptions only appear when this is 2 or more
  zones: ZoneData[];
  props: PropInstance[];
  gadgets: GadgetData[];
  items: ItemSpawn[];
  checkpoints: CheckpointData[];
  flagPos: Vec3;
  spawn: Vec3;
  totalHeight: number;
  nodes: Vec3[]; // path node top positions, in order (debug/teleport aid)
}

export interface RunRow {
  names: string[];
  durationMs: number;
  seed: string;
  date: string;
}

export interface GadgetState {
  active: boolean;
  latched: boolean;
  since: number; // server time of last state flip
  plates: number[]; // players currently standing on each plate
}
