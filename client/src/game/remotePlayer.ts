import * as THREE from 'three';
import { ANIM, type Cosmetics } from 'shared';
import { buildCharacter, type CharacterRig } from './characterMesh';

interface Snapshot {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: number;
  vy: number;
}

export class RemotePlayer {
  id: string;
  name: string;
  rig: CharacterRig;
  pos = new THREE.Vector3(0, -100, 0);
  yaw = 0;
  anim: number = ANIM.idle;
  vy = 0;
  speed = 0;
  finished = false;
  private buffer: Snapshot[] = [];
  private animTime = 0;

  constructor(id: string, name: string, cos: Cosmetics, scene: THREE.Scene) {
    this.id = id;
    this.name = name;
    this.rig = buildCharacter(cos, name);
    scene.add(this.rig.group);
  }

  push(time: number, s: [number, number, number, number, number, number]) {
    this.buffer.push({ time, x: s[0], y: s[1], z: s[2], yaw: s[3], anim: s[4], vy: s[5] });
    if (this.buffer.length > 40) this.buffer.shift();
  }

  /** Interpolate toward renderTime (serverNow - interp delay). */
  update(renderTime: number, dt: number) {
    const buf = this.buffer;
    if (buf.length === 0) return;
    let prev = buf[0];
    let next = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= renderTime && buf[i + 1].time >= renderTime) {
        prev = buf[i];
        next = buf[i + 1];
        break;
      }
    }
    let a = 0;
    if (next.time > prev.time) a = THREE.MathUtils.clamp((renderTime - prev.time) / (next.time - prev.time), 0, 1);
    const nx = THREE.MathUtils.lerp(prev.x, next.x, a);
    const ny = THREE.MathUtils.lerp(prev.y, next.y, a);
    const nz = THREE.MathUtils.lerp(prev.z, next.z, a);
    this.speed = dt > 0 ? Math.hypot(nx - this.pos.x, nz - this.pos.z) / dt : 0;
    // snap on big jumps (respawns)
    if (this.pos.distanceToSquared(new THREE.Vector3(nx, ny, nz)) > 100) this.speed = 0;
    this.pos.set(nx, ny, nz);
    let dyaw = next.yaw - prev.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    this.yaw = prev.yaw + dyaw * a;
    this.anim = next.anim;
    this.vy = next.vy;

    this.animTime += dt;
    this.rig.group.position.copy(this.pos);
    this.rig.group.rotation.y = this.yaw;
    this.rig.group.visible = this.anim !== ANIM.ragdoll;
    this.rig.animate(this.anim, this.animTime, this.speed, this.vy);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.rig.group);
    this.rig.dispose();
  }
}
