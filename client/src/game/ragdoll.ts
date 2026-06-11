import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { COSMETIC_COLORS, GAME, type Cosmetics } from 'shared';
import { GROUP_LEVEL, GROUP_RAGDOLL, groups } from './physics';
import { buildCharacter, type CharacterRig } from './characterMesh';
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
  until: number;
  private joints: RAPIER.ImpulseJoint[] = [];
  private world: RAPIER.World;
  private core: CharacterRig;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(world: RAPIER.World, R: typeof RAPIER, scene: THREE.Scene, pos: THREE.Vector3, vel: THREE.Vector3, cosmetics: Cosmetics, durationMs: number) {
    this.world = world;
    this.until = performance.now() + durationMs;
    scene.add(this.group);
    const g = groups(GROUP_RAGDOLL, GROUP_LEVEL | GROUP_RAGDOLL);

    const makeBody = (offset: THREE.Vector3) =>
      world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z)
          .setLinvel(vel.x, vel.y, vel.z)
          .setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 })
          .setLinearDamping(0.15)
          .setAngularDamping(0.6),
      );

    // torso = the character core itself
    const torsoBody = makeBody(new THREE.Vector3(0, 0, 0));
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

    const limb = (r: number, len: number, offset: THREE.Vector3): Part => {
      const body = makeBody(offset);
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
    const armL = limb(0.07, 0.2, new THREE.Vector3(-0.36, 0.02, 0));
    const armR = limb(0.07, 0.2, new THREE.Vector3(0.36, 0.02, 0));
    const legL = limb(0.09, 0.17, new THREE.Vector3(-0.14, -0.46, 0));
    const legR = limb(0.09, 0.17, new THREE.Vector3(0.14, -0.46, 0));

    const joint = (a: Part, b: Part, anchorA: THREE.Vector3, anchorB: THREE.Vector3) => {
      const data = R.JointData.spherical(
        { x: anchorA.x, y: anchorA.y, z: anchorA.z },
        { x: anchorB.x, y: anchorB.y, z: anchorB.z },
      );
      this.joints.push(world.createImpulseJoint(data, a.body, b.body, true));
    };
    joint(torsoPart, armL, new THREE.Vector3(-0.33, 0.16, 0), new THREE.Vector3(0, 0.15, 0));
    joint(torsoPart, armR, new THREE.Vector3(0.33, 0.16, 0), new THREE.Vector3(0, 0.15, 0));
    joint(torsoPart, legL, new THREE.Vector3(-0.14, -0.3, 0), new THREE.Vector3(0, 0.13, 0));
    joint(torsoPart, legR, new THREE.Vector3(0.14, -0.3, 0), new THREE.Vector3(0, 0.13, 0));
  }

  sync() {
    for (const p of this.parts) {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
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

  spawn(playerId: string, pos: THREE.Vector3, vel: THREE.Vector3, cosmetics: Cosmetics, durationMs = GAME.ragdollTimeMs): Ragdoll {
    this.remove(playerId);
    const rd = new Ragdoll(this.world, this.R, this.scene, pos, vel, cosmetics, durationMs);
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

  /** Sync meshes; returns ids whose ragdoll just expired. */
  syncAndExpire(now: number): string[] {
    const expired: string[] = [];
    for (const [id, rd] of this.active) {
      rd.sync();
      if (now > rd.until) expired.push(id);
    }
    return expired;
  }

  disposeAll() {
    for (const [, rd] of this.active) rd.dispose(this.scene);
    this.active.clear();
  }
}
