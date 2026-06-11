import type { Archetype, ColliderDef, PartDef } from './types';

// Compact builders so the catalog below stays readable.
const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, rot?: { rx?: number; rz?: number }): PartDef => ({
  shape: 'box', size: [w, h, d], pos: [x, y, z], color, rotX: rot?.rx, rotZ: rot?.rz,
});
const cyl = (r: number, h: number, x: number, y: number, z: number, color: number, rBottom = r, rot?: { rx?: number; rz?: number }): PartDef => ({
  shape: 'cyl', size: [r, h, rBottom], pos: [x, y, z], color, rotX: rot?.rx, rotZ: rot?.rz,
});
const sph = (rx: number, ry: number, rz: number, x: number, y: number, z: number, color: number): PartDef => ({
  shape: 'sphere', size: [rx, ry, rz], pos: [x, y, z], color,
});
const tor = (r: number, tube: number, x: number, y: number, z: number, color: number, rot?: { rx?: number; rz?: number }, arc = 1): PartDef => ({
  shape: 'torus', size: [r, tube, arc], pos: [x, y, z], color, rotX: rot?.rx, rotZ: rot?.rz,
});
const cbox = (w: number, h: number, d: number, x: number, y: number, z: number): ColliderDef => ({ shape: 'box', size: [w, h, d], pos: [x, y, z] });
const ccyl = (r: number, h: number, x: number, y: number, z: number): ColliderDef => ({ shape: 'cyl', size: [r, h, 0], pos: [x, y, z] });

const A = (id: string, topY: number, topRadius: number, pathable: boolean, parts: PartDef[], colliders: ColliderDef[]): Archetype => ({
  id, topY, topRadius, pathable, parts, colliders,
});

// Palette shorthands
const STEEL = 0xb0bec5, DARKSTEEL = 0x607d8b, COPPER = 0xc97b4a, WOOD = 0x9a6b4f, DARKWOOD = 0x6d4c41,
  CREAM = 0xfff3d6, RED = 0xe05d5d, TEAL = 0x4f9e9b, NAVY = 0x33558a, WHITE = 0xf5f5f5, OFFWHITE = 0xe8e4d8,
  YELLOW = 0xffd24d, PASTELPINK = 0xf6b8c5, PASTELBLUE = 0xa8c8ec, MINT = 0x9fdfbf, GRAY = 0x9e9e9e,
  DARKGRAY = 0x5c6370, CARDBOARD = 0xc8a165, BRICK = 0xb5563f, GOLD = 0xd4af37, FOIL = 0xc9a227,
  CLOUDWHITE = 0xf2f6fb, SKYBLUE = 0x8fc7f2, GREEN = 0x66bb6a, PURPLE = 0x9575cd, BLACK = 0x37393f;

export const ARCHETYPES: Record<string, Archetype> = {};
function reg(a: Archetype) { ARCHETYPES[a.id] = a; }

// ---- generic structural props ----
reg(A('base_pad', 1.0, 6.4, false, [
  cyl(7, 1.0, 0, 0.5, 0, OFFWHITE),
  cyl(6.9, 0.12, 0, 1.02, 0, 0xd8d2c2),
  cyl(7.2, 0.3, 0, 0.15, 0, DARKWOOD),
], [ccyl(7, 1.0, 0, 0.5, 0)]));

reg(A('checkpoint_pad', 0.6, 2.5, false, [
  cyl(2.8, 0.6, 0, 0.3, 0, 0x4a5568),
  cyl(2.7, 0.1, 0, 0.62, 0, 0x718096),
  cyl(0.16, 3.4, -2.3, 2.3, 0, GOLD),
  cyl(0.16, 3.4, 2.3, 2.3, 0, GOLD),
  box(4.9, 0.28, 0.28, 0, 4.05, 0, GOLD),
], [ccyl(2.8, 0.6, 0, 0.3, 0)]));

reg(A('summit_pad', 1.2, 3.6, false, [
  cyl(4, 1.2, 0, 0.6, 0, 0xb8bcc8, 3.4),
  cyl(0.7, 0.25, 1.6, 1.25, 0.8, 0x8d93a3),
  cyl(0.5, 0.2, -1.4, 1.25, -1.2, 0x8d93a3),
  cyl(0.4, 0.18, 0.2, 1.25, -2.2, 0x8d93a3),
], [ccyl(4, 1.2, 0, 0.6, 0)]));

