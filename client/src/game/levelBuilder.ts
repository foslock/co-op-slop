import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ARCHETYPES, type GadgetState, type ItemType, type LevelData, type Vec3 } from 'shared';
import { GROUP_LEVEL, groups } from './physics';

export interface Climbable {
  a: THREE.Vector3; // bottom
  b: THREE.Vector3; // top
  exitDir: THREE.Vector3 | null; // horizontal push when topping out
}

export interface Plate {
  gadgetId: number;
  plateIdx: number;
  pos: THREE.Vector3;
  mesh: THREE.Mesh;
  needsTwo: boolean;
}

export interface ItemVisual {
  id: number;
  type: ItemType;
  group: THREE.Group;
  basePos: THREE.Vector3;
  taken: boolean;
}

const EXTEND_DROP = 7;
const EXTEND_TIME = 1.6;

export class Bridge {
  id: number;
  mode: string;
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  baseY: number;
  ext = 0;
  frameDeltaY = 0;
  state: GadgetState | null = null;

  constructor(id: number, mode: string, body: RAPIER.RigidBody, mesh: THREE.Mesh, baseY: number) {
    this.id = id;
    this.mode = mode;
    this.body = body;
    this.mesh = mesh;
    this.baseY = baseY;
  }

  /** Advance the extension animation; call once per fixed physics step. */
  step(dt: number) {
    const target = this.state?.active ? 1 : 0;
    const prevY = this.baseY - (1 - this.ext) * EXTEND_DROP;
    this.ext = THREE.MathUtils.clamp(this.ext + (target > this.ext ? 1 : -1) * (dt / EXTEND_TIME), 0, 1);
    const newY = this.baseY - (1 - this.ext) * EXTEND_DROP;
    this.frameDeltaY = newY - prevY;
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x, y: newY, z: t.z });
  }

  syncMesh() {
    const t = this.body.translation();
    this.mesh.position.set(t.x, t.y, t.z);
  }
}

export interface LevelHandles {
  group: THREE.Group;
  bridges: Map<number, Bridge>;
  bridgeByCollider: Map<number, Bridge>;
  climbables: Climbable[];
  plates: Plate[];
  items: Map<number, ItemVisual>;
  flagAnimate: (t: number) => void;
  addRope(top: Vec3, length: number): void;
  updateVisuals(t: number): void;
  dispose(): void;
}

const texCache: THREE.CanvasTexture[] = [];

function bannerTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#26315c';
  c.fillRect(0, 0, 512, 128);
  c.strokeStyle = '#ffd24d';
  c.lineWidth = 10;
  c.strokeRect(8, 8, 496, 112);
  c.font = 'bold 56px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#ffd24d';
  c.fillText(text.toUpperCase(), 256, 68);
  const tex = new THREE.CanvasTexture(canvas);
  texCache.push(tex);
  return tex;
}

