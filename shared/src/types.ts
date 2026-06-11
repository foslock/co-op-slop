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
}

export interface Archetype {
  id: string;
  parts: PartDef[];
  colliders: ColliderDef[];
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

export type BridgeMode = 'latch' | 'hold' | 'duo';

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
  | { kind: 'ladder'; id: number; base: Vec3; height: number; rotY: number }
  | { kind: 'rope'; id: number; top: Vec3; length: number };

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
