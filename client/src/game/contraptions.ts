import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  BRIDGE, CRANK, MOVE, SEESAW, ballisticVelocity, gravityScaleAtY, moverPose, seesawPoint,
  type GadgetData, type GadgetState, type Pose, type ZoneData,
} from 'shared';
import { Kinematic, headingQuat } from './kinematic';

type BridgeData = Extract<GadgetData, { kind: 'bridge' }>;
type MoverData = Extract<GadgetData, { kind: 'mover' }>;
type SeesawData = Extract<GadgetData, { kind: 'seesaw' }>;
type CrankData = Extract<GadgetData, { kind: 'cranklift' }>;

/** Shared building blocks handed over by the level builder. */
export interface BuildKit {
  group: THREE.Group;
  world: RAPIER.World;
  R: typeof RAPIER;
  levelGroups: number;
  mat: (color: number, opts?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial;
  geo: <T extends THREE.BufferGeometry>(g: T) => T;
  label: (text: string, opts?: { bg?: string; fg?: string; scale?: number }) => THREE.Sprite;
  own: (d: { dispose(): void }) => void; // anything else that needs disposing with the level
  zones: ZoneData[];
}

const HAZARD_Y = 0xffc43d;
const HAZARD_K = 0x2d3038;
const UP = new THREE.Vector3(0, 1, 0);

const easeOutBack = (u: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
};
const smooth = (u: number) => u * u * (3 - 2 * u);

function mesh(kit: BuildKit, g: THREE.BufferGeometry, m: THREE.Material, shadow = true): THREE.Mesh {
  const out = new THREE.Mesh(g, m);
  out.castShadow = shadow;
  out.receiveShadow = true;
  return out;
}

/** A row of alternating hazard-stripe blocks along a deck edge, as one merged-ish group. */
function hazardEdge(kit: BuildKit, parent: THREE.Object3D, length: number, z: number, y: number, h = 0.16) {
  const n = Math.max(2, Math.round(length / 0.55));
  const w = length / n;
  const g = kit.geo(new THREE.BoxGeometry(w * 0.98, h, 0.08));
  const my = kit.mat(HAZARD_Y, { roughness: 0.5 });
  const mk = kit.mat(HAZARD_K, { roughness: 0.6 });
  for (let i = 0; i < n; i++) {
    const b = new THREE.Mesh(g, i % 2 ? mk : my);
    b.position.set(-length / 2 + w * (i + 0.5), y, z);
    parent.add(b);
  }
}

// ---------------------------------------------------------------- bridges

/**
 * A bridge that lays itself across the gap plank by plank when its plates are
 * pressed, and pulls the planks back from the far end when it retracts. The
 * collider grows and shrinks with the laid planks, so a retracting bridge
 * really does drop whoever is standing on the missing part.
 */
export class Bridge {
  id: number;
  mode: BridgeData['mode'];
  state: GadgetState | null = null;
  ext = 0;
  private g: BridgeData;
  private collider: RAPIER.Collider;
  private planks: THREE.Object3D[] = [];
  private n: number;
  private plankLen: number;
  private root = new THREE.Group();
  private rails: THREE.Mesh[] = [];
  private builtLen = -1;