// ---- zone 0: kitchen ----
reg(A('k_pot', 1.5, 1.45, true, [
  cyl(1.6, 1.5, 0, 0.75, 0, STEEL),
  tor(1.6, 0.09, 0, 1.5, 0, DARKSTEEL, { rx: Math.PI / 2 }),
  box(0.9, 0.18, 0.3, 1.95, 1.1, 0, DARKSTEEL),
  box(0.9, 0.18, 0.3, -1.95, 1.1, 0, DARKSTEEL),
], [ccyl(1.6, 1.5, 0, 0.75, 0)]));

reg(A('k_pan', 0.5, 1.7, true, [
  cyl(1.8, 0.5, 0, 0.25, 0, BLACK),
  cyl(1.7, 0.06, 0, 0.51, 0, 0x4a4d55),
  box(2.2, 0.22, 0.4, 2.7, 0.35, 0, DARKSTEEL),
], [ccyl(1.8, 0.5, 0, 0.25, 0)]));

reg(A('k_mug', 1.6, 1.1, true, [
  cyl(1.2, 1.6, 0, 0.8, 0, RED),
  cyl(1.05, 0.12, 0, 1.62, 0, 0x6b3434),
  tor(0.55, 0.14, 1.45, 0.8, 0, RED, { rx: 0 }),
], [ccyl(1.2, 1.6, 0, 0.8, 0)]));

reg(A('k_plates', 0.95, 1.6, true, [
  cyl(1.7, 0.3, 0, 0.15, 0, CREAM),
  cyl(1.6, 0.3, 0, 0.47, 0, PASTELBLUE),
  cyl(1.7, 0.3, 0, 0.79, 0, CREAM),
], [ccyl(1.7, 0.95, 0, 0.48, 0)]));

reg(A('k_board', 0.4, 1.5, true, [
  box(3.4, 0.4, 2.2, 0, 0.2, 0, WOOD),
  cyl(0.25, 0.42, 1.45, 0.2, 0, DARKWOOD),
], [cbox(3.4, 0.4, 2.2, 0, 0.2, 0)]));

reg(A('k_milk', 3.0, 0.8, true, [
  box(1.7, 2.6, 1.7, 0, 1.3, 0, WHITE),
  box(1.7, 0.5, 1.7, 0, 2.75, 0, PASTELBLUE),
  box(1.74, 0.7, 1.74, 0, 1.5, 0, PASTELBLUE),
], [cbox(1.7, 3.0, 1.7, 0, 1.5, 0)]));

// ---- zone 1: living room ----
reg(A('l_books', 1.5, 1.3, true, [
  box(3.0, 0.5, 2.2, 0, 0.25, 0, TEAL),
  box(2.8, 0.5, 2.1, 0.15, 0.75, 0, RED, { rz: 0 }),
  box(2.9, 0.5, 2.0, -0.1, 1.25, 0.1, NAVY),
], [cbox(3.0, 1.5, 2.2, 0, 0.75, 0)]));

reg(A('l_cushion', 0.9, 1.25, true, [
  box(2.8, 0.9, 2.8, 0, 0.45, 0, 0x7986cb),
  sph(0.22, 0.22, 0.22, 0, 0.92, 0, 0x4a5899),
], [cbox(2.8, 0.9, 2.8, 0, 0.45, 0)]));

reg(A('l_remote', 0.5, 0.8, true, [
  box(3.6, 0.5, 1.6, 0, 0.25, 0, BLACK),
  cyl(0.18, 0.12, -1.2, 0.55, -0.35, RED),
  cyl(0.18, 0.12, -0.7, 0.55, 0.35, GRAY),
  cyl(0.18, 0.12, -0.2, 0.55, -0.35, GRAY),
  box(0.8, 0.1, 0.8, 0.9, 0.55, 0, DARKGRAY),
], [cbox(3.6, 0.5, 1.6, 0, 0.25, 0)]));

