import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GAME } from 'shared';
import { GROUP_LEVEL, GROUP_RAGDOLL, groups } from './physics';
import { sfx } from '../audio';

interface Part {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
}

export class Ragdoll {
  parts: Part[] = [];
  torso: RAPIER.RigidBody;
  group = new THREE.Group();
  until: number;
  private joints: RAPIER.ImpulseJoint[] = [];
  private world: RAPIER.World;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(world: RAPIER.World, R: typeof RAPIER, scene: THREE.Scene, pos: THREE.Vector3, vel: THREE.Vector3, color: number, durationMs: number) {
    this.world = world;
    this.until = performance.now() + durationMs;
    scene.add(this.group);
    const g = groups(GROUP_RAGDOLL, GROUP_LEVEL | GROUP_RAGDOLL);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const matDark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.72).getHex(), roughness: 0.7 });
    this.disposables.push(mat, matDark);

    const makePart = (
      kind: 'box' | 'ball' | 'capsule',
      size: number[],
      offset: THREE.Vector3,
      material: THREE.Material,
    ): Part => {
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z)
          .setLinvel(vel.x, vel.y, vel.z)
          .setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 })
          .setLinearDamping(0.15)
          .setAngularDamping(0.6),
      );
      let desc: RAPIER.ColliderDesc;
      let geo: THREE.BufferGeometry;
      if (kind === 'box') {
        desc = R.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2);
        geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
      } else if (kind === 'ball') {
        desc = R.ColliderDesc.ball(size[0]);
        geo = new THREE.SphereGeometry(size[0], 10, 8);
      } else {
        desc = R.ColliderDesc.capsule(size[1], size[0]);
        geo = new THREE.CapsuleGeometry(size[0], size[1] * 2, 4, 8);
      }
      this.disposables.push(geo);
      world.createCollider(desc.setCollisionGroups(g).setRestitution(0.35).setFriction(0.8), body);
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      this.group.add(mesh);
      const part = { body, mesh };
      this.parts.push(part);
      return part;
    };

    const torso = makePart('box', [0.44, 0.55, 0.36], new THREE.Vector3(0, 0, 0), mat);
    const head = makePart('ball', [0.21], new THREE.Vector3(0, 0.52, 0), mat);
    const armL = makePart('capsule', [0.07, 0.13], new THREE.Vector3(-0.36, 0.1, 0), matDark);
    const armR = makePart('capsule', [0.07, 0.13], new THREE.Vector3(0.36, 0.1, 0), matDark);
    const legL = makePart('capsule', [0.09, 0.12], new THREE.Vector3(-0.14, -0.5, 0), matDark);
    const legR = makePart('capsule', [0.09, 0.12], new THREE.Vector3(0.14, -0.5, 0), matDark);
    this.torso = torso.body;

    const joint = (a: Part, b: Part, anchorA: THREE.Vector3, anchorB: THREE.Vector3) => {
      const data = R.JointData.spherical(
        { x: anchorA.x, y: anchorA.y, z: anchorA.z },
        { x: anchorB.x, y: anchorB.y, z: anchorB.z },
      );
      this.joints.push(world.createImpulseJoint(data, a.body, b.body, true));
    };
    joint(torso, head, new THREE.Vector3(0, 0.32, 0), new THREE.Vector3(0, -0.24, 0));
    joint(torso, armL, new THREE.Vector3(-0.26, 0.2, 0), new THREE.Vector3(0, 0.18, 0));
    joint(torso, armR, new THREE.Vector3(0.26, 0.2, 0), new THREE.Vector3(0, 0.18, 0));
    joint(torso, legL, new THREE.Vector3(-0.14, -0.31, 0), new THREE.Vector3(0, 0.17, 0));
    joint(torso, legR, new THREE.Vector3(0.14, -0.31, 0), new THREE.Vector3(0, 0.17, 0));
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

  spawn(playerId: string, pos: THREE.Vector3, vel: THREE.Vector3, color: number, durationMs = GAME.ragdollTimeMs): Ragdoll {
    this.remove(playerId);
    const rd = new Ragdoll(this.world, this.R, this.scene, pos, vel, color, durationMs);
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
