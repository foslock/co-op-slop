import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { COSMETIC_COLORS, GAME, type Cosmetics } from 'shared';
import { GROUP_LEVEL, GROUP_RAGDOLL, groups } from './physics';
import { buildCharacter, type CharacterRig, type RigPose } from './characterMesh';
import { sfx } from '../audio';

interface Part {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
}

// A knocked-down player: the same blobby character core (body, eyes, hat) driven
// by one physics capsule, with the four stubby limbs as separate flailing bodies.
export class Ragdoll {
  parts: Part[] = [];
  torso: RAPIER.RigidBody;
  group = new THREE.Group();
  /** Earliest recovery — you also have to have stopped moving. */
  until: number;
  /** Backstop so a body wedged against geometry still gets up eventually. */
  hardUntil: number;
  private restingSince = 0;
  private joints: RAPIER.ImpulseJoint[] = [];
  private world: RAPIER.World;
  private core: CharacterRig;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(world: RAPIER.World, R: typeof RAPIER, scene: THREE.Scene, pos: THREE.Vector3, vel: THREE.Vector3, cosmetics: Cosmetics, durationMs: number, gravityScale = 1, pose?: RigPose) {
    this.world = world;
    this.until = performance.now() + durationMs;
    this.hardUntil = performance.now() + durationMs + 9000;
    scene.add(this.group);
    const g = groups(GROUP_RAGDOLL, GROUP_LEVEL | GROUP_RAGDOLL);

    // Starting from a live pose means the handover is invisible: bodies begin
    // exactly where the animated limbs were, so nothing jumps on the first frame.
    // Without a pose we fall back to the neutral layout and a lively tumble.
    const spin = pose ? 1.2 : 6;
    const makeBody = (offset: THREE.Vector3, quat?: THREE.Quaternion) => {
      const desc = R.RigidBodyDesc.dynamic()
        .setTranslation(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z)
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel({ x: (Math.random() - 0.5) * spin, y: (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin })
        .setLinearDamping(0.15)
        .setAngularDamping(0.6)
        .setGravityScale(gravityScale);
      if (quat) desc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
      return world.createRigidBody(desc);
    };

    // torso = the character core itself
    const torsoBody = makeBody(new THREE.Vector3(0, 0, 0), pose?.quat);
    world.createCollider(
      R.ColliderDesc.capsule(0.22, 0.3).setCollisionGroups(g).setRestitution(0.35).setFriction(0.8),
      torsoBody,
    );
    this.core = buildCharacter(cosmetics, undefined, false);
    this.core.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).castShadow = true;
    });
    this.group.add(this.core.group);
    const torsoPart: Part = { body: torsoBody, mesh: this.core.group };
    this.parts.push(torsoPart);
    this.torso = torsoBody;

    // limbs, matching the rig's stubby arms/legs
    const color = COSMETIC_COLORS[cosmetics.color % COSMETIC_COLORS.length];
    const matDark = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.72).getHex(),
      roughness: 0.7,
    });
    this.disposables.push(matDark);

    const limb = (r: number, len: number, offset: THREE.Vector3, poseIdx: number): Part => {
      const live = pose?.limbs[poseIdx];
      const body = makeBody(live?.pos ?? offset, live?.quat);
      world.createCollider(
        R.ColliderDesc.capsule(len / 2, r).setCollisionGroups(g).setRestitution(0.35).setFriction(0.8),
        body,
      );
      const geo = new THREE.CapsuleGeometry(r, len, 4, 8);
      this.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, matDark);
      mesh.castShadow = true;
      this.group.add(mesh);
      const part = { body, mesh };
      this.parts.push(part);
      return part;
    };
    // offsets/anchors mirror the rig's limb layout so the joints rest naturally
    const armL = limb(0.07, 0.2, new THREE.Vector3(-0.29, 0.035, 0), 0);
    const armR = limb(0.07, 0.2, new THREE.Vector3(0.29, 0.035, 0), 1);
    const legL = limb(0.09, 0.19, new THREE.Vector3(-0.135, -0.44, 0), 2);
    const legR = limb(0.09, 0.19, new THREE.Vector3(0.135, -0.44, 0), 3);

    const joint = (a: Part, b: Part, anchorA: THREE.Vector3, anchorB: THREE.Vector3) => {
      const data = R.JointData.spherical(
        { x: anchorA.x, y: anchorA.y, z: anchorA.z },
        { x: anchorB.x, y: anchorB.y, z: anchorB.z },
      );
      this.joints.push(world.createImpulseJoint(data, a.body, b.body, true));
    };
    joint(torsoPart, armL, new THREE.Vector3(-0.29, 0.17, 0), new THREE.Vector3(0, 0.135, 0));
    joint(torsoPart, armR, new THREE.Vector3(0.29, 0.17, 0), new THREE.Vector3(0, 0.135, 0));
    joint(torsoPart, legL, new THREE.Vector3(-0.135, -0.30, 0), new THREE.Vector3(0, 0.14, 0));
    joint(torsoPart, legR, new THREE.Vector3(0.135, -0.30, 0), new THREE.Vector3(0, 0.14, 0));
  }

  sync() {
    for (const p of this.parts) {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /**
   * Has the body actually settled? A knocked-down player stays down until they
   * land and stop tumbling, so a long fall keeps ragdolling the whole way.
   */
  isAtRest(now: number): boolean {
    const lv = this.torso.linvel();
    const av = this.torso.angvel();
    const still =
      Math.hypot(lv.x, lv.y, lv.z) < 0.9 && Math.hypot(av.x, av.y, av.z) < 2.2;
    if (!still) {
      this.restingSince = 0;
      return false;
    }
    if (this.restingSince === 0) this.restingSince = now;
    return now - this.restingSince > 350; // settled, not just passing through zero
  }

  torsoPos(): THREE.Vector3 {
    const t = this.torso.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  dispose(scene: THREE.Scene) {
    for (const j of this.joints) this.world.removeImpulseJoint(j, false);
    for (const p of this.parts) this.world.removeRigidBody(p.body);
    scene.remove(this.group);
    this.core.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export class RagdollManager {
  private world: RAPIER.World;
  private R: typeof RAPIER;
  private scene: THREE.Scene;
  private active = new Map<string, Ragdoll>(); // keyed by player id

  constructor(world: RAPIER.World, R: typeof RAPIER, scene: THREE.Scene) {
    this.world = world;
    this.R = R;
    this.scene = scene;
  }

  spawn(playerId: string, pos: THREE.Vector3, vel: THREE.Vector3, cosmetics: Cosmetics, durationMs = GAME.ragdollTimeMs, gravityScale = 1, pose?: RigPose): Ragdoll {
    this.remove(playerId);
    const rd = new Ragdoll(this.world, this.R, this.scene, pos, vel, cosmetics, durationMs, gravityScale, pose);
    this.active.set(playerId, rd);
    sfx.knock();
    return rd;
  }

  get(playerId: string): Ragdoll | undefined {
    return this.active.get(playerId);
  }

  remove(playerId: string) {
    const rd = this.active.get(playerId);
    if (rd) {
      rd.dispose(this.scene);
      this.active.delete(playerId);
    }
  }

  /** Sync meshes; returns ids that have landed and are ready to get back up. */
  syncAndExpire(now: number): string[] {
    const expired: string[] = [];
    for (const [id, rd] of this.active) {
      rd.sync();
      if (now > rd.hardUntil || (now > rd.until && rd.isAtRest(now))) expired.push(id);
    }
    return expired;
  }

  disposeAll() {
    for (const [, rd] of this.active) rd.dispose(this.scene);
    this.active.clear();
  }
}