reg(A('l_lamp', 3.3, 1.0, true, [
  cyl(1.2, 0.4, 0, 0.2, 0, DARKWOOD),
  cyl(0.14, 2.2, 0, 1.5, 0, GOLD),
  cyl(1.1, 0.9, 0, 2.85, 0, CREAM, 1.5),
], [ccyl(1.2, 0.4, 0, 0.2, 0), ccyl(1.05, 0.35, 0, 3.12, 0)]));

reg(A('l_pot', 1.4, 1.1, true, [
  cyl(1.3, 1.4, 0, 0.7, 0, 0xbf6b4e, 1.0),
  cyl(1.35, 0.25, 0, 1.3, 0, 0xa5573d),
  sph(0.6, 0.7, 0.6, 0.55, 1.9, 0.4, GREEN),
  sph(0.5, 0.6, 0.5, -0.5, 1.8, -0.3, 0x55a05a),
], [ccyl(1.3, 1.4, 0, 0.7, 0)]));

reg(A('l_frame', 0.3, 0.2, false, [
  box(2.6, 3.2, 0.3, 0, 1.6, 0, GOLD),
  box(2.1, 2.7, 0.32, 0, 1.6, 0, TEAL),
], [cbox(2.6, 3.2, 0.3, 0, 1.6, 0)]));

// ---- zone 2: bedroom ----
reg(A('b_pillow', 1.0, 1.3, true, [
  box(3.2, 1.0, 2.4, 0, 0.5, 0, WHITE),
  box(3.3, 0.25, 2.5, 0, 0.5, 0, PASTELPINK),
], [cbox(3.2, 1.0, 2.4, 0, 0.5, 0)]));

reg(A('b_clock', 2.4, 0.9, true, [
  box(2.4, 2.2, 1.0, 0, 1.1, 0, RED),
  cyl(0.9, 0.1, 0, 1.2, 0.51, WHITE, 0.9, { rx: Math.PI / 2 }),
  sph(0.4, 0.4, 0.4, -0.7, 2.45, 0, GOLD),
  sph(0.4, 0.4, 0.4, 0.7, 2.45, 0, GOLD),
], [cbox(2.4, 2.4, 1.0, 0, 1.2, 0)]));

reg(A('b_drawer', 2.5, 1.4, true, [
  box(3.4, 2.5, 2.4, 0, 1.25, 0, WOOD),
  box(3.0, 0.9, 0.15, 0, 1.85, 1.21, DARKWOOD),
  box(3.0, 0.9, 0.15, 0, 0.75, 1.21, DARKWOOD),
  sph(0.14, 0.14, 0.14, 0, 1.85, 1.32, GOLD),
  sph(0.14, 0.14, 0.14, 0, 0.75, 1.32, GOLD),
], [cbox(3.4, 2.5, 2.4, 0, 1.25, 0)]));

reg(A('b_slipper', 0.8, 1.0, true, [
  box(3.0, 0.8, 1.6, 0, 0.4, 0, PASTELPINK),
  box(1.3, 0.5, 1.7, 0.7, 0.95, 0, 0xe89aab),
], [cbox(3.0, 0.8, 1.6, 0, 0.4, 0)]));

reg(A('b_lamp2', 2.7, 1.3, true, [
  cyl(1.0, 0.35, 0, 0.18, 0, PURPLE),
  cyl(0.12, 1.8, 0, 1.2, 0, GRAY),
  sph(1.5, 0.8, 1.5, 0, 2.4, 0, 0xc3aef0),
], [ccyl(1.0, 0.35, 0, 0.18, 0), ccyl(1.35, 0.4, 0, 2.5, 0)]));

reg(A('b_tissue', 1.6, 1.0, true, [
  box(2.4, 1.6, 1.7, 0, 0.8, 0, MINT),
  box(1.2, 0.25, 0.5, 0, 1.65, 0, WHITE, { rz: 0.18 }),
], [cbox(2.4, 1.6, 1.7, 0, 0.8, 0)]));

// ---- zone 3: bathroom ----
reg(A('ba_soap', 1.0, 1.0, true, [
  box(2.6, 1.0, 1.8, 0, 0.5, 0, 0x6fd6e0),
  box(1.4, 0.18, 0.9, 0, 1.02, 0, 0x9ae6ee),
], [cbox(2.6, 1.0, 1.8, 0, 0.5, 0)]));