  constructor(kit: BuildKit, g: BridgeData) {
    this.g = g;
    this.id = g.id;
    this.mode = g.mode;
    this.n = Math.max(3, Math.ceil(g.length / BRIDGE.plankLength));
    this.plankLen = g.length / this.n;
    this.root.position.set(g.near.x, g.near.y, g.near.z);
    this.root.rotation.y = -g.rotY;
    kit.group.add(this.root);

    const woodA = kit.mat(0xc98f55, { roughness: 0.75 });
    const woodB = kit.mat(0xb07a45, { roughness: 0.8 });
    const nail = kit.mat(0x5c6370, { roughness: 0.4, metalness: 0.5 });
    const plankGeo = kit.geo(new THREE.BoxGeometry(this.plankLen * 0.92, 0.26, BRIDGE.width));
    const nailGeo = kit.geo(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 6));
    for (let i = 0; i < this.n; i++) {
      // each plank hinges at its near edge so it can flip down into place
      const hinge = new THREE.Group();
      hinge.position.set(i * this.plankLen, -0.02, 0);
      const p = mesh(kit, plankGeo, i % 2 ? woodB : woodA);
      p.position.set(this.plankLen / 2, -0.13, 0);
      p.rotation.y = (((i * 7919) % 13) / 13 - 0.5) * 0.04; // a little hand-laid wobble
      hinge.add(p);
      for (const z of [-BRIDGE.width * 0.38, BRIDGE.width * 0.38]) {
        const nl = new THREE.Mesh(nailGeo, nail);
        nl.position.set(this.plankLen / 2, 0.0, z);
        hinge.add(nl);
      }
      hinge.visible = false;
      this.root.add(hinge);
      this.planks.push(hinge);
    }
    // posts at both ends with rope rails strung between them once the bridge is out
    const postGeo = kit.geo(new THREE.CylinderGeometry(0.11, 0.14, 1.1, 8));
    const capGeo = kit.geo(new THREE.SphereGeometry(0.16, 10, 8));
    const postMat = kit.mat(0x6d4c41, { roughness: 0.8 });
    const brass = kit.mat(0xd4af37, { roughness: 0.35, metalness: 0.6 });
    for (const x of [0, g.length]) {
      for (const z of [-BRIDGE.width / 2 - 0.05, BRIDGE.width / 2 + 0.05]) {
        const post = mesh(kit, postGeo, postMat);
        post.position.set(x, 0.5, z);
        this.root.add(post);
        const cap = new THREE.Mesh(capGeo, brass);
        cap.position.set(x, 1.08, z);
        this.root.add(cap);
      }
    }
    const railGeo = kit.geo(new THREE.CylinderGeometry(0.035, 0.035, 1, 6));
    railGeo.rotateZ(Math.PI / 2);
    railGeo.translate(0.5, 0, 0);
    const ropeMat = kit.mat(0xd8c08a, { roughness: 1 });
    for (const z of [-BRIDGE.width / 2 - 0.05, BRIDGE.width / 2 + 0.05]) {
      const rail = new THREE.Mesh(railGeo, ropeMat);
      rail.position.set(0, 0.92, z);
      rail.visible = false;
      this.root.add(rail);
      this.rails.push(rail);
    }

    const q = headingQuat(g.rotY);
    this.collider = kit.world.createCollider(
      kit.R.ColliderDesc.cuboid(g.length / 2, BRIDGE.thickness / 2, BRIDGE.width / 2)
        .setTranslation(g.near.x, g.near.y - BRIDGE.thickness / 2, g.near.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCollisionGroups(kit.levelGroups)
        .setFriction(0.9)
        .setEnabled(false),
    );
  }

  /** Advance the build animation; call once per fixed physics step. */
  step(dt: number) {
    const target = this.state?.active ? 1 : 0;
    const maxStep = dt / BRIDGE.buildTime;
    this.ext = THREE.MathUtils.clamp(this.ext + THREE.MathUtils.clamp(target - this.ext, -maxStep, maxStep), 0, 1);
    // only fully laid planks carry weight
    const laid = Math.min(this.n, Math.floor(this.ext * this.n + 1e-6));
    const len = laid === this.n ? this.g.length : laid * this.plankLen;
    if (len === this.builtLen) return;
    this.builtLen = len;
    if (len < 0.3) {
      this.collider.setEnabled(false);
      return;
    }
    const c = Math.cos(this.g.rotY);
    const s = Math.sin(this.g.rotY);
    this.collider.setHalfExtents({ x: len / 2, y: BRIDGE.thickness / 2, z: BRIDGE.width / 2 });
    this.collider.setTranslation({ x: this.g.near.x + c * len / 2, y: this.g.near.y - BRIDGE.thickness / 2, z: this.g.near.z + s * len / 2 });
    this.collider.setEnabled(true);
  }

  /** Is a hold-mode bridge about to retract (pressed by nobody, grace period running)? */
  private warning(): boolean {
    if (this.mode !== 'hold' || !this.state?.active) return false;
    return this.state.plates.every((n) => !n);
  }