export function buildLevel(
  scene: THREE.Scene,
  world: RAPIER.World,
  R: typeof RAPIER,
  level: LevelData,
): LevelHandles {
  const group = new THREE.Group();
  scene.add(group);
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const levelGroups = groups(GROUP_LEVEL, 0xffff);
  const staticBody = world.createRigidBody(R.RigidBodyDesc.fixed());

  // ---- merge all prop geometry into one mesh per color ----
  const buckets = new Map<number, THREE.BufferGeometry[]>();
  const pm = new THREE.Matrix4();
  const im = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();

  for (const prop of level.props) {
    const arch = ARCHETYPES[prop.archetype];
    if (!arch) continue;
    im.compose(
      new THREE.Vector3(prop.pos.x, prop.pos.y, prop.pos.z),
      q.setFromEuler(e.set(0, prop.rotY, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    for (const part of arch.parts) {
      let g: THREE.BufferGeometry;
      const [a, b, c] = part.size;
      switch (part.shape) {
        case 'box': g = new THREE.BoxGeometry(a, b, c); break;
        case 'cyl': g = new THREE.CylinderGeometry(a, c || a, b, 14); break;
        case 'sphere': g = new THREE.SphereGeometry(1, 14, 10); g.scale(a, b, c); break;
        case 'torus': g = new THREE.TorusGeometry(a, b, 8, 18, (c || 1) * Math.PI * 2); break;
      }
      pm.compose(
        new THREE.Vector3(part.pos[0], part.pos[1], part.pos[2]),
        q.setFromEuler(e.set(part.rotX ?? 0, 0, part.rotZ ?? 0)),
        new THREE.Vector3(1, 1, 1),
      );
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(im, pm));
      const list = buckets.get(part.color) ?? [];
      list.push(g);
      buckets.set(part.color, list);
    }
    // colliders for anything on or near the path
    if (prop.solid) {
      const rotQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, prop.rotY, 0));
      for (const col of arch.colliders) {
        const local = new THREE.Vector3(col.pos[0], col.pos[1], col.pos[2]).applyQuaternion(rotQ);
        const desc = (col.shape === 'box'
          ? R.ColliderDesc.cuboid(col.size[0] / 2, col.size[1] / 2, col.size[2] / 2)
          : R.ColliderDesc.cylinder(col.size[1] / 2, col.size[0]))
          .setTranslation(prop.pos.x + local.x, prop.pos.y + local.y, prop.pos.z + local.z)
          .setRotation({ x: rotQ.x, y: rotQ.y, z: rotQ.z, w: rotQ.w })
          .setCollisionGroups(levelGroups)
          .setFriction(0.9);
        world.createCollider(desc, staticBody);
      }
    }
  }

  for (const [color, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.82 });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(merged, mat);
  }

  const sharedMat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...opts });
    disposables.push(m);
    return m;
  };
  const sharedGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposables.push(g);
    return g;
  };

  // ---- checkpoint banners ----
  // The pad prop (pillars + crossbar) is rotated by cp.rotY in the generator; the
  // banner uses the same rotation so it hangs between the pillars, just under the
  // crossbar. Two front-facing planes back to back keep the text readable from
  // both sides without mirroring.
  const bannerGeo = sharedGeo(new THREE.PlaneGeometry(4.0, 1.0));
  for (const cp of level.checkpoints) {
    if (cp.index === 0) continue;
    const label = level.zones[cp.zone]?.label ?? '';
    const tex = bannerTexture(label);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
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
  }

  // ---- gadgets ----
  const bridges = new Map<number, Bridge>();
  const bridgeByCollider = new Map<number, Bridge>();
  const climbables: Climbable[] = [];
  const plates: Plate[] = [];

  const plateGeo = sharedGeo(new THREE.CylinderGeometry(0.85, 0.95, 0.16, 16));
  const plateMatOff = sharedMat(0xc0392b, { emissive: 0x731f14, emissiveIntensity: 0.5 });
  const slabMat = sharedMat(0xe8b54a, { roughness: 0.6 });
  const railMat = sharedMat(0x8d6e63);
  const rungMat = sharedMat(0xbf9670);
  const ropeMat = sharedMat(0xc9a86a, { roughness: 1 });

  const findExitDir = (anchor: Vec3): THREE.Vector3 | null => {
    // point toward the nearest path node at roughly the anchor's height
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (const n of level.nodes) {
      if (Math.abs(n.y - anchor.y) > 3) continue;
      const d = (n.x - anchor.x) ** 2 + (n.z - anchor.z) ** 2;
      if (d > 0.01 && d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (!best) return null;
    return new THREE.Vector3(best.x - anchor.x, 0, best.z - anchor.z).normalize();
  };

  const buildRope = (top: Vec3, length: number) => {
    const ropeGroup = new THREE.Group();
    ropeGroup.position.set(top.x, top.y, top.z);
    const line = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.05, 0.05, length, 6)), ropeMat);
    line.position.y = -length / 2;
    ropeGroup.add(line);
    const knotGeo = sharedGeo(new THREE.SphereGeometry(0.1, 8, 6));
    for (let y = 0.8; y < length; y += 1.2) {
      const knot = new THREE.Mesh(knotGeo, ropeMat);
      knot.position.y = -y;
      ropeGroup.add(knot);
    }
    group.add(ropeGroup);
    climbables.push({
      a: new THREE.Vector3(top.x, top.y - length, top.z),
      b: new THREE.Vector3(top.x, top.y, top.z),
      exitDir: findExitDir(top),
    });
  };

  for (const g of level.gadgets) {
    if (g.kind === 'bridge') {
      const dir = new THREE.Vector3(Math.cos(g.rotY), 0, Math.sin(g.rotY));
      const center = new THREE.Vector3(g.near.x, g.near.y, g.near.z).addScaledVector(dir, g.length / 2);
      const slabGeo = new THREE.BoxGeometry(g.length, 0.4, 1.9);
      disposables.push(slabGeo);
      const mesh = new THREE.Mesh(slabGeo, slabMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.rotation.y = -g.rotY;
      group.add(mesh);
      const startY = g.near.y - 0.2 - EXTEND_DROP;
      const body = world.createRigidBody(
        R.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(center.x, startY, center.z)
          .setRotation({ x: 0, y: Math.sin(-g.rotY / 2), z: 0, w: Math.cos(-g.rotY / 2) }),
      );
      const col = world.createCollider(
        R.ColliderDesc.cuboid(g.length / 2, 0.2, 0.95).setCollisionGroups(levelGroups).setFriction(0.9),
        body,
      );
      const bridge = new Bridge(g.id, g.mode, body, mesh, g.near.y - 0.2);
      mesh.position.set(center.x, startY, center.z);
      bridges.set(g.id, bridge);
      bridgeByCollider.set(col.handle, bridge);

      g.plates.forEach((pp, idx) => {
        const mesh = new THREE.Mesh(plateGeo, plateMatOff.clone());
        disposables.push(mesh.material as THREE.Material);
        mesh.position.set(pp.x, pp.y + 0.08, pp.z);
        mesh.receiveShadow = true;
        group.add(mesh);
        const needsTwo = g.mode === 'duo' && idx === 0;
        if (needsTwo) {
          const tex = bannerTexture('2 players!');
          const sm = new THREE.SpriteMaterial({ map: tex, depthTest: false });
          disposables.push(sm);
          const sprite = new THREE.Sprite(sm);
          sprite.scale.set(2.4, 0.6, 1);
          sprite.position.set(pp.x, pp.y + 1.6, pp.z);
          group.add(sprite);
        }
        plates.push({ gadgetId: g.id, plateIdx: idx, pos: new THREE.Vector3(pp.x, pp.y, pp.z), mesh, needsTwo });
      });
    } else if (g.kind === 'ladder') {
      const dir = new THREE.Vector3(Math.cos(g.rotY), 0, Math.sin(g.rotY));
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      const railGeo = sharedGeo(new THREE.BoxGeometry(0.12, g.height, 0.12));
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(railGeo, railMat);
        rail.position.set(g.base.x + perp.x * 0.45 * side, g.base.y + g.height / 2, g.base.z + perp.z * 0.45 * side);
        rail.castShadow = true;
        group.add(rail);
      }
      const rungGeo = sharedGeo(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8));
      for (let y = 0.4; y < g.height; y += 0.55) {
        const rung = new THREE.Mesh(rungGeo, rungMat);
        rung.position.set(g.base.x, g.base.y + y, g.base.z);
        rung.rotation.z = Math.PI / 2;
        rung.rotation.y = -g.rotY - Math.PI / 2;
        group.add(rung);
      }
      climbables.push({
        a: new THREE.Vector3(g.base.x, g.base.y, g.base.z),
        b: new THREE.Vector3(g.base.x, g.base.y + g.height, g.base.z),
        exitDir: dir.clone(),
      });
    } else if (g.kind === 'rope') {
      buildRope(g.top, g.length);
    }
  }

  // ---- items ----
  const items = new Map<number, ItemVisual>();
  const ringGeo = sharedGeo(new THREE.TorusGeometry(0.75, 0.06, 8, 24));
  const ringMat = sharedMat(0xffe066, { emissive: 0xffd24d, emissiveIntensity: 1.2 });
  for (const it of level.items) {
    const ig = new THREE.Group();
    ig.position.set(it.pos.x, it.pos.y, it.pos.z);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.35;
    ig.add(ring);
    if (it.type === 'doublejump') {
      const bootMat = sharedMat(0x69db7c);
      for (const side of [-1, 1]) {
        const boot = new THREE.Mesh(sharedGeo(new THREE.BoxGeometry(0.26, 0.34, 0.42)), bootMat);
        boot.position.set(side * 0.2, 0, 0.03);
        ig.add(boot);
        const sole = new THREE.Mesh(sharedGeo(new THREE.BoxGeometry(0.3, 0.1, 0.5)), sharedMat(0xffffff));
        sole.position.set(side * 0.2, -0.2, 0.06);
        ig.add(sole);
      }
    } else if (it.type === 'telescope') {
      const t1 = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.16, 0.16, 0.55, 12)), sharedMat(0x33558a));
      const t2 = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.12, 0.12, 0.4, 12)), sharedMat(0xd4af37, { metalness: 0.5, roughness: 0.4 }));
      t1.rotation.z = Math.PI / 2.6;
      t2.rotation.z = Math.PI / 2.6;
      t2.position.set(0.28, 0.18, 0);
      ig.add(t1, t2);
    } else {
      const hook = new THREE.Mesh(sharedGeo(new THREE.TorusGeometry(0.26, 0.07, 8, 16, Math.PI * 1.5)), sharedMat(0x9aa3b2, { metalness: 0.6, roughness: 0.35 }));
      hook.position.y = 0.16;
      const handle = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 10)), sharedMat(0xe05d5d));
      handle.position.y = -0.2;
      ig.add(hook, handle);
    }
    group.add(ig);
    items.set(it.id, { id: it.id, type: it.type, group: ig, basePos: ig.position.clone(), taken: false });
  }

  // ---- flag ----
  const flagGroup = new THREE.Group();
  flagGroup.position.set(level.flagPos.x, level.flagPos.y, level.flagPos.z);
  const pole = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.08, 0.1, 4.4, 10)), sharedMat(0xd8dbe2, { metalness: 0.4, roughness: 0.4 }));
  pole.position.y = 2.2;
  pole.castShadow = true;
  flagGroup.add(pole);
  const star = new THREE.Mesh(sharedGeo(new THREE.SphereGeometry(0.16, 10, 8)), sharedMat(0xffe066, { emissive: 0xffd24d, emissiveIntensity: 1.5 }));
  star.position.y = 4.5;
  flagGroup.add(star);
  const flagGeo = new THREE.PlaneGeometry(2.0, 1.2, 10, 4);
  disposables.push(flagGeo);
  const flagMesh = new THREE.Mesh(flagGeo, sharedMat(0xe05d5d, { side: THREE.DoubleSide }));
  flagMesh.position.set(1.05, 3.7, 0);
  flagGroup.add(flagMesh);
  // beacon visible from below
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.16, depthWrite: false });
  disposables.push(beaconMat);
  const beacon = new THREE.Mesh(sharedGeo(new THREE.CylinderGeometry(0.7, 1.6, 260, 12, 1, true)), beaconMat);
  beacon.position.y = -126;
  flagGroup.add(beacon);
  group.add(flagGroup);
  const flagBase = flagGeo.attributes.position.array.slice() as unknown as Float32Array;

  const flagAnimate = (t: number) => {
    const posAttr = flagGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const x = flagBase[i * 3];
      posAttr.setZ(i, Math.sin(x * 2.6 + t * 5) * 0.1 * (x + 1.0));
    }
    posAttr.needsUpdate = true;
    flagGeo.computeVertexNormals();
  };

  const updateVisuals = (t: number) => {
    for (const it of items.values()) {
      if (it.taken) continue;
      it.group.rotation.y = t * 1.4;
      it.group.position.y = it.basePos.y + Math.sin(t * 2.2 + it.id) * 0.12;
    }
    flagAnimate(t);
  };

  const dispose = () => {
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
    bridgeByCollider,
    climbables,
    plates,
    items,
    flagAnimate,
    addRope: buildRope,
    updateVisuals,
    dispose,
  };
}