reg(A('ba_duck', 1.7, 1.0, true, [
  sph(1.5, 1.1, 1.3, 0, 1.0, 0, YELLOW),
  sph(0.75, 0.75, 0.75, 1.15, 2.0, 0, YELLOW),
  box(0.7, 0.25, 0.5, 1.95, 1.9, 0, 0xf08c2d),
  sph(0.1, 0.1, 0.1, 1.5, 2.25, 0.3, BLACK),
  sph(0.1, 0.1, 0.1, 1.5, 2.25, -0.3, BLACK),
], [cbox(2.4, 1.7, 2.0, -0.2, 0.85, 0)]));

reg(A('ba_cup', 2.2, 1.1, true, [
  cyl(1.3, 2.2, 0, 1.1, 0, PASTELBLUE, 1.1),
  box(0.3, 1.6, 0.3, 0.9, 2.7, 0.5, RED, { rz: 0.25 }),
  box(0.3, 1.5, 0.3, 0.7, 2.65, -0.6, GREEN, { rz: -0.2 }),
], [ccyl(1.3, 2.2, 0, 1.1, 0)]));

reg(A('ba_towels', 2.1, 1.2, true, [
  box(3.0, 0.7, 2.4, 0, 0.35, 0, WHITE),
  box(2.9, 0.7, 2.3, 0.05, 1.05, 0, PASTELBLUE),
  box(3.0, 0.7, 2.35, -0.05, 1.75, 0, MINT),
], [cbox(3.0, 2.1, 2.4, 0, 1.05, 0)]));

reg(A('ba_shampoo', 3.0, 0.8, true, [
  box(1.8, 3.0, 1.1, 0, 1.5, 0, 0x7e57c2),
  cyl(0.45, 0.5, 0, 3.2, 0, WHITE),
  box(1.4, 1.0, 1.14, 0, 1.7, 0, WHITE),
], [cbox(1.8, 3.0, 1.1, 0, 1.5, 0)]));

// ---- zone 4: home office ----
reg(A('o_keyboard', 0.55, 0.8, true, [
  box(3.8, 0.5, 1.7, 0, 0.25, 0, DARKGRAY),
  box(3.4, 0.14, 0.32, 0, 0.55, -0.55, 0x787f8c),
  box(3.4, 0.14, 0.32, 0, 0.55, -0.12, 0x787f8c),
  box(3.4, 0.14, 0.32, 0, 0.55, 0.31, 0x787f8c),
  box(2.2, 0.14, 0.32, -0.3, 0.55, 0.68, 0x787f8c),
], [cbox(3.8, 0.55, 1.7, 0, 0.28, 0)]));

reg(A('o_laptop', 0.35, 1.1, true, [
  box(3.0, 0.35, 2.1, 0, 0.18, 0, STEEL),
  box(3.0, 2.2, 0.18, 0, 1.1, -1.25, DARKSTEEL, { rx: -0.3 }),
], [cbox(3.0, 0.35, 2.1, 0, 0.18, 0)]));

reg(A('o_pencilcup', 2.0, 1.0, true, [
  cyl(1.2, 2.0, 0, 1.0, 0, NAVY),
  box(0.22, 1.5, 0.22, 0.6, 2.6, 0.3, YELLOW, { rz: 0.18 }),
  box(0.22, 1.4, 0.22, -0.5, 2.55, -0.3, RED, { rz: -0.15 }),
  box(0.22, 1.3, 0.22, 0.1, 2.5, -0.55, GREEN, { rz: 0.1 }),
], [ccyl(1.2, 2.0, 0, 1.0, 0)]));

reg(A('o_globe', 3.75, 0.9, true, [
  cyl(1.3, 0.5, 0, 0.25, 0, DARKWOOD),
  cyl(0.12, 1.0, 0, 0.9, 0, GOLD),
  sph(1.6, 1.6, 1.6, 0, 2.2, 0, 0x4a90c4),
  sph(0.7, 0.45, 1.0, 0.9, 2.6, 0.6, GREEN),
  sph(0.6, 0.4, 0.7, -0.8, 1.8, -0.7, GREEN),
], [ccyl(1.3, 0.5, 0, 0.25, 0), ccyl(1.0, 0.35, 0, 3.6, 0)]));