  syncVisual(t: number) {
    const f = this.ext * this.n;
    const shake = this.warning() ? Math.sin(t * 40) * 0.035 : 0;
    for (let i = 0; i < this.n; i++) {
      const u = THREE.MathUtils.clamp(f - i, 0, 1);
      const hinge = this.planks[i];
      hinge.visible = u > 0.001;
      if (!hinge.visible) continue;
      // flip down from hanging under the previous plank to flat, with a bounce
      hinge.rotation.z = -(1 - easeOutBack(u)) * Math.PI * 0.5 + (u >= 1 ? shake * Math.sin(i * 1.7) : 0);
      hinge.position.y = -0.02 + (u >= 1 ? shake * 0.5 : 0);
    }
    const full = this.ext >= 0.999;
    for (const rail of this.rails) {
      rail.visible = this.ext > 0.05;
      rail.scale.x = this.g.length * smooth(this.ext);
      rail.position.y = full ? 0.92 : 0.92 - (1 - this.ext) * 0.3;
    }
  }
}

// ---------------------------------------------------------------- moving platforms

/** A deck that runs on the shared game clock: shuttle, lift or spinner. */
export class Mover {
  g: MoverData;
  kin: Kinematic;
  private root = new THREE.Group();
  private pose: Pose = { x: 0, y: 0, z: 0, rotY: 0 };
  private tmpP = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(kit: BuildKit, g: MoverData) {
    this.g = g;
    const [L, T, W] = g.size;
    kit.group.add(this.root);

    if (g.motion === 'spinner') this.buildSpinner(kit);
    else this.buildDeck(kit);
    if (g.motion === 'shuttle') this.buildTrack(kit);
    if (g.motion === 'lift') this.buildShaft(kit);

    moverPose(g, 0, this.pose);
    const p = new THREE.Vector3(this.pose.x, this.pose.y - T / 2, this.pose.z);
    const q = headingQuat(this.pose.rotY);
    const col = kit.world.createCollider(
      kit.R.ColliderDesc.cuboid(L / 2, T / 2, W / 2)
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCollisionGroups(kit.levelGroups)
        .setFriction(1.0),
    );
    this.kin = new Kinematic(col, p, q);
    this.syncVisual();
  }

  private buildDeck(kit: BuildKit) {
    const [L, T, W] = this.g.size;
    const top = mesh(kit, kit.geo(new THREE.BoxGeometry(L, T, W)), kit.mat(0xe9edf2, { roughness: 0.55 }));
    this.root.add(top);
    const inset = mesh(kit, kit.geo(new THREE.BoxGeometry(L - 0.3, 0.04, W - 0.3)), kit.mat(0x8fd3ff, { roughness: 0.4 }), false);
    inset.position.y = T / 2 + 0.01;
    this.root.add(inset);
    hazardEdge(kit, this.root, L, W / 2 + 0.03, 0, T * 0.7);
    hazardEdge(kit, this.root, L, -W / 2 - 0.03, 0, T * 0.7);
    // underside thruster pods: reads as "this thing moves" from far away
    const podGeo = kit.geo(new THREE.CylinderGeometry(0.22, 0.3, 0.3, 10));
    const glowMat = kit.mat(0x7fdcff, { emissive: 0x3fb6ff, emissiveIntensity: 1.6, roughness: 0.3 });
    const podMat = kit.mat(0x5c6370, { roughness: 0.4, metalness: 0.5 });
    for (const x of [-L / 3, L / 3]) {
      for (const z of [-W / 3, W / 3]) {
        const pod = new THREE.Mesh(podGeo, podMat);
        pod.position.set(x, -T / 2 - 0.15, z);
        this.root.add(pod);
        const glow = new THREE.Mesh(kit.geo(new THREE.CircleGeometry(0.2, 12)), glowMat);
        glow.rotation.x = Math.PI / 2;
        glow.position.set(x, -T / 2 - 0.31, z);
        this.root.add(glow);
      }
    }
  }

  private buildSpinner(kit: BuildKit) {
    const [L, T, W] = this.g.size;
    // candy-striped beam with a flat top; the hub hangs underneath so nothing
    // sticks up for you to trip over while running across
    const n = Math.max(4, Math.round(L / 1.1));
    const segGeo = kit.geo(new THREE.BoxGeometry(L / n, T, W));
    const red = kit.mat(0xe05d5d, { roughness: 0.45 });
    const white = kit.mat(0xf5f5f5, { roughness: 0.45 });
    for (let i = 0; i < n; i++) {
      const seg = mesh(kit, segGeo, i % 2 ? red : white);
      seg.position.x = -L / 2 + (L / n) * (i + 0.5);
      this.root.add(seg);
    }
    const tipGeo = kit.geo(new THREE.CylinderGeometry(W / 2, W / 2, T, 16));
    for (const x of [-L / 2, L / 2]) {
      const tip = mesh(kit, tipGeo, kit.mat(0xffd24d, { roughness: 0.4 }));
      tip.position.x = x;
      this.root.add(tip);
    }
    const hub = mesh(kit, kit.geo(new THREE.CylinderGeometry(0.55, 0.7, 1.2, 16)), kit.mat(0x5c6370, { roughness: 0.35, metalness: 0.6 }));
    hub.position.y = -T / 2 - 0.6;
    this.root.add(hub);
    const cap = mesh(kit, kit.geo(new THREE.SphereGeometry(0.5, 14, 10)), kit.mat(0xffd24d, { roughness: 0.4 }));
    cap.position.y = -T / 2 - 1.25;
    cap.scale.y = 0.6;
    this.root.add(cap);
    // direction arrows painted on top
    const arrowMat = kit.mat(0xffd24d, { roughness: 0.5 });
    const arrowGeo = kit.geo(new THREE.ConeGeometry(0.3, 0.6, 3));
    arrowGeo.rotateZ(-Math.PI / 2);
    arrowGeo.scale(1, 0.12, 1);
    for (const x of [-L / 4, L / 4]) {
      const a = new THREE.Mesh(arrowGeo, arrowMat);
      a.position.set(x, T / 2 + 0.02, 0);
      a.rotation.y = (this.g.spin ?? 1) > 0 ? Math.PI / 2 : -Math.PI / 2;
      if (x < 0) a.rotation.y += Math.PI;
      this.root.add(a);
    }
  }

