import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ARCHETYPES, THEMES, type GadgetState, type InteractDef, type ItemType, type LevelData, type PartDef, type Vec3 } from 'shared';
import { GROUP_LEVEL, groups } from './physics';
import { Rope } from './rope';
import { Bridge, CrankLift, Mover, Seesaw, type BuildKit } from './contraptions';
import type { Kinematic } from './kinematic';

export { Bridge } from './contraptions';

export interface Climbable {
  a: THREE.Vector3; // bottom
  b: THREE.Vector3; // top (ladders may lean, so b need not be straight above a)
  exitDir: THREE.Vector3; // horizontal heading toward the platform you climb onto
  exit: THREE.Vector3; // standing spot you're set down on at the top
}

export interface Plate {
  gadgetId: number;
  plateIdx: number;
  pos: THREE.Vector3;
  button: THREE.Mesh;
  kind: 'bridge' | 'crank';
}

/** A seesaw's lever on the ledge above it. */
export interface Lever {
  gadgetId: number;
  pos: THREE.Vector3;
}

/** A prop's cosmetic touch-response: its own little group, animated on contact. */
export interface Interactable {
  group: THREE.Group;
  def: InteractDef;
  pos: THREE.Vector3; // world position of the pivot, for proximity checks
  baseRotY: number;
  startedAt: number; // elapsed seconds when it was last set off, -1 when idle
}

export interface ItemVisual {
  id: number;
  type: ItemType;
  group: THREE.Group;
  basePos: THREE.Vector3;
  taken: boolean;
}

export const ITEM_COLORS: Record<ItemType, number> = {
  doublejump: 0x69db7c,
  telescope: 0x4dabf7,
  grapple: 0xffa94d,
};

// ---- shared shader patch: camera occlusion fade + toy-plastic rim light ----
// Level geometry is merged into a handful of meshes, so we can't fade single
// props via material opacity. Instead every level material gets a shader patch:
// fragments that are closer to the camera than the player AND inside a
// screen-space circle around the player are screen-door dithered away, so the
// camera never has to pull in. The same patch adds a soft fresnel rim that
// makes props read like glossy toys against the sky. Uniform objects are shared
// by all materials and updated once per frame by the game loop.
export const occlusionUniforms = {
  uOccCenter: { value: new THREE.Vector2(-10000, -10000) }, // player center, device px
  uOccDepth: { value: 1e9 }, // player view-space depth
  uOccRadius: { value: 0 }, // cutout radius, device px
  uRim: { value: 0.22 }, // rim light strength
  uRimColor: { value: new THREE.Color(0xdfeeff) },
};

export function patchOcclusionFade(mat: THREE.Material) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOccCenter = occlusionUniforms.uOccCenter;
    shader.uniforms.uOccDepth = occlusionUniforms.uOccDepth;
    shader.uniforms.uOccRadius = occlusionUniforms.uOccRadius;
    shader.uniforms.uRim = occlusionUniforms.uRim;
    shader.uniforms.uRimColor = occlusionUniforms.uRimColor;
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      `uniform vec2 uOccCenter;
uniform float uOccDepth;
uniform float uOccRadius;
uniform float uRim;
uniform vec3 uRimColor;
void main() {
	float occKeep = 1.0;
	float occDist = distance(gl_FragCoord.xy, uOccCenter);
	if (vViewPosition.z < uOccDepth - 0.5 && occDist < uOccRadius) {
		occKeep = mix(0.22, 1.0, smoothstep(uOccRadius * 0.55, uOccRadius, occDist));
	}
	occKeep *= clamp(vViewPosition.z / 1.4, 0.1, 1.0); // also thin out geometry hugging the lens
	if (occKeep < 0.999) {
		float occNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
		if (occNoise > occKeep) discard;
	}`,
    );
    if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `{
	float rimF = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
	outgoingLight += uRim * rimF * mix(uRimColor, diffuseColor.rgb, 0.35);
}
#include <opaque_fragment>`,
      );
    }
  };
}

export interface LevelHandles {
  group: THREE.Group;
  bridges: Map<number, Bridge>;
  movers: Mover[];
  seesaws: Map<number, Seesaw>;
  cranks: Map<number, CrankLift>;
  /** Every moving collider, by handle — for carrying riders. */
  kinematics: Map<number, Kinematic>;
  /** Ladders — rigid lines you climb. */
  climbables: Climbable[];
  /** Simulated ropes: strung spans and vertical hangs alike. */
  ropes: Rope[];
  /** Props that react cosmetically to being touched. */
  interactables: Interactable[];
  plates: Plate[];
  levers: Lever[];
  items: Map<number, ItemVisual>;
  addRope(top: Vec3, length: number, exit?: Vec3): void;
  /** Server state for a bridge / crank lift and its plates. */
  setGadgetState(id: number, state: GadgetState): void;
  setCheckpointReached(index: number): void;
  /** Advance bridges and moving decks; call once per fixed physics step (clock = shared game seconds). */
  stepGadgets(dt: number, clock: number): void;
  /** Advance the rope simulation; call once per fixed physics step. */
  stepRopes(dt: number, gravityScale: number): void;
  /** Meshes follow their colliders / animations; call once per rendered frame. */
  syncGadgets(t: number, clock: number): void;
  updateVisuals(t: number): void;
  dispose(): void;
}