reg(A('o_books', 1.6, 1.2, true, [
  box(2.8, 0.55, 2.0, 0, 0.27, 0, 0x8e5b3a),
  box(2.7, 0.55, 2.1, 0.1, 0.82, -0.05, NAVY),
  box(2.9, 0.5, 1.9, -0.05, 1.35, 0.08, RED),
], [cbox(2.9, 1.6, 2.1, 0, 0.8, 0)]));

reg(A('o_mug', 1.5, 1.0, true, [
  cyl(1.1, 1.5, 0, 0.75, 0, NAVY),
  tor(0.5, 0.13, 1.32, 0.75, 0, NAVY),
  cyl(0.95, 0.08, 0, 1.52, 0, 0x3c2415),
], [ccyl(1.1, 1.5, 0, 0.75, 0)]));

// ---- zone 5: attic ----
reg(A('a_box', 2.2, 1.4, true, [
  box(3.0, 2.2, 3.0, 0, 1.1, 0, CARDBOARD),
  box(3.04, 0.5, 0.8, 0, 2.0, 0, 0xb58e4f),
  box(1.5, 0.04, 3.04, 0, 2.21, 0, 0xd9c39a),
], [cbox(3.0, 2.2, 3.0, 0, 1.1, 0)]));

reg(A('a_trunk', 2.25, 1.4, true, [
  box(3.4, 2.0, 2.2, 0, 1.0, 0, 0x7a4a32),
  box(3.4, 0.45, 2.2, 0, 2.05, 0, 0x5d3826),
  box(3.5, 0.3, 0.4, 0, 1.0, 1.0, GOLD),
  box(3.5, 0.3, 0.4, 0, 1.0, -1.0, GOLD),
], [cbox(3.4, 2.25, 2.2, 0, 1.12, 0)]));

reg(A('a_chair', 2.3, 1.1, true, [
  box(2.4, 0.5, 2.4, 0, 2.05, 0, DARKWOOD),
  box(0.25, 1.8, 0.25, -1.0, 0.9, -1.0, WOOD),
  box(0.25, 1.8, 0.25, 1.0, 0.9, -1.0, WOOD),
  box(0.25, 1.8, 0.25, -1.0, 0.9, 1.0, WOOD),
  box(0.25, 1.8, 0.25, 1.0, 0.9, 1.0, WOOD),
  box(2.4, 2.2, 0.3, 0, 3.3, -1.05, WOOD),
], [cbox(2.4, 0.5, 2.4, 0, 2.05, 0), cbox(2.4, 2.2, 0.3, 0, 3.3, -1.05)]));

reg(A('a_cage', 2.95, 1.2, true, [
  cyl(1.5, 0.3, 0, 0.15, 0, GOLD),
  cyl(1.45, 2.4, 0, 1.5, 0, 0xd9c06a),
  sph(1.45, 0.7, 1.45, 0, 2.75, 0, GOLD),
  cyl(0.08, 0.5, 0, 3.3, 0, GOLD),
], [ccyl(1.5, 0.3, 0, 0.15, 0), ccyl(1.35, 0.4, 0, 2.85, 0)]));

reg(A('a_radio', 1.9, 1.1, true, [
  box(3.0, 1.9, 1.5, 0, 0.95, 0, 0x8b5a2b),
  cyl(0.55, 0.1, -0.7, 0.95, 0.76, CREAM, 0.55, { rx: Math.PI / 2 }),
  box(0.8, 0.8, 0.1, 0.8, 0.95, 0.76, 0x3c2415),
  cyl(0.05, 1.4, 1.3, 2.5, 0, GRAY, 0.05, { rz: -0.4 }),
], [cbox(3.0, 1.9, 1.5, 0, 0.95, 0)]));

