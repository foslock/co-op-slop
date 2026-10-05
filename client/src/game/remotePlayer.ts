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
  private help: THREE.Sprite;

  constructor(id: string, name: string, cos: Cosmetics, scene: THREE.Scene) {
    this.id = id;
    this.name = name;
    this.rig = buildCharacter(cos, name);
    scene.add(this.rig.group);
    this.help = helpBubble();
    this.help.visible = false;
    this.rig.group.add(this.help);
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
    // hanging off a ledge: shout for help so teammates come and pull them up
    this.help.visible = this.anim === ANIM.hang;
    if (this.help.visible) {
      const pulse = 1 + Math.sin(this.animTime * 10) * 0.08;
      this.help.scale.set(1.15 * pulse, 0.55 * pulse, 1);
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.rig.group);
    this.rig.dispose();
    (this.help.material as THREE.SpriteMaterial).map?.dispose();
    this.help.material.dispose();
  }
}

function helpBubble(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 124;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#ff5d5d';
  c.beginPath();
  c.roundRect(8, 8, 240, 86, 40);
  c.moveTo(112, 92);
  c.lineTo(128, 118);
  c.lineTo(144, 92);
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = 'rgba(0,0,0,0.35)';
  c.stroke();
  c.fillStyle = '#fff';
  c.font = '800 54px "Fredoka", "Nunito", system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('HELP!', 128, 54);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.position.y = 1.55;
  sprite.renderOrder = 6;
  return sprite;
}
