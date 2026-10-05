import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { COSMETIC_COLORS, EYES, HATS, type Cosmetics } from 'shared';
import { initPhysics } from './game/physics';
import { Ragdoll } from './game/ragdoll';

const FOV = 60;
const GRAVITY = -9; // floatier than in-game for a relaxed menu vibe
const FIXED_DT = 1 / 60;
const MAX_FALLERS = 12;
const CLOUDS = 9;
const STARS = 7;
const LOOK_AT = new THREE.Vector3(0, 0, -20);

interface Cloud {
  group: THREE.Group;
  speed: number;
  bobPhase: number;
  baseY: number;
  wrapX: number;
}

interface Twinkle {
  mesh: THREE.Mesh;
  spin: number;
  phase: number;
  baseY: number;
}

// Ambient ragdoll beans tumbling down behind the landing-page UI, through a
// sleepy night sky of puffy clouds and a few floating toy stars.
// Real physics (same Ragdoll class as the game) in a tiny gravity-only world.
export class MenuBackground {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private world: RAPIER.World | null = null;
  private R: typeof RAPIER | null = null;
  private fallers: { rd: Ragdoll; killY: number }[] = [];
  private clouds: Cloud[] = [];
  private stars: Twinkle[] = [];
  private disposables: { dispose(): void }[] = [];
  private spawnTimer: ReturnType<typeof setTimeout> | null = null;
  private clock = new THREE.Clock();
  private acc = 0;
  private time = 0;
  private disposed = false;
  private reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  private pointer = new THREE.Vector2();
  private parallax = new THREE.Vector2();
  private onResize = () => {
    if (!this.renderer) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };
  private onPointer = (e: PointerEvent) => {
    this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 90);
  }

  async start() {
    const R = await initPhysics();
    if (this.disposed) return;
    this.world = new R.World({ x: 0, y: GRAVITY, z: 0 });
    this.R = R;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', this.onResize);
    if (!this.reduced) window.addEventListener('pointermove', this.onPointer, { passive: true });

    // far things sink into the night-sky navy, which reads as depth
    this.scene.fog = new THREE.Fog(0x161c4e, 16, 64);
    this.scene.add(new THREE.HemisphereLight(0xd8e4ff, 0x2c2466, 1.05));
    const sun = new THREE.DirectionalLight(0xffe2b5, 1.9);
    sun.position.set(6, 10, 8);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x92a9ff, 1.3);
    rim.position.set(-8, 3, -10);
    this.scene.add(rim);

    this.buildClouds();
    this.buildStars();
    this.camera.lookAt(LOOK_AT);

    this.spawnOne();
    this.scheduleNext();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private track<T extends { dispose(): void }>(o: T): T {
    this.disposables.push(o);
    return o;
  }

  /** Visible half-extents of the view at a given distance in front of the camera. */
  private halfExtents(dist: number): { halfW: number; halfH: number } {
    const halfH = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * dist;
    return { halfW: halfH * this.camera.aspect, halfH };
  }

  private buildClouds() {
    const puff = this.track(new THREE.IcosahedronGeometry(1, 3));
    const mat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xdfe3ff, roughness: 1, emissive: 0x343a86, emissiveIntensity: 0.5 }),
    );
    for (let i = 0; i < CLOUDS; i++) {
      const group = new THREE.Group();
      // a wide flat base row plus one or two big puffs on top, like a toy cloud
      const base = 3 + Math.floor(Math.random() * 2);
      for (let b = 0; b < base; b++) {
        const m = new THREE.Mesh(puff, mat);
        const t = b / (base - 1) - 0.5;
        const r = 0.85 + Math.random() * 0.25 - Math.abs(t) * 0.3;
        m.scale.set(r * 1.25, r * 0.7, r);
        m.position.set(t * base * 1.15, 0, (Math.random() - 0.5) * 0.5);
        group.add(m);
      }
      const tops = 1 + Math.floor(Math.random() * 2);
      for (let k = 0; k < tops; k++) {
        const m = new THREE.Mesh(puff, mat);
        const r = 1.05 + Math.random() * 0.35;
        m.scale.set(r, r * 0.9, r * 0.85);
        m.position.set((tops === 1 ? 0 : (k - 0.5) * 1.5) + (Math.random() - 0.5) * 0.6, 0.65 + Math.random() * 0.2, 0.1);
        group.add(m);
      }
      // a flat-ish underside so they sit like toy clouds
      group.scale.set(1, 0.9, 0.7);
      const dist = 24 + Math.random() * 26;
      const { halfW, halfH } = this.halfExtents(dist);
      const baseY = (Math.random() * 2 - 1) * halfH * 0.85;
      group.position.set((Math.random() * 2 - 1) * halfW, baseY, -dist);
      const s = 0.8 + Math.random() * 0.9;
      group.scale.multiplyScalar(s);
      this.scene.add(group);
      this.clouds.push({ group, speed: 0.25 + Math.random() * 0.45, bobPhase: Math.random() * Math.PI * 2, baseY, wrapX: halfW + 9 * s });
    }
  }

  private buildStars() {
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
      const r = i % 2 === 0 ? 0.5 : 0.22;
      if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    shape.closePath();
    const geo = this.track(
      new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 2 }),
    );
    geo.center();
    const colors = [0xffd24d, 0xffe08a, 0xff9f9f, 0x9fe8ae, 0xa9d4ff, 0xc3b0ff];
    for (let i = 0; i < STARS; i++) {
      const c = colors[i % colors.length];
      const mat = this.track(new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.1 }));
      const mesh = new THREE.Mesh(geo, mat);
      const dist = 12 + Math.random() * 16;
      const { halfW, halfH } = this.halfExtents(dist);
      // keep them off the centre column, where the home panel sits
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (0.45 + Math.random() * 0.5) * halfW;
      const y = (Math.random() * 2 - 1) * halfH * 0.8;
      mesh.position.set(x, y, -dist);
      mesh.scale.setScalar(0.55 + Math.random() * 0.6);
      mesh.rotation.set(Math.random() * 0.6, Math.random() * Math.PI, Math.random() * Math.PI);
      this.scene.add(mesh);
      this.stars.push({ mesh, spin: (0.3 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1), phase: Math.random() * Math.PI * 2, baseY: y });
    }
  }

  private scheduleNext() {
    this.spawnTimer = setTimeout(() => {
      this.spawnOne();
      this.scheduleNext();
    }, 2000 + Math.random() * 3000);
  }

  private spawnOne() {
    if (!this.world || !this.R) return;
    if (this.fallers.length >= MAX_FALLERS) {
      const oldest = this.fallers.shift();
      oldest?.rd.dispose(this.scene);
    }
    const cos: Cosmetics = {
      color: Math.floor(Math.random() * COSMETIC_COLORS.length),
      hat: Math.floor(Math.random() * HATS.length),
      eyes: Math.floor(Math.random() * EYES.length),
    };
    // random distance from the viewer; spawn just above the visible frustum there
    const dist = 7 + Math.random() * 24;
    const { halfW, halfH } = this.halfExtents(dist);
    const pos = new THREE.Vector3((Math.random() * 2 - 1) * halfW * 0.85, halfH + 2.5, -dist);
    const vel = new THREE.Vector3((Math.random() - 0.5) * 1.5, -1.5, 0);
    const rd = new Ragdoll(this.world, this.R, this.scene, pos, vel, cos, 10 * 60 * 1000);
    this.fallers.push({ rd, killY: -halfH - 3 });
  }

  private frame() {
    if (!this.world || !this.renderer) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.acc = Math.min(0.12, this.acc + dt);
    while (this.acc >= FIXED_DT) {
      this.acc -= FIXED_DT;
      this.world.step();
    }
    for (let i = this.fallers.length - 1; i >= 0; i--) {
      const f = this.fallers[i];
      f.rd.sync();
      if (f.rd.torsoPos().y < f.killY) {
        f.rd.dispose(this.scene);
        this.fallers.splice(i, 1);
      }
    }

    if (!this.reduced) {
      for (const c of this.clouds) {
        const p = c.group.position;
        p.x += c.speed * dt;
        if (p.x > c.wrapX) p.x = -c.wrapX;
        p.y = c.baseY + Math.sin(this.time * 0.25 + c.bobPhase) * 0.4;
      }
      for (const s of this.stars) {
        s.mesh.rotation.y += s.spin * dt;
        s.mesh.position.y = s.baseY + Math.sin(this.time * 0.6 + s.phase) * 0.35;
      }
      // soft parallax: the camera leans a touch toward the pointer
      this.parallax.lerp(this.pointer, Math.min(1, dt * 2));
      this.camera.position.set(this.parallax.x * 0.9, -this.parallax.y * 0.55, 0);
      this.camera.lookAt(LOOK_AT);
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    if (this.spawnTimer) clearTimeout(this.spawnTimer);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointer);
    for (const f of this.fallers) f.rd.dispose(this.scene);
    this.fallers = [];
    for (const c of this.clouds) this.scene.remove(c.group);
    for (const s of this.stars) this.scene.remove(s.mesh);
    this.clouds = [];
    this.stars = [];
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.world?.free();
    this.world = null;
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }
}