// ---- zone 6: rooftop ----
reg(A('r_chimney', 3.0, 1.3, true, [
  box(2.6, 3.0, 2.6, 0, 1.5, 0, BRICK),
  box(2.9, 0.4, 2.9, 0, 2.95, 0, 0x9c4734),
], [cbox(2.6, 3.0, 2.6, 0, 1.5, 0), cbox(2.9, 0.4, 2.9, 0, 2.95, 0)]));

reg(A('r_ac', 2.55, 1.4, true, [
  box(3.0, 2.4, 3.0, 0, 1.2, 0, 0xb8bec7),
  cyl(1.1, 0.25, 0, 2.5, 0, DARKGRAY),
  box(2.0, 0.12, 0.3, 0, 2.62, 0, GRAY),
  box(0.3, 0.12, 2.0, 0, 2.62, 0, GRAY),
], [cbox(3.0, 2.55, 3.0, 0, 1.27, 0)]));

reg(A('r_dish', 3.1, 1.2, true, [
  box(1.6, 0.4, 1.6, 0, 0.2, 0, DARKGRAY),
  cyl(0.14, 2.6, 0, 1.7, 0, GRAY),
  cyl(1.5, 0.35, 0, 3.0, 0, WHITE, 0.5),
], [cbox(1.6, 0.4, 1.6, 0, 0.2, 0), ccyl(1.4, 0.3, 0, 3.0, 0)]));

reg(A('r_shingle', 0.5, 1.5, true, [
  box(3.4, 0.5, 2.6, 0, 0.25, 0, 0x705a50),
  box(3.4, 0.08, 0.5, 0, 0.52, -0.8, 0x5d4a42),
  box(3.4, 0.08, 0.5, 0, 0.52, 0.4, 0x5d4a42),
], [cbox(3.4, 0.5, 2.6, 0, 0.25, 0)]));

reg(A('r_vent', 2.45, 1.4, true, [
  cyl(1.2, 2.1, 0, 1.05, 0, STEEL),
  cyl(1.6, 0.35, 0, 2.27, 0, DARKSTEEL),
], [ccyl(1.2, 2.1, 0, 1.05, 0), ccyl(1.55, 0.35, 0, 2.27, 0)]));

// ---- zone 7: open sky ----
reg(A('s_cloud', 1.3, 1.8, true, [
  sph(2.2, 1.1, 1.8, 0, 0.6, 0, CLOUDWHITE),
  sph(1.5, 0.9, 1.3, 1.6, 0.5, 0.4, CLOUDWHITE),
  sph(1.4, 0.85, 1.2, -1.5, 0.45, -0.3, CLOUDWHITE),
], [cbox(4.2, 1.3, 3.0, 0, 0.65, 0)]));

reg(A('s_kite', 0.4, 1.2, true, [
  box(3.0, 0.4, 3.0, 0, 0.2, 0, RED),
  box(3.1, 0.1, 0.2, 0, 0.42, 0, YELLOW),
  box(0.2, 0.1, 3.1, 0, 0.42, 0, YELLOW),
], [cbox(3.0, 0.4, 3.0, 0, 0.2, 0)]));

reg(A('s_plane', 0.45, 1.3, true, [
  box(3.6, 0.35, 1.4, 0, 0.3, 0, WHITE),
  box(3.2, 0.3, 1.2, 0, 0.0, -1.1, OFFWHITE, { rx: 0.5 }),
  box(3.2, 0.3, 1.2, 0, 0.0, 1.1, OFFWHITE, { rx: -0.5 }),
], [cbox(3.6, 0.45, 1.4, 0, 0.25, 0)]));

reg(A('s_umbrella', 3.15, 1.6, true, [
  cyl(0.12, 3.0, 0, 1.5, 0, DARKWOOD),
  cyl(1.9, 0.7, 0, 2.85, 0, RED, 0.4),
  sph(0.16, 0.16, 0.16, 0, 3.3, 0, GOLD),
], [ccyl(0.3, 2.6, 0, 1.3, 0), ccyl(1.75, 0.4, 0, 2.95, 0)]));

reg(A('s_balloonbunch', 0.9, 1.1, false, [
  sph(1.0, 1.25, 1.0, 0, 4.2, 0, RED),
  sph(0.9, 1.1, 0.9, 1.2, 4.6, 0.5, SKYBLUE),
  sph(0.95, 1.15, 0.95, -1.1, 4.4, -0.4, YELLOW),
  box(1.8, 0.9, 1.8, 0, 0.45, 0, CARDBOARD),
], [cbox(1.8, 0.9, 1.8, 0, 0.45, 0)]));