  private buildTrack(kit: BuildKit) {
    // a taut cable between the two parked positions shows where the shuttle runs
    const { a, b } = this.g;
    const [, T] = this.g.size;
    const from = new THREE.Vector3(a.x, a.y - T - 0.35, a.z);
    const to = new THREE.Vector3(b.x, b.y - T - 0.35, b.z);
    const d = to.clone().sub(from);
    const cable = new THREE.Mesh(kit.geo(new THREE.CylinderGeometry(0.04, 0.04, 1, 6)), kit.mat(0x5c6370, { roughness: 0.5, metalness: 0.4 }));
    cable.position.copy(from).addScaledVector(d, 0.5);
    cable.scale.y = d.length();
    cable.quaternion.setFromUnitVectors(UP, d.clone().normalize());
    kit.group.add(cable);
    for (const end of [from, to]) {
      const knob = new THREE.Mesh(kit.geo(new THREE.SphereGeometry(0.14, 10, 8)), kit.mat(0xffd24d, { roughness: 0.4 }));
      knob.position.copy(end);
      kit.group.add(knob);
    }
  }

  private buildShaft(kit: BuildKit) {
    // guide rails either side of the shaft, capped with a pulley
    const { a, b, rotY } = this.g;
    const [, , W] = this.g.size;
    const perp = new THREE.Vector3(-Math.sin(rotY), 0, Math.cos(rotY));
    const h = b.y - a.y + 1.6;
    const railGeo = kit.geo(new THREE.CylinderGeometry(0.08, 0.08, h, 8));
    const railMat = kit.mat(0x9aa3b2, { roughness: 0.35, metalness: 0.6 });
    for (const side of [-1, 1]) {
      const rail = mesh(kit, railGeo, railMat);
      rail.position.set(a.x + perp.x * side * (W / 2 + 0.2), a.y - 0.4 + h / 2, a.z + perp.z * side * (W / 2 + 0.2));
      kit.group.add(rail);
    }
    const beam = mesh(kit, kit.geo(new THREE.BoxGeometry(0.16, 0.16, W + 0.56)), railMat);
    beam.position.set(a.x, a.y - 0.4 + h, a.z);
    beam.rotation.y = -rotY;
    kit.group.add(beam);
    const wheel = mesh(kit, kit.geo(new THREE.TorusGeometry(0.32, 0.08, 8, 18)), kit.mat(0xffd24d, { roughness: 0.4 }));
    wheel.position.set(a.x, a.y - 0.4 + h - 0.32, a.z);
    wheel.rotation.y = -rotY;
    kit.group.add(wheel);
  }

  step(clock: number) {
    moverPose(this.g, clock, this.pose);
    this.tmpP.set(this.pose.x, this.pose.y - this.g.size[1] / 2, this.pose.z);
    this.kin.setPose(this.tmpP, headingQuat(this.pose.rotY, 0, this.tmpQ));
  }

  /** Deck pose at an arbitrary time (for placing remote riders, who lag behind). */
  poseAt(clock: number, out: Pose): Pose {
    return moverPose(this.g, clock, out);
  }

  syncVisual() {
    this.root.position.copy(this.kin.pos);
    this.root.quaternion.copy(this.kin.quat);
  }
}

// ---------------------------------------------------------------- seesaw

/**
 * Co-op catapult. Landing on the raised slam end (or pulling the lever on the
 * ledge) flips the plank; whoever stands on the seat end is flung up to the
 * target. The flip itself is driven by the server's 'launch' broadcast so all
 * clients see it at once.
 */
export class Seesaw {
  g: SeesawData;
  kin: Kinematic;
  tilt = SEESAW.tilt;
  private root = new THREE.Group();
  private plank = new THREE.Group();
  private weight = new THREE.Group();
  private weightRope: THREE.Mesh;
  private launchAt = -99;
  private viaLever = false;
  private weightRest: THREE.Vector3;
  private tmpQ = new THREE.Quaternion();
  leverArm: THREE.Object3D;
  private leverPulledAt = -99;