function makeGeo(part: PartDef): THREE.BufferGeometry {
  const [a, b, c] = part.size;
  switch (part.shape) {
    case 'box': return new THREE.BoxGeometry(a, b, c);
    case 'cyl': return new THREE.CylinderGeometry(a, c || a, b, 14);
    case 'sphere': { const g = new THREE.SphereGeometry(1, 14, 10); g.scale(a, b, c); return g; }
    case 'torus': return new THREE.TorusGeometry(a, b, 8, 18, (c || 1) * Math.PI * 2);
  }
}

// Colors in the catalog that are meant to be metal get a shiny material.
const METALS = new Set([
  0xb0bec5, 0x607d8b, 0xd7dde3, 0xd4af37, 0xc8a250, 0xc9a227, 0xc97b4a, 0x8b969c, 0x9aa6ad, 0xa9b1b8,
  0xc6ced4, 0x4b6068, 0x9aa3b2, 0xd8dbe2,
]);

const texCache: THREE.Texture[] = [];

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function bannerTexture(zoneNo: number, text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const c = canvas.getContext('2d')!;
  const grad = c.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2c3a73');
  grad.addColorStop(1, '#1b2550');
  c.fillStyle = grad;
  roundRect(c, 6, 6, 1012, 244, 40);
  c.fill();
  c.lineWidth = 12;
  c.strokeStyle = '#ffd24d';
  roundRect(c, 14, 14, 996, 228, 34);
  c.stroke();
  // zone number medallion
  c.fillStyle = '#ffd24d';
  c.beginPath();
  c.arc(128, 128, 78, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#2c3a73';
  c.font = '800 96px "Fredoka", "Nunito", system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(zoneNo), 128, 136);
  c.fillStyle = '#fff6d6';
  c.font = '800 104px "Fredoka", "Nunito", system-ui, sans-serif';
  let size = 104;
  while (c.measureText(text.toUpperCase()).width > 720 && size > 50) {
    size -= 6;
    c.font = `800 ${size}px "Fredoka", "Nunito", system-ui, sans-serif`;
  }
  c.fillText(text.toUpperCase(), 600, 136);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  texCache.push(tex);
  return tex;
}

/** A pill-shaped text sprite that always faces the camera. */
function labelSprite(text: string, opts: { bg?: string; fg?: string; scale?: number } = {}): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const c = canvas.getContext('2d')!;
  const font = '800 54px "Fredoka", "Nunito", system-ui, sans-serif';
  c.font = font;
  const w = Math.ceil(c.measureText(text).width) + 70;
  canvas.width = w;
  canvas.height = 96;
  c.font = font;
  c.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(c, 4, 10, w - 8, 82, 41);
  c.fill();
  c.fillStyle = opts.bg ?? '#1b2550';
  roundRect(c, 4, 4, w - 8, 82, 41);
  c.fill();
  c.fillStyle = opts.fg ?? '#ffd24d';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, w / 2, 48);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.push(tex);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const k = (opts.scale ?? 1) * 0.55;
  sprite.scale.set((w / 96) * k, k, 1);
  sprite.renderOrder = 4;
  return sprite;
}