// ---- zone 8: stratosphere ----
reg(A('st_balloon', 5.05, 1.1, true, [
  sph(2.3, 2.5, 2.3, 0, 2.4, 0, 0xe8ecf2),
  cyl(0.04, 1.6, 0, 4.6, 0, GRAY),
  cyl(1.2, 0.35, 0, 4.95, 0, DARKGRAY),
], [ccyl(1.2, 0.35, 0, 4.95, 0), cbox(1.6, 1.2, 1.6, 0, 2.4, 0)]));

reg(A('st_drone', 0.95, 1.0, true, [
  box(2.0, 0.8, 2.0, 0, 0.5, 0, DARKGRAY),
  box(2.8, 0.16, 0.3, 0, 0.95, 0, GRAY, { rz: 0 }),
  box(0.3, 0.16, 2.8, 0, 0.95, 0, GRAY),
  cyl(0.85, 0.08, 1.5, 1.05, 1.5, 0x6b7280),
  cyl(0.85, 0.08, -1.5, 1.05, 1.5, 0x6b7280),
  cyl(0.85, 0.08, 1.5, 1.05, -1.5, 0x6b7280),
  cyl(0.85, 0.08, -1.5, 1.05, -1.5, 0x6b7280),
], [cbox(2.0, 0.95, 2.0, 0, 0.5, 0)]));

reg(A('st_panel', 0.5, 1.4, true, [
  box(3.2, 0.5, 2.6, 0, 0.25, 0, 0x4b5563),
  cyl(0.06, 1.8, 1.2, 1.4, 0.9, GRAY),
  box(0.7, 0.5, 0.5, -0.9, 0.75, -0.6, RED),
  cyl(0.3, 0.3, 0.4, 0.62, 0.3, GOLD),
], [cbox(3.2, 0.5, 2.6, 0, 0.25, 0)]));

reg(A('st_blimp', 1.0, 1.2, false, [
  sph(4.5, 1.8, 1.8, 0, 3.5, 0, 0xc7d2e0),
  box(2.0, 0.9, 1.1, 0, 0.45, 0, DARKGRAY),
  box(1.2, 1.0, 0.18, -4.2, 3.8, 0, RED),
], [cbox(2.0, 0.9, 1.1, 0, 0.45, 0)]));

reg(A('st_moon', 0.6, 1.3, true, [
  sph(1.9, 0.85, 1.9, 0, -0.4, 0, 0xd9dce3),
  cyl(0.5, 0.18, 0.7, 0.42, 0.4, 0xb8bcc8),
  cyl(0.35, 0.15, -0.8, 0.44, -0.5, 0xb8bcc8),
], [ccyl(1.7, 0.6, 0, 0.25, 0)]));

// ---- zone 9: deep space ----
reg(A('sp_sat', 2.1, 1.2, true, [
  box(2.4, 2.0, 2.4, 0, 1.0, 0, FOIL),
  box(3.2, 0.14, 1.7, 2.8, 1.0, 0, NAVY),
  box(3.2, 0.14, 1.7, -2.8, 1.0, 0, NAVY),
  cyl(0.06, 1.5, 0, 2.7, 0, GRAY),
  cyl(0.5, 0.25, 0, 3.4, 0, WHITE, 0.15),
], [cbox(2.4, 2.0, 2.4, 0, 1.0, 0), cbox(3.2, 0.2, 1.7, 2.8, 1.0, 0), cbox(3.2, 0.2, 1.7, -2.8, 1.0, 0)]));

reg(A('sp_junk', 0.45, 1.4, true, [
  box(3.2, 0.4, 2.6, 0, 0.2, 0, 0x7d8595),
  box(1.4, 0.5, 0.8, 0.6, 0.6, 0.4, DARKGRAY, { rz: 0.3 }),
  cyl(0.1, 1.2, -1.0, 0.8, -0.6, GRAY, 0.1, { rz: 0.7 }),
], [cbox(3.2, 0.45, 2.6, 0, 0.22, 0)]));

