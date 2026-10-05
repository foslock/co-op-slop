import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_LEVEL, GROUP_PLAYER, groups } from './physics';

const MAX = 900;

type BurstKind = 'dust' | 'confetti' | 'sparkle' | 'puff';

const CONFETTI = [0xff7a7a, 0xffd24d, 0x69db7c, 0x4dabf7, 0x9775fa, 0xf783ac];

/**
 * Small visual garnish: a soft blob shadow straight under every player (the
 * single most useful depth cue for judging a jump), and a pooled particle
 * system for landing dust, checkpoint confetti and pickup sparkles.
 */
export class Effects {
  private scene: THREE.Scene;
  private points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private shape = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private grav = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private baseSize = new Float32Array(MAX);
  private next = 0;

  private shadowTex: THREE.Texture;
  private shadowGeo = new THREE.PlaneGeometry(1, 1);
  private shadows = new Map<string, THREE.Mesh>();
  private ray: RAPIER.Ray | null = null;
  private tmpN = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('shape', new THREE.BufferAttribute(this.shape, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: `
        attribute vec3 pcolor;
        attribute float size;
        attribute float alpha;
        attribute float shape;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vShape;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * uScale / max(0.1, -mv.z);
          vColor = pcolor;
          vAlpha = alpha;
          vShape = shape;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        varying float vShape;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a;
          if (vShape > 0.5) {
            // confetti chip
            if (abs(d.x) > 0.42 || abs(d.y) > 0.24) discard;
            a = vAlpha;
          } else {
            float r = length(d);
            if (r > 0.5) discard;
            a = vAlpha * smoothstep(0.5, 0.1, r);
          }
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);

    // radial falloff for blob shadows
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(10,14,30,0.85)');
    g.addColorStop(0.55, 'rgba(10,14,30,0.45)');
    g.addColorStop(1, 'rgba(10,14,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    this.shadowTex = new THREE.CanvasTexture(c);
    this.shadowGeo.rotateX(-Math.PI / 2);
  }

  /** Point sprites are sized in metres; tell the shader how many pixels a metre is at 1 m depth. */
  setViewport(heightPx: number, fovDeg: number) {
    this.mat.uniforms.uScale.value = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  burst(kind: BurstKind, at: THREE.Vector3, color?: number, count?: number) {
    const n = count ?? (kind === 'confetti' ? 70 : kind === 'sparkle' ? 26 : kind === 'puff' ? 18 : 10);
    const c = new THREE.Color();
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2;
      let sp: number, up: number, life: number, size: number;
      switch (kind) {
        case 'dust': sp = 1.2 + Math.random() * 1.6; up = 0.4 + Math.random() * 0.8; life = 0.45 + Math.random() * 0.3; size = 0.32; c.setHex(color ?? 0xe8e2d4); break;
        case 'puff': sp = 0.8 + Math.random() * 2.2; up = Math.random() * 2.2; life = 0.6 + Math.random() * 0.4; size = 0.55; c.setHex(color ?? 0xffffff); break;
        case 'sparkle': sp = 1 + Math.random() * 2.5; up = 1 + Math.random() * 3; life = 0.6 + Math.random() * 0.5; size = 0.16; c.setHex(color ?? 0xffe066); break;
        case 'confetti': sp = 2 + Math.random() * 4.5; up = 4 + Math.random() * 6; life = 1.6 + Math.random() * 1.2; size = 0.22; c.setHex(color ?? CONFETTI[k % CONFETTI.length]); break;
      }
      this.pos[i * 3] = at.x + Math.cos(a) * 0.2;
      this.pos[i * 3 + 1] = at.y + (kind === 'dust' ? 0.05 : 0.3);
      this.pos[i * 3 + 2] = at.z + Math.sin(a) * 0.2;
      this.vel[i * 3] = Math.cos(a) * sp;
      this.vel[i * 3 + 1] = up;
      this.vel[i * 3 + 2] = Math.sin(a) * sp;
      this.col[i * 3] = c.r;
      this.col[i * 3 + 1] = c.g;
      this.col[i * 3 + 2] = c.b;
      this.life[i] = life;
      this.maxLife[i] = life;
      this.baseSize[i] = size * (0.7 + Math.random() * 0.6);
      this.grav[i] = kind === 'confetti' ? 5 : kind === 'sparkle' ? 3 : kind === 'puff' ? -0.6 : 1.5;
      this.drag[i] = kind === 'confetti' ? 1.6 : 3.2;
      this.shape[i] = kind === 'confetti' ? 1 : 0;
    }
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) { this.alpha[i] = 0; this.size[i] = 0; }
        continue;
      }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 2] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const u = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = this.shape[i] > 0.5 ? Math.min(1, u * 3) : u * 0.85;
      this.size[i] = this.baseSize[i] * (this.shape[i] > 0.5 ? 1 : 1 + (1 - u) * 1.2);
    }
    for (const name of ['position', 'pcolor', 'size', 'alpha', 'shape']) this.geo.attributes[name].needsUpdate = true;
  }

  /** Keep `id`'s blob shadow under `p` (body center); null hides it. */
  updateShadow(id: string, p: THREE.Vector3 | null, world: RAPIER.World, R: typeof RAPIER, exclude?: RAPIER.RigidBody) {
    let m = this.shadows.get(id);
    if (!m) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.shadowTex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      m = new THREE.Mesh(this.shadowGeo, mat);
      m.renderOrder = 2;
      this.scene.add(m);
      this.shadows.set(id, m);
    }
    if (!p) {
      m.visible = false;
      return;
    }
    this.ray ??= new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.ray.origin = { x: p.x, y: p.y - 0.4, z: p.z };
    const hit = world.castRayAndGetNormal(this.ray, 40, true, undefined, groups(GROUP_PLAYER, GROUP_LEVEL), undefined, exclude);
    if (!hit || hit.normal.y < 0.3) {
      m.visible = false;
      return;
    }
    const h = hit.timeOfImpact;
    m.visible = true;
    m.position.set(p.x, p.y - 0.4 - h + 0.03, p.z);
    m.quaternion.setFromUnitVectors(this.up, this.tmpN.set(hit.normal.x, hit.normal.y, hit.normal.z));
    const s = 0.95 + h * 0.05;
    m.scale.set(s, 1, s);
    (m.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(0.75 - h * 0.035, 0.18, 0.75);
  }

  removeShadow(id: string) {
    const m = this.shadows.get(id);
    if (!m) return;
    this.scene.remove(m);
    (m.material as THREE.Material).dispose();
    this.shadows.delete(id);
  }

  dispose() {
    for (const id of [...this.shadows.keys()]) this.removeShadow(id);
    this.scene.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
    this.shadowTex.dispose();
    this.shadowGeo.dispose();
  }
}