  constructor(kit: BuildKit, g: SeesawData) {
    this.g = g;
    const { halfLength, plankThickness: T, plankWidth: W, pivotHeight } = SEESAW;
    const dir = new THREE.Vector3(Math.cos(g.rotY), 0, Math.sin(g.rotY));
    kit.group.add(this.root);
    const baseY = g.pivot.y - pivotHeight;

    // fulcrum: a chunky A-frame stand on the drum
    const standMat = kit.mat(0x5c6370, { roughness: 0.4, metalness: 0.5 });
    for (const side of [-1, 1]) {
      const leg = mesh(kit, kit.geo(new THREE.BoxGeometry(0.22, pivotHeight + 0.2, 0.9)), standMat);
      const perp = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(side * (W / 2 + 0.16));
      leg.position.set(g.pivot.x + perp.x, baseY + (pivotHeight + 0.2) / 2 - 0.05, g.pivot.z + perp.z);
      leg.rotation.y = -g.rotY + Math.PI / 2;
      this.root.add(leg);
    }
    const axle = mesh(kit, kit.geo(new THREE.CylinderGeometry(0.14, 0.14, W + 0.7, 10)), kit.mat(0xffd24d, { roughness: 0.35, metalness: 0.4 }));
    axle.position.copy(new THREE.Vector3(g.pivot.x, g.pivot.y, g.pivot.z));
    axle.quaternion.setFromUnitVectors(UP, new THREE.Vector3(-dir.z, 0, dir.x));
    this.root.add(axle);

    // plank: wood with a padded seat at one end and a red target at the other
    this.plank.position.set(g.pivot.x, g.pivot.y, g.pivot.z);
    this.root.add(this.plank);
    const board = mesh(kit, kit.geo(new THREE.BoxGeometry(halfLength * 2, T, W)), kit.mat(0xc98f55, { roughness: 0.7 }));
    this.plank.add(board);
    hazardEdge(kit, this.plank, halfLength * 2, W / 2 + 0.03, 0, T * 0.6);
    hazardEdge(kit, this.plank, halfLength * 2, -W / 2 - 0.03, 0, T * 0.6);
    const seat = mesh(kit, kit.geo(new THREE.BoxGeometry(1.2, 0.18, W - 0.2)), kit.mat(0x4dabf7, { roughness: 0.6 }));
    seat.position.set(-halfLength + 0.7, T / 2 + 0.09, 0);
    this.plank.add(seat);
    for (const [r, c] of [[0.62, 0xe05d5d], [0.42, 0xf5f5f5], [0.22, 0xe05d5d]] as const) {
      const ring = new THREE.Mesh(kit.geo(new THREE.CylinderGeometry(r, r, 0.04, 20)), kit.mat(c, { roughness: 0.5 }));
      ring.position.set(halfLength - 0.7, T / 2 + 0.02 + (0.62 - r) * 0.05, 0);
      this.plank.add(ring);
    }

    // crane over the slam end holding the drop weight
    const slamRest = seesawPoint(g, 1, SEESAW.tilt);
    const postBase = new THREE.Vector3(g.pivot.x, baseY, g.pivot.z).addScaledVector(dir, halfLength * Math.cos(SEESAW.tilt) + 0.55);
    const post = mesh(kit, kit.geo(new THREE.CylinderGeometry(0.14, 0.2, 5.3, 10)), standMat);
    post.position.copy(postBase).add(new THREE.Vector3(0, 2.65, 0));
    this.root.add(post);
    const armLen = 1.25;
    const arm = mesh(kit, kit.geo(new THREE.BoxGeometry(armLen, 0.16, 0.16)), standMat);
    arm.position.copy(postBase).add(new THREE.Vector3(0, 5.2, 0)).addScaledVector(dir, -armLen / 2 + 0.1);
    arm.rotation.y = -g.rotY;
    this.root.add(arm);
    this.weightRest = new THREE.Vector3(slamRest.x, slamRest.y + 3.0, slamRest.z);
    // kettlebell weight
    const iron = kit.mat(0x37393f, { roughness: 0.45, metalness: 0.6 });
    const bell = mesh(kit, kit.geo(new THREE.SphereGeometry(0.45, 16, 12)), iron);
    bell.scale.y = 0.9;
    this.weight.add(bell);
    const handle = mesh(kit, kit.geo(new THREE.TorusGeometry(0.24, 0.07, 8, 16, Math.PI)), iron);
    handle.position.y = 0.36;
    this.weight.add(handle);
    const tag = kit.label('DROP!', { bg: '#ffc43d', fg: '#2d3038', scale: 0.55 });
    tag.position.y = -0.05;
    this.weight.add(tag);
    this.weight.position.copy(this.weightRest);
    this.root.add(this.weight);
    this.weightRope = new THREE.Mesh(kit.geo(new THREE.CylinderGeometry(0.03, 0.03, 1, 6)), kit.mat(0xd8c08a, { roughness: 1 }));
    this.root.add(this.weightRope);

    // dotted launch arc so the purpose reads at a glance
    const g0 = MOVE.gravity * gravityScaleAtY(g.target.y, kit.zones);
    const seatPt = seesawPoint(g, -0.85, SEESAW.tilt);
    const vel = ballisticVelocity(seatPt, g.target, g0, SEESAW.apexAbove);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = (vel.time * i) / 40;
      pts.push(new THREE.Vector3(seatPt.x + vel.x * t, seatPt.y + 0.5 + vel.y * t - 0.5 * g0 * t * t, seatPt.z + vel.z * t));
    }
    const arcGeo = kit.geo(new THREE.BufferGeometry().setFromPoints(pts));
    const arcMat = new THREE.LineDashedMaterial({ color: 0xffd24d, dashSize: 0.35, gapSize: 0.35, transparent: true, opacity: 0.55 });
    const arc = new THREE.Line(arcGeo, arcMat);
    arc.computeLineDistances();
    this.root.add(arc);
    kit.own(arcMat);

