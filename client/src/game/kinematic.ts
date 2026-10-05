import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

/**
 * A collider that moves on its own (lift decks, shuttles, spinning beams,
 * seesaw planks). It is a parentless static collider teleported once per fixed
 * step — Rapier 0.14's character controller cannot slide along a resting
 * kinematic body — and it remembers its previous pose so anything standing on
 * it (or hanging from it) can be carried by exactly the same rigid motion.
 */
export class Kinematic {
  collider: RAPIER.Collider;
  pos = new THREE.Vector3();
  quat = new THREE.Quaternion();
  prevPos = new THREE.Vector3();
  prevQuat = new THREE.Quaternion();

  constructor(collider: RAPIER.Collider, pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.collider = collider;
    this.pos.copy(pos);
    this.prevPos.copy(pos);
    this.quat.copy(quat);
    this.prevQuat.copy(quat);
  }

  /** Move to a new pose for this step (call exactly once per fixed step, even when still). */
  setPose(p: THREE.Vector3, q: THREE.Quaternion) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.pos.copy(p);
    this.quat.copy(q);
    if (!this.pos.equals(this.prevPos) || !this.quat.equals(this.prevQuat)) {
      this.collider.setTranslation({ x: p.x, y: p.y, z: p.z });
      this.collider.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  get moved(): boolean {
    return !this.pos.equals(this.prevPos) || !this.quat.equals(this.prevQuat);
  }

  /** Where a point riding this collider ends up after the latest pose change. */
  carry(point: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    tmpQ.copy(this.prevQuat).invert();
    return out.copy(point).sub(this.prevPos).applyQuaternion(tmpQ).applyQuaternion(this.quat).add(this.pos);
  }

  /** How far the collider turned about the vertical axis during the latest step. */
  yawDelta(): number {
    tmpQ.copy(this.prevQuat).invert().premultiply(this.quat);
    tmpV.set(1, 0, 0).applyQuaternion(tmpQ);
    return Math.atan2(-tmpV.z, tmpV.x);
  }

  toLocal(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    tmpQ.copy(this.quat).invert();
    return out.copy(p).sub(this.pos).applyQuaternion(tmpQ);
  }

  toWorld(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(p).applyQuaternion(this.quat).add(this.pos);
  }
}

/** Quaternion for a deck whose length runs along generator heading `h` (direction (cos h, sin h)). */
export function headingQuat(h: number, tilt = 0, out = new THREE.Quaternion()): THREE.Quaternion {
  out.setFromEuler(new THREE.Euler(0, -h, tilt, 'YXZ'));
  return out;
}