reg(A('sp_rock', 1.8, 1.3, true, [
  box(3.0, 1.8, 2.6, 0, 0.9, 0, 0x6e7480),
  sph(0.8, 0.6, 0.8, 1.2, 1.7, 0.8, 0x5d6370),
  sph(0.6, 0.5, 0.6, -1.1, 1.6, -0.6, 0x5d6370),
], [cbox(3.0, 1.8, 2.6, 0, 0.9, 0)]));

reg(A('sp_tank', 2.8, 1.2, true, [
  cyl(1.4, 2.6, 0, 1.3, 0, WHITE),
  sph(1.4, 0.6, 1.4, 0, 2.6, 0, OFFWHITE),
  cyl(0.25, 0.5, 0, 2.95, 0, RED),
  box(1.5, 0.6, 0.1, 0, 1.2, 1.41, RED),
], [ccyl(1.4, 2.8, 0, 1.4, 0)]));

reg(A('sp_capsule', 2.2, 1.3, true, [
  cyl(1.7, 2.0, 0, 1.0, 0, 0xd8dbe2, 1.3),
  cyl(1.7, 0.3, 0, 2.15, 0, 0xb04a36),
  cyl(0.4, 0.4, 1.2, 0.8, 0.9, NAVY, 0.4, { rx: 0.5 }),
], [ccyl(1.7, 2.2, 0, 1.1, 0)]));

// ---- theme tables ----
export interface ThemeDef {
  id: string;
  label: string;
  pathProps: string[]; // archetype ids usable on the climbing path
  decorProps: string[]; // extra ids sprinkled around for atmosphere
}

export const THEMES: ThemeDef[] = [
  { id: 'kitchen', label: 'Kitchen', pathProps: ['k_pot', 'k_pan', 'k_mug', 'k_plates', 'k_board', 'k_milk'], decorProps: ['k_pot', 'k_mug', 'k_milk', 'k_plates'] },
  { id: 'livingroom', label: 'Living Room', pathProps: ['l_books', 'l_cushion', 'l_remote', 'l_lamp', 'l_pot'], decorProps: ['l_frame', 'l_books', 'l_lamp', 'l_cushion'] },
  { id: 'bedroom', label: 'Bedroom', pathProps: ['b_pillow', 'b_clock', 'b_drawer', 'b_slipper', 'b_lamp2', 'b_tissue'], decorProps: ['b_pillow', 'b_clock', 'b_lamp2'] },
  { id: 'bathroom', label: 'Bathroom', pathProps: ['ba_soap', 'ba_duck', 'ba_cup', 'ba_towels', 'ba_shampoo'], decorProps: ['ba_duck', 'ba_shampoo', 'ba_towels'] },
  { id: 'office', label: 'Home Office', pathProps: ['o_keyboard', 'o_laptop', 'o_pencilcup', 'o_globe', 'o_books', 'o_mug'], decorProps: ['o_globe', 'o_books', 'o_laptop'] },
  { id: 'attic', label: 'Attic', pathProps: ['a_box', 'a_trunk', 'a_chair', 'a_cage', 'a_radio'], decorProps: ['a_box', 'a_trunk', 'a_radio'] },
  { id: 'rooftop', label: 'Rooftop', pathProps: ['r_chimney', 'r_ac', 'r_dish', 'r_shingle', 'r_vent'], decorProps: ['r_chimney', 'r_dish', 'r_ac'] },
  { id: 'sky', label: 'Open Sky', pathProps: ['s_cloud', 's_kite', 's_plane', 's_umbrella'], decorProps: ['s_balloonbunch', 's_cloud', 's_kite'] },
  { id: 'stratosphere', label: 'Stratosphere', pathProps: ['st_balloon', 'st_drone', 'st_panel', 'st_moon'], decorProps: ['st_blimp', 'st_balloon', 'st_drone'] },
  { id: 'space', label: 'Deep Space', pathProps: ['sp_sat', 'sp_junk', 'sp_rock', 'sp_tank', 'sp_capsule'], decorProps: ['sp_sat', 'sp_rock', 'sp_junk'] },
];