    const sign = kit.label('2+ CLIMBERS · SIT HERE', { bg: '#ffc43d', fg: '#2d3038', scale: 0.8 });
    const seatSign = seesawPoint(g, -1, SEESAW.tilt);
    sign.position.set(seatSign.x, seatSign.y + 2.0, seatSign.z);
    this.root.add(sign);

    // lever on the target ledge
    const lev = new THREE.Group();
    lev.position.set(g.lever.x, g.lever.y, g.lever.z);
    lev.rotation.y = -g.rotY;
    const box = mesh(kit, kit.geo(new THREE.BoxGeometry(0.5, 0.5, 0.5)), kit.mat(0x5c6370, { roughness: 0.4, metalness: 0.4 }));
    box.position.set(0, 0.25, -0.75);
    lev.add(box);
    this.leverArm = new THREE.Group();
    this.leverArm.position.set(0, 0.45, -0.75);
    const stick = mesh(kit, kit.geo(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8)), kit.mat(0x9aa3b2, { metalness: 0.6, roughness: 0.3 }));
    stick.position.y = 0.5;
    this.leverArm.add(stick);
    const knob = mesh(kit, kit.geo(new THREE.SphereGeometry(0.14, 12, 8)), kit.mat(0xe05d5d, { roughness: 0.4 }));
    knob.position.y = 1.0;
    this.leverArm.add(knob);
    this.leverArm.rotation.x = 0.6;
    lev.add(this.leverArm);
    const levSign = kit.label('LEVER · DROP THE WEIGHT', { bg: '#ffc43d', fg: '#2d3038', scale: 0.7 });
    levSign.position.set(0, 2.0, -0.4);
    lev.add(levSign);
    this.root.add(lev);