export function buildLevel(
  scene: THREE.Scene,
  world: RAPIER.World,
  R: typeof RAPIER,
  level: LevelData,
): LevelHandles {
  const group = new THREE.Group();
  scene.add(group);
  const disposables: { dispose(): void }[] = [];
  const levelGroups = groups(GROUP_LEVEL, 0xffff);
  const staticBody = world.createRigidBody(R.RigidBodyDesc.fixed());

  // ---- merge prop geometry into a few vertex-colored meshes ----
  // One mesh per material (plastic / metal) per zone, so storeys out of view —
  // or outside the shadow camera — get culled instead of drawn every frame.
  // Each part gets a gentle bottom-to-top shading ramp (fake contact shadow /
  // ambient occlusion) and each prop a tiny brightness jitter, so repeated
  // props and same-colored parts don't read as one flat sheet.
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  let bucketZone = 0;
  const zoneOfY = (y: number) => {
    let zi = 0;
    for (const z of level.zones) if (y >= z.yStart - 2) zi = z.index;
    return zi;
  };
  const pm = new THREE.Matrix4();
  const im = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const col = new THREE.Color();

  const addPart = (part: PartDef, world4: THREE.Matrix4, jitter: number) => {
    const g = makeGeo(part);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const h = Math.max(1e-3, bb.max.y - bb.min.y);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    col.setHex(part.color); // linear working space, as vertex colors expect
    for (let i = 0; i < pos.count; i++) {
      const u = (pos.getY(i) - bb.min.y) / h;
      const shade = (h < 0.15 ? 0.97 : 0.8 + 0.2 * Math.sqrt(u)) * jitter;
      colors[i * 3] = col.r * shade;
      colors[i * 3 + 1] = col.g * shade;
      colors[i * 3 + 2] = col.b * shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pm.compose(
      new THREE.Vector3(part.pos[0], part.pos[1], part.pos[2]),
      q.setFromEuler(e.set(part.rotX ?? 0, 0, part.rotZ ?? 0)),
      new THREE.Vector3(1, 1, 1),
    );
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(world4, pm));
    const key = `${METALS.has(part.color) ? 'metal' : 'plastic'}|${bucketZone}`;
    const list = buckets.get(key) ?? [];
    list.push(g);
    buckets.set(key, list);
  };

  level.props.forEach((prop, pi) => {
    const arch = ARCHETYPES[prop.archetype];
    if (!arch) return;
    im.compose(
      new THREE.Vector3(prop.pos.x, prop.pos.y, prop.pos.z),
      q.setFromEuler(e.set(0, prop.rotY, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    const jitter = 0.94 + (((pi * 2654435761) >>> 0) % 1000) / 1000 * 0.12;
    const world4 = im.clone();
    bucketZone = zoneOfY(prop.pos.y);
    for (const part of arch.parts) addPart(part, world4, jitter);
    // colliders for anything on or near the path
    if (prop.solid) {
      const rotQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, prop.rotY, 0));
      for (const c of arch.colliders) {
        const local = new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]).applyQuaternion(rotQ);
        // a collider's own tilt (ramps, leaning handles) applies before the prop's Y spin
        const cq = (c.rotX || c.rotZ)
          ? rotQ.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(c.rotX ?? 0, 0, c.rotZ ?? 0)))
          : rotQ;
        const desc = (c.shape === 'box'
          ? R.ColliderDesc.cuboid(c.size[0] / 2, c.size[1] / 2, c.size[2] / 2)
          : R.ColliderDesc.cylinder(c.size[1] / 2, c.size[0]))
          .setTranslation(prop.pos.x + local.x, prop.pos.y + local.y, prop.pos.z + local.z)
          .setRotation({ x: cq.x, y: cq.y, z: cq.z, w: cq.w })
          .setCollisionGroups(levelGroups)
          .setFriction(0.9);
        world.createCollider(desc, staticBody);
      }
    }
  });

  const propMats = {
    plastic: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.58, metalness: 0.0 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.7 }),
  };
  for (const m of Object.values(propMats)) {
    patchOcclusionFade(m);
    disposables.push(m);
  }
  for (const [key, geos] of buckets) {
    if (geos.length === 0) continue;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, propMats[key.split('|')[0] as 'plastic' | 'metal']);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(merged);
  }

  // The floor of the bottom room: a fall early on lands you on the kitchen
  // (or basement, or garage) floor instead of in the void.
  world.createCollider(
    R.ColliderDesc.cylinder(0.5, 70).setTranslation(0, -0.5, 0).setCollisionGroups(levelGroups).setFriction(0.9),
    staticBody,
  );

  const sharedMat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opts });
    patchOcclusionFade(m);
    disposables.push(m);
    return m;
  };
  const sharedGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposables.push(g);
    return g;
  };
  const label = (text: string, opts?: { bg?: string; fg?: string; scale?: number }) => {
    const s = labelSprite(text, opts);
    disposables.push(s.material);
    return s;
  };

  // ---- checkpoint banners ----
  // The pad prop (pillars + crossbar) is rotated by cp.rotY in the generator; the
  // banner uses the same rotation so it hangs between the pillars, just under the
  // crossbar. Two front-facing planes back to back keep the text readable from
  // both sides without mirroring. A ring around the rim lights up once you've
  // checked in.
  const bannerGeo = sharedGeo(new THREE.PlaneGeometry(4.0, 1.0));
  const ringGeo = sharedGeo(new THREE.TorusGeometry(2.92, 0.11, 8, 48));
  const cpRings = new Map<number, THREE.MeshStandardMaterial>();
  for (const cp of level.checkpoints) {
    if (cp.index === 0) continue;
    const label0 = level.zones[cp.zone]?.label ?? '';
    const tex = bannerTexture(cp.index + 1, label0);
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    disposables.push(mat);
    for (const flip of [0, Math.PI]) {
      const banner = new THREE.Mesh(bannerGeo, mat);
      banner.rotation.y = cp.rotY + flip;
      // nudge each face along its own normal to avoid z-fighting
      banner.position.set(
        cp.pos.x + Math.sin(cp.rotY + flip) * 0.03,
        cp.pos.y + 2.7,
        cp.pos.z + Math.cos(cp.rotY + flip) * 0.03,
      );
      group.add(banner);
    }
    const ringMat = sharedMat(0x8a93a8, { emissive: 0x000000, roughness: 0.3, metalness: 0.4 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cp.pos.x, cp.pos.y - 0.02, cp.pos.z);
    group.add(ring);
    cpRings.set(cp.index, ringMat);
  }

  // ---- gadgets ----
  const kit: BuildKit = {
    group, world, R, levelGroups,
    mat: sharedMat,
    geo: sharedGeo,
    label,
    own: (d) => disposables.push(d),
    zones: level.zones,
  };
  const bridges = new Map<number, Bridge>();
  const movers: Mover[] = [];
  const seesaws = new Map<number, Seesaw>();
  const cranks = new Map<number, CrankLift>();
  const kinematics = new Map<number, Kinematic>();
  const climbables: Climbable[] = [];
  const plates: Plate[] = [];
  const levers: Lever[] = [];
  const ropes: Rope[] = [];
  const interactables: Interactable[] = [];
  let ropeId = 1000; // grapple ropes are created at runtime, after gadget ids

  // ---- touch-responsive props ----
  // These parts stay out of the merged mesh so each instance can animate on its
  // own. They carry no colliders, so nothing here changes how the level plays.
  const interactMats = new Map<number, THREE.MeshStandardMaterial>();
  for (const prop of level.props) {
    const def = ARCHETYPES[prop.archetype]?.interact;
    if (!def) continue;
    const rotQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, prop.rotY, 0));
    const pivot = new THREE.Vector3(...def.pivot).applyQuaternion(rotQ)
      .add(new THREE.Vector3(prop.pos.x, prop.pos.y, prop.pos.z));
    const ig = new THREE.Group();
    ig.name = `interact:${prop.archetype}`;
    ig.position.copy(pivot);
    ig.rotation.y = prop.rotY;
    for (const part of def.parts) {
      let mat = interactMats.get(part.color);
      if (!mat) {
        mat = METALS.has(part.color)
          ? sharedMat(part.color, { roughness: 0.34, metalness: 0.7 })
          : sharedMat(part.color, { roughness: 0.58 });
        interactMats.set(part.color, mat);
      }
      const geo = sharedGeo(makeGeo(part));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(part.pos[0], part.pos[1], part.pos[2]);
      mesh.rotation.set(part.rotX ?? 0, 0, part.rotZ ?? 0);
      mesh.castShadow = true;
      ig.add(mesh);
    }
    group.add(ig);
    // Far-field decor still needs the parts drawn (a duck with no head looks
    // broken), but only props on the path are close enough to ever be touched.
    if (prop.solid) interactables.push({ group: ig, def, pos: pivot.clone(), baseRotY: prop.rotY, startedAt: -1 });
  }

  const knotGeo = sharedGeo(new THREE.SphereGeometry(0.16, 10, 8));
  const postGeo = sharedGeo(new THREE.CylinderGeometry(0.16, 0.2, 0.5, 8));
  const railMat = sharedMat(0x8d6e63, { roughness: 0.75 });
  const rungMat = sharedMat(0xd9b38c, { roughness: 0.7 });
  const ropeMat = sharedMat(0xd8c08a, { roughness: 1 });
  const traverseMat = sharedMat(0xc9a86a, { roughness: 1 });
  const metalMat = sharedMat(0x9aa3b2, { roughness: 0.35, metalness: 0.6 });

  // pressure plates: a chunky arcade button in a dark housing
  const plateBaseGeo = sharedGeo(new THREE.CylinderGeometry(0.98, 1.05, 0.14, 24));
  const plateTopGeo = sharedGeo(new THREE.CylinderGeometry(0.78, 0.82, 0.14, 24));
  const plateBaseMat = sharedMat(0x3a3f4b, { roughness: 0.5, metalness: 0.3 });
  const addPlate = (gadgetId: number, plateIdx: number, pp: Vec3, kind: Plate['kind'], tag?: string) => {
    const base = new THREE.Mesh(plateBaseGeo, plateBaseMat);
    base.position.set(pp.x, pp.y + 0.05, pp.z);
    base.receiveShadow = true;
    group.add(base);
    const topMat = sharedMat(0xe0453a, { emissive: 0x7a1a12, emissiveIntensity: 0.6, roughness: 0.35 });
    const button = new THREE.Mesh(plateTopGeo, topMat);
    button.position.set(pp.x, pp.y + 0.14, pp.z);
    button.receiveShadow = true;
    group.add(button);
    if (tag) {
      const s = label(tag, { bg: '#ffc43d', fg: '#2d3038', scale: 0.75 });
      s.position.set(pp.x, pp.y + 1.9, pp.z);
      group.add(s);
    }
    plates.push({ gadgetId, plateIdx, pos: new THREE.Vector3(pp.x, pp.y, pp.z), button, kind });
  };

  const exitDirFrom = (from: Vec3, to: Vec3) => {
    const d = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
    return d.lengthSq() > 1e-6 ? d.normalize() : new THREE.Vector3(1, 0, 0);
  };

  /**
   * A vertical rope, simulated like the strung ones so it swings when you catch
   * it and sways with your weight while you climb. `exit` is where you're set
   * down at the top; grappling ropes without one fall back to a nudge inward.
   */
  const buildRope = (top: Vec3, length: number, exit?: Vec3, id = ropeId++) => {
    const rope = new Rope(id, 'hang', top, { x: top.x, y: top.y - length, z: top.z }, top.y, ropeMat);
    if (exit) {
      rope.exits = [new THREE.Vector3(exit.x, exit.y, exit.z)];
      rope.exitDir = exitDirFrom(top, exit);
    }
    group.add(rope.mesh);
    ropes.push(rope);
    const knot = new THREE.Mesh(knotGeo, ropeMat);
    knot.position.set(top.x, top.y, top.z);
    group.add(knot);
    return rope;
  };

  for (const g of level.gadgets) {
    if (g.kind === 'bridge') {
      const bridge = new Bridge(kit, g);
      bridges.set(g.id, bridge);
      const tags: Record<string, string | undefined> = {
        latch: undefined, hold: 'HOLD', duo: '2 CLIMBERS ON ME', twin: 'PRESS BOTH AT ONCE',
      };
      g.plates.forEach((pp, idx) => addPlate(g.id, idx, pp, 'bridge', g.mode === 'hold' ? (idx === 0 ? 'HOLD' : undefined) : tags[g.mode]));
    } else if (g.kind === 'ladder') {
      // Oversized ladder leaning from one platform's rim against the next prop:
      // chunky rails with feet and caps, thick rungs with grip bands.
      const base = new THREE.Vector3(g.base.x, g.base.y, g.base.z);
      const top = new THREE.Vector3(g.top.x, g.top.y, g.top.z);
      const heading = new THREE.Vector3(Math.cos(g.rotY), 0, Math.sin(g.rotY));
      const perp = new THREE.Vector3(-heading.z, 0, heading.x);
      const up = top.clone().sub(base);
      const len = up.length();
      up.normalize();
      const fwd = new THREE.Vector3().crossVectors(perp, up);
      const basis = new THREE.Matrix4().makeBasis(perp, up, fwd);
      const lq = new THREE.Quaternion().setFromRotationMatrix(basis);
      const HALFW = 0.95; // rail half-spacing
      const at = (side: number, d: number) => base.clone().addScaledVector(up, d).addScaledVector(perp, HALFW * side);
      const railGeo = sharedGeo(new THREE.BoxGeometry(0.3, len, 0.42));
      const capGeo = sharedGeo(new THREE.BoxGeometry(0.38, 0.26, 0.5));
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(railGeo, railMat);
        rail.position.copy(at(side, len / 2));
        rail.quaternion.copy(lq);
        rail.castShadow = true;
        group.add(rail);
        for (const d of [len + 0.1, 0.05]) {
          const end = new THREE.Mesh(capGeo, railMat);
          end.position.copy(at(side, d));
          end.quaternion.copy(lq);
          group.add(end);
        }
      }
      const rungGeo = sharedGeo(new THREE.CylinderGeometry(0.13, 0.13, HALFW * 2, 10));
      rungGeo.rotateZ(Math.PI / 2);
      const gripGeo = sharedGeo(new THREE.CylinderGeometry(0.155, 0.155, 0.1, 10));
      gripGeo.rotateZ(Math.PI / 2);
      for (let d = 0.5; d < len - 0.2; d += 0.62) {
        const rung = new THREE.Mesh(rungGeo, rungMat);
        rung.position.copy(at(0, d));
        rung.quaternion.copy(lq);
        rung.castShadow = true;
        group.add(rung);
        for (const off of [-0.32, 0.32]) {
          const grip = new THREE.Mesh(gripGeo, railMat);
          grip.position.copy(at(0, d)).addScaledVector(perp, off);
          grip.quaternion.copy(lq);
          group.add(grip);
        }
      }
      climbables.push({
        a: base,
        b: top,
        exitDir: heading.clone(),
        exit: new THREE.Vector3(g.exit.x, g.exit.y, g.exit.z),
      });
    } else if (g.kind === 'rope') {
      buildRope(g.top, g.length, g.exit, g.id);
      // the hook arm the rope hangs from, reaching out past the prop's edge
      const anchor = new THREE.Vector3(g.top.x, g.top.y, g.top.z);
      const inward = exitDirFrom(g.top, g.exit);
      const reach = Math.max(0.6, Math.hypot(g.exit.x - g.top.x, g.exit.z - g.top.z) * 0.75);
      const arm = new THREE.Mesh(sharedGeo(new THREE.BoxGeometry(reach, 0.16, 0.2)), metalMat);
      arm.position.copy(anchor).addScaledVector(inward, reach / 2);
      arm.position.y += 0.08;
      arm.rotation.y = -Math.atan2(inward.z, inward.x);
      arm.castShadow = true;
      group.add(arm);
      const post = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.09, 0.12, 0.62, 8)), metalMat);
      post.position.copy(anchor).addScaledVector(inward, reach - 0.08);
      post.position.y -= 0.2;
      group.add(post);
    } else if (g.kind === 'traverse') {
      const rope = new Rope(g.id, 'span', g.a, g.b, g.deckY, traverseMat);
      rope.exits = [new THREE.Vector3(g.exitA.x, g.exitA.y, g.exitA.z), new THREE.Vector3(g.exitB.x, g.exitB.y, g.exitB.z)];
      group.add(rope.mesh);
      ropes.push(rope);
      // anchor knots + a stubby post at each end so the rope reads as tied off
      for (const end of [g.a, g.b]) {
        const knot = new THREE.Mesh(knotGeo, traverseMat);
        knot.position.set(end.x, end.y, end.z);
        group.add(knot);
        const post = new THREE.Mesh(postGeo, railMat);
        post.position.set(end.x, (end.y + g.deckY) / 2, end.z);
        post.scale.y = Math.max(0.1, end.y - g.deckY) / 0.5;
        post.castShadow = true;
        group.add(post);
      }
    } else if (g.kind === 'mover') {
      const m = new Mover(kit, g);
      movers.push(m);
      kinematics.set(m.kin.collider.handle, m.kin);
    } else if (g.kind === 'seesaw') {
      const sw = new Seesaw(kit, g);
      seesaws.set(g.id, sw);
      kinematics.set(sw.kin.collider.handle, sw.kin);
      levers.push({ gadgetId: g.id, pos: new THREE.Vector3(g.lever.x, g.lever.y, g.lever.z) });
      // the lever stands on a plate-like pad
      const pad = new THREE.Mesh(plateBaseGeo, plateBaseMat);
      pad.position.set(g.lever.x, g.lever.y + 0.05, g.lever.z);
      group.add(pad);
    } else if (g.kind === 'cranklift') {
      const c = new CrankLift(kit, g);
      cranks.set(g.id, c);
      kinematics.set(c.kin.collider.handle, c.kin);
      g.plates.forEach((pp, idx) => addPlate(g.id, idx, pp, 'crank'));
    }
  }

  // ---- items ----
  // A glowing pedestal ring, a soft light beam you can spot from a distance and
  // the item itself bobbing above it.
  const items = new Map<number, ItemVisual>();
  const padRingGeo = sharedGeo(new THREE.TorusGeometry(0.62, 0.07, 8, 28));
  const beamGeo = sharedGeo(new THREE.CylinderGeometry(0.5, 0.65, 4, 16, 1, true));
  beamGeo.translate(0, 2, 0);
  const sparkleGeo = sharedGeo(new THREE.OctahedronGeometry(0.07));
  for (const it of level.items) {
    const tint = ITEM_COLORS[it.type];
    const ig = new THREE.Group();
    ig.position.set(it.pos.x, it.pos.y, it.pos.z);
    const glowMat = sharedMat(tint, { emissive: tint, emissiveIntensity: 1.4, roughness: 0.3 });
    const ring = new THREE.Mesh(padRingGeo, glowMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.62;
    ig.add(ring);
    const beamMat = new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    disposables.push(beamMat);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = -0.65;
    ig.add(beam);
    for (let k = 0; k < 4; k++) {
      const sp = new THREE.Mesh(sparkleGeo, glowMat);
      sp.userData.sparkle = k;
      ig.add(sp);
    }
    const model = new THREE.Group();
    model.name = 'model';
    if (it.type === 'doublejump') {
      const bootMat = sharedMat(0x69db7c, { roughness: 0.45 });
      const soleMat = sharedMat(0xffffff, { roughness: 0.5 });
      const wingMat = sharedMat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.3 });
      for (const side of [-1, 1]) {
        const boot = new THREE.Mesh(sharedGeo(new THREE.BoxGeometry(0.26, 0.34, 0.42)), bootMat);
        boot.position.set(side * 0.2, 0, 0.03);
        model.add(boot);
        const sole = new THREE.Mesh(sharedGeo(new THREE.BoxGeometry(0.3, 0.1, 0.5)), soleMat);
        sole.position.set(side * 0.2, -0.2, 0.06);
        model.add(sole);
        const wing = new THREE.Mesh(sharedGeo(new THREE.ConeGeometry(0.12, 0.34, 4)), wingMat);
        wing.position.set(side * 0.38, 0.08, -0.05);
        wing.rotation.z = side * -1.2;
        model.add(wing);
      }
    } else if (it.type === 'telescope') {
      const t1 = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.16, 0.16, 0.55, 14)), sharedMat(0x33558a, { roughness: 0.4 }));
      const t2 = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.12, 0.12, 0.4, 14)), sharedMat(0xd4af37, { metalness: 0.6, roughness: 0.3 }));
      const lens = new THREE.Mesh(sharedGeo(new THREE.CircleGeometry(0.15, 16)), sharedMat(0xbfe3ef, { emissive: 0x88ccff, emissiveIntensity: 0.8 }));
      t1.rotation.z = Math.PI / 2.6;
      t2.rotation.z = Math.PI / 2.6;
      t2.position.set(0.28, 0.18, 0);
      lens.position.set(-0.24, -0.11, 0);
      lens.rotation.y = -Math.PI / 2;
      lens.rotation.x = Math.PI / 2.6;
      model.add(t1, t2, lens);
    } else {
      const hook = new THREE.Mesh(sharedGeo(new THREE.TorusGeometry(0.26, 0.07, 8, 16, Math.PI * 1.5)), sharedMat(0x9aa3b2, { metalness: 0.7, roughness: 0.3 }));
      hook.position.y = 0.16;
      const handle = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 10)), sharedMat(0xe05d5d));
      handle.position.y = -0.2;
      const coil = new THREE.Mesh(sharedGeo(new THREE.TorusGeometry(0.16, 0.05, 6, 14)), ropeMat);
      coil.position.set(0, -0.2, 0.1);
      model.add(hook, handle, coil);
    }
    ig.add(model);
    group.add(ig);
    items.set(it.id, { id: it.id, type: it.type, group: ig, basePos: ig.position.clone(), taken: false });
  }

  // ---- flag ----
  const flagGroup = new THREE.Group();
  flagGroup.position.set(level.flagPos.x, level.flagPos.y, level.flagPos.z);
  const pole = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.1, 0.13, 5.6, 12)), sharedMat(0xd8dbe2, { metalness: 0.6, roughness: 0.3 }));
  pole.position.y = 2.8;
  pole.castShadow = true;
  flagGroup.add(pole);
  const star = new THREE.Mesh(sharedGeo(new THREE.IcosahedronGeometry(0.26, 1)), sharedMat(0xffe066, { emissive: 0xffd24d, emissiveIntensity: 2 }));
  star.position.y = 5.75;
  flagGroup.add(star);
  const flagCanvas = document.createElement('canvas');
  flagCanvas.width = 512;
  flagCanvas.height = 320;
  {
    const c = flagCanvas.getContext('2d')!;
    c.fillStyle = '#e04f4f';
    c.fillRect(0, 0, 512, 320);
    c.fillStyle = '#c63c3c';
    for (let i = 0; i < 8; i++) c.fillRect(i * 64, 0, 32, 320);
    c.fillStyle = '#fff6d6';
    c.font = '800 92px "Fredoka", "Nunito", system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('ONLY US', 256, 170);
  }
  const flagTex = new THREE.CanvasTexture(flagCanvas);
  flagTex.colorSpace = THREE.SRGBColorSpace;
  texCache.push(flagTex);
  const flagGeo = new THREE.PlaneGeometry(2.8, 1.75, 16, 6);
  disposables.push(flagGeo);
  const flagMesh = new THREE.Mesh(flagGeo, sharedMat(0xffffff, { map: flagTex, side: THREE.DoubleSide, roughness: 0.8 }));
  flagMesh.position.set(1.45, 4.6, 0);
  flagMesh.castShadow = true;
  flagGroup.add(flagMesh);
  // beacon visible from below
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.14, depthWrite: false, blending: THREE.AdditiveBlending });
  disposables.push(beaconMat);
  const beacon = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.7, 2.0, 320, 16, 1, true)), beaconMat);
  beacon.position.y = -156;
  flagGroup.add(beacon);
  group.add(flagGroup);
  const flagBase = flagGeo.attributes.position.array.slice() as unknown as Float32Array;

  const flagAnimate = (t: number) => {
    const posAttr = flagGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const x = flagBase[i * 3] + 1.4;
      posAttr.setZ(i, Math.sin(x * 2.4 - t * 5) * 0.14 * x);
    }
    posAttr.needsUpdate = true;
    flagGeo.computeVertexNormals();
    star.rotation.y = t * 1.5;
  };

  const easeOut = (u: number) => 1 - (1 - u) * (1 - u);

  const animateInteractables = (t: number) => {
    for (const it of interactables) {
      if (it.startedAt < 0) continue;
      const u = (t - it.startedAt) / it.def.duration;
      const g = it.group;
      if (u >= 1) {
        it.startedAt = -1;
        g.rotation.set(0, it.baseRotY, 0);
        g.position.y = it.pos.y;
        continue;
      }
      const decay = 1 - u;
      switch (it.def.kind) {
        case 'spin':
          g.rotation.y = it.baseRotY + easeOut(u) * Math.PI * 6;
          break;
        case 'spinz':
          g.rotation.z = easeOut(u) * Math.PI * 8;
          break;
        case 'swing':
          g.rotation.z = Math.sin(u * Math.PI * 7) * 0.45 * decay;
          break;
        case 'bob':
          g.position.y = it.pos.y + Math.abs(Math.sin(u * Math.PI * 3)) * 0.5 * decay;
          break;
        case 'pop':
          g.position.y = it.pos.y + Math.sin(u * Math.PI) * 1.4;
          g.rotation.z = Math.sin(u * Math.PI * 2) * 0.3;
          break;
      }
    }
  };

  const setGadgetState = (id: number, state: GadgetState) => {
    const bridge = bridges.get(id);
    if (bridge) bridge.state = state;
    const crank = cranks.get(id);
    if (crank) crank.state = state;
    for (const plate of plates) {
      if (plate.gadgetId !== id) continue;
      const pressed = (state.plates[plate.plateIdx] ?? 0) > 0;
      plate.button.position.y = plate.pos.y + (pressed ? 0.07 : 0.14);
      const mat = plate.button.material as THREE.MeshStandardMaterial;
      const on = state.active || pressed;
      mat.color.setHex(on ? 0x3ec46d : 0xe0453a);
      mat.emissive.setHex(on ? 0x1b6b36 : 0x7a1a12);
    }
  };

  const setCheckpointReached = (index: number) => {
    const m = cpRings.get(index);
    if (!m) return;
    m.color.setHex(0x69db7c);
    m.emissive.setHex(0x2fae55);
    m.emissiveIntensity = 1.3;
  };

  const stepGadgets = (dt: number, clock: number) => {
    for (const b of bridges.values()) b.step(dt);
    for (const m of movers) m.step(clock);
    for (const s of seesaws.values()) s.step(clock);
    for (const c of cranks.values()) c.step(dt);
  };

  const stepRopes = (dt: number, gravityScale: number) => {
    for (const r of ropes) r.step(dt, gravityScale);
  };

  const syncGadgets = (t: number, clock: number) => {
    for (const b of bridges.values()) b.syncVisual(t);
    for (const m of movers) m.syncVisual();
    for (const s of seesaws.values()) s.syncVisual(clock);
    for (const c of cranks.values()) c.syncVisual(t);
  };

  const updateVisuals = (t: number) => {
    for (const r of ropes) r.updateGeometry();
    animateInteractables(t);
    for (const it of items.values()) {
      if (it.taken) continue;
      const model = it.group.getObjectByName('model');
      if (model) {
        model.rotation.y = t * 1.4;
        model.position.y = Math.sin(t * 2.2 + it.id) * 0.12;
      }
      for (const child of it.group.children) {
        const k = child.userData.sparkle as number | undefined;
        if (k === undefined) continue;
        const a = t * 1.3 + k * (Math.PI / 2);
        child.position.set(Math.cos(a) * 0.55, Math.sin(t * 2 + k) * 0.25, Math.sin(a) * 0.55);
        child.rotation.y = t * 3;
      }
    }
    flagAnimate(t);
  };

  const dispose = () => {
    for (const r of ropes) r.dispose();
    scene.remove(group);
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const d of disposables) d.dispose();
    for (const tex of texCache.splice(0)) tex.dispose();
  };

  return {
    group,
    bridges,
    movers,
    seesaws,
    cranks,
    kinematics,
    climbables,
    ropes,
    interactables,
    plates,
    levers,
    items,
    addRope: (top, length, exit) => { buildRope(top, length, exit); },
    setGadgetState,
    setCheckpointReached,
    stepGadgets,
    stepRopes,
    syncGadgets,
    updateVisuals,
    dispose,
  };
}

/** Theme metadata by id, for the client's scenery. */
export function themeOf(id: string) {
  return THEMES.find((t) => t.id === id);
}