    const q = headingQuat(g.rotY, this.tilt);
    const p = new THREE.Vector3(g.pivot.x, g.pivot.y, g.pivot.z);
    const col = kit.world.createCollider(
      kit.R.ColliderDesc.cuboid(halfLength, T / 2, W / 2)
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCollisionGroups(kit.levelGroups)
        .setFriction(1.0),
    );
    this.kin = new Kinematic(col, p, q);
    this.syncVisual(0);
  }

  /** Server said flip. `clock` is the shared game time in seconds. */
  launch(clock: number, lever: boolean) {
    this.launchAt = clock;
    this.viaLever = lever;
    if (lever) this.leverPulledAt = clock;
  }

  /** Seconds after the launch event at which the plank actually snaps over. */
  get flipDelay(): number {
    return this.viaLever ? 0.28 : 0;
  }

  /** Is the plank currently in its snap-over (the moment riders get flung)? */
  flippingAt(clock: number): boolean {
    const t = clock - this.launchAt - this.flipDelay;
    return t >= 0 && t < SEESAW.flipTime + 0.05;
  }

  step(clock: number) {
    const t = clock - this.launchAt - this.flipDelay;
    const { tilt, flipTime, holdTime, resetTime } = SEESAW;
    let a = tilt;
    if (t >= 0 && t < flipTime) a = THREE.MathUtils.lerp(tilt, -tilt, smooth(t / flipTime));
    else if (t >= flipTime && t < flipTime + holdTime) a = -tilt;
    else if (t >= flipTime + holdTime && t < flipTime + holdTime + resetTime) a = THREE.MathUtils.lerp(-tilt, tilt, smooth((t - flipTime - holdTime) / resetTime));
    this.tilt = a;
    this.kin.setPose(this.kin.pos, headingQuat(this.g.rotY, a, this.tmpQ));
  }

  /** Along-plank coordinate of a world point: -1 seat end … +1 slam end. */
  alongOf(p: THREE.Vector3): number {
    const local = this.kin.toLocal(p);
    return local.x / SEESAW.halfLength;
  }

  syncVisual(clock: number) {
    this.plank.quaternion.copy(this.kin.quat);
    // the weight drops onto the slam end, then winches back up
    const since = clock - this.launchAt;
    const slam = seesawPoint(this.g, 1, -SEESAW.tilt);
    let y = this.weightRest.y;
    if (this.viaLever && since >= 0 && since < 2.6) {
      if (since < this.flipDelay) y = THREE.MathUtils.lerp(this.weightRest.y, slam.y + 0.45, (since / this.flipDelay) ** 2);
      else if (since < 0.9) y = slam.y + 0.45 + Math.max(0, Math.sin((since - this.flipDelay) * 12)) * 0.2 * (0.9 - since);
      else y = THREE.MathUtils.lerp(slam.y + 0.45, this.weightRest.y, smooth((since - 0.9) / 1.7));
    }
    this.weight.position.set(this.weightRest.x, y, this.weightRest.z);
    const top = this.weightRest.y + 2.2;
    this.weightRope.position.set(this.weightRest.x, (top + y + 0.55) / 2, this.weightRest.z);
    this.weightRope.scale.y = Math.max(0.1, top - y - 0.55);
    const lp = clock - this.leverPulledAt;
    this.leverArm.rotation.x = lp >= 0 && lp < 1.5 ? THREE.MathUtils.lerp(-0.6, 0.6, smooth(Math.max(0, lp - 0.6) / 0.9)) : 0.6;
  }
}

// ---------------------------------------------------------------- crank lift

/**
 * Co-op lift: rises while anyone stands on one of its crank plates (server
 * 'hold' state) and sinks back when nobody does. The crank wheels beside the
 * plates spin while it's working.
 */
export class CrankLift {
  g: CrankData;
  kin: Kinematic;
  state: GadgetState | null = null;
  h = 0;
  private root = new THREE.Group();
  private deck = new THREE.Group();
  private rope: THREE.Mesh;
  private topY: number;
  wheels: THREE.Object3D[] = [];
  private tmpP = new THREE.Vector3();

  constructor(kit: BuildKit, g: CrankData) {
    this.g = g;
    const [L, T, W] = CRANK.deck;
    const dir = new THREE.Vector3(Math.cos(g.rotY), 0, Math.sin(g.rotY));
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    kit.group.add(this.root);
    this.root.add(this.deck);

    // deck: a sturdy crate floor with side railings (open front and back)
    const floor = mesh(kit, kit.geo(new THREE.BoxGeometry(L, T, W)), kit.mat(0xb07a45, { roughness: 0.75 }));
    this.deck.add(floor);
    hazardEdge(kit, this.deck, L, W / 2 + 0.03, 0, T * 0.7);
    hazardEdge(kit, this.deck, L, -W / 2 - 0.03, 0, T * 0.7);
    const railMat = kit.mat(0xffc43d, { roughness: 0.45 });
    const railGeo = kit.geo(new THREE.BoxGeometry(L, 0.1, 0.1));
    const postGeo = kit.geo(new THREE.BoxGeometry(0.1, 0.9, 0.1));
    for (const z of [-W / 2, W / 2]) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(0, T / 2 + 0.9, z);
      this.deck.add(rail);
      for (const x of [-L / 2 + 0.05, 0, L / 2 - 0.05]) {
        const post = new THREE.Mesh(postGeo, railMat);
        post.position.set(x, T / 2 + 0.45, z);
        this.deck.add(post);
      }
    }

    // shaft: four corner columns, a top frame and a pulley wheel
    this.topY = g.base.y + g.rise + 2.4;
    const colGeo = kit.geo(new THREE.CylinderGeometry(0.1, 0.1, this.topY - g.base.y + 0.5, 8));
    const steel = kit.mat(0x9aa3b2, { roughness: 0.35, metalness: 0.6 });
    for (const a of [-1, 1]) {
      for (const b of [-1, 1]) {
        const c = mesh(kit, colGeo, steel);
        c.position.set(
          g.base.x + dir.x * a * (L / 2 + 0.2) + perp.x * b * (W / 2 + 0.2),
          (g.base.y - 0.5 + this.topY) / 2,
          g.base.z + dir.z * a * (L / 2 + 0.2) + perp.z * b * (W / 2 + 0.2),
        );
        this.root.add(c);
      }
    }
    const frame = mesh(kit, kit.geo(new THREE.BoxGeometry(L + 0.5, 0.18, W + 0.5)), steel);
    frame.position.set(g.base.x, this.topY, g.base.z);
    frame.rotation.y = -g.rotY;
    frame.scale.set(1, 1, 1);
    this.root.add(frame);
    const pulley = mesh(kit, kit.geo(new THREE.TorusGeometry(0.42, 0.1, 8, 20)), kit.mat(0xffd24d, { roughness: 0.4 }));
    pulley.position.set(g.base.x, this.topY - 0.5, g.base.z);
    pulley.rotation.y = -g.rotY;
    this.root.add(pulley);
    this.wheels.push(pulley);
    this.rope = new THREE.Mesh(kit.geo(new THREE.CylinderGeometry(0.04, 0.04, 1, 6)), kit.mat(0xd8c08a, { roughness: 1 }));
    this.root.add(this.rope);

    // crank wheels beside both plates
    const plateLabels = ['CRANK · 2+ CLIMBERS', 'CRANK'];
    g.plates.forEach((pp, i) => {
      const crank = new THREE.Group();
      const side = new THREE.Vector3(pp.x, pp.y, pp.z).addScaledVector(perp, 1.05);
      crank.position.copy(side);
      const stand = mesh(kit, kit.geo(new THREE.BoxGeometry(0.3, 1.0, 0.3)), steel);
      stand.position.y = 0.5;
      crank.add(stand);
      const wheel = new THREE.Group();
      wheel.position.y = 1.05;
      wheel.rotation.y = -g.rotY;
      const rim = mesh(kit, kit.geo(new THREE.TorusGeometry(0.42, 0.07, 8, 18)), kit.mat(0xe05d5d, { roughness: 0.4 }));
      wheel.add(rim);
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(kit.geo(new THREE.BoxGeometry(0.84, 0.06, 0.06)), steel);
        spoke.rotation.z = (k / 3) * Math.PI;
        wheel.add(spoke);
      }
      crank.add(wheel);
      this.wheels.push(wheel);
      const sign = kit.label(plateLabels[i] ?? 'CRANK', { bg: '#ffc43d', fg: '#2d3038', scale: 0.7 });
      sign.position.y = 2.1;
      crank.add(sign);
      this.root.add(crank);
    });

    const q = headingQuat(g.rotY);
    const p = new THREE.Vector3(g.base.x, g.base.y - T / 2, g.base.z);
    const col = kit.world.createCollider(
      kit.R.ColliderDesc.cuboid(L / 2, T / 2, W / 2)
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCollisionGroups(kit.levelGroups)
        .setFriction(1.0),
    );
    this.kin = new Kinematic(col, p, q);
    this.syncVisual(0);
  }

  step(dt: number) {
    const target = this.state?.active ? this.g.rise : 0;
    const speed = target > this.h ? CRANK.riseSpeed : CRANK.fallSpeed;
    this.h = THREE.MathUtils.clamp(this.h + THREE.MathUtils.clamp(target - this.h, -speed * dt, speed * dt), 0, this.g.rise);
    this.tmpP.set(this.g.base.x, this.g.base.y + this.h - CRANK.deck[1] / 2, this.g.base.z);
    this.kin.setPose(this.tmpP, this.kin.quat);
  }

  syncVisual(t: number) {
    this.deck.position.copy(this.kin.pos);
    this.deck.quaternion.copy(this.kin.quat);
    const deckTop = this.kin.pos.y + CRANK.deck[1] / 2;
    this.rope.position.set(this.g.base.x, (deckTop + 1.0 + this.topY - 0.9) / 2, this.g.base.z);
    this.rope.scale.y = Math.max(0.1, this.topY - 0.9 - deckTop - 1.0);
    const turning = this.state?.active && this.h < this.g.rise - 0.01;
    const back = !this.state?.active && this.h > 0.01;
    for (const w of this.wheels) if (turning || back) w.rotateZ((turning ? 1 : -1) * 0.12);
    void t;
  }
}
