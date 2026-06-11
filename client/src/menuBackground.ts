import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { COSMETIC_COLORS, EYES, HATS, type Cosmetics } from 'shared';
import { initPhysics } from './game/physics';
import { Ragdoll } from './game/ragdoll';

const FOV = 60;
const GRAVITY = -9; // floatier than in-game for a relaxed menu vibe
const FIXED_DT = 1 / 60;
const MAX_FALLERS = 12;

// Ambient ragdoll beans tumbling down behind the landing-page UI.
// Real physics (same Ragdoll class as the game) in a tiny gravity-only world.
export class MenuBackground {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private world: RAPIER.World | null = null;
  private fallers: { rd: Ragdoll; killY: number }[] = [];
  private spawnTimer: ReturnType<typeof setTimeout> | null = null;
  private clock = new THREE.Clock();
  private acc = 0;
  private disposed = false;
  private onResize = () => {
    if (!this.renderer) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 80);
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
    this.container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', this.onResize);

    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x3a3f6b, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2d9, 1.6);
    sun.position.set(6, 10, 8);
    this.scene.add(sun);

    this.spawnOne();
    this.scheduleNext();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private R: typeof RAPIER | null = null;

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
    const halfH = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * dist;
    const halfW = halfH * this.camera.aspect;
    const pos = new THREE.Vector3((Math.random() * 2 - 1) * halfW * 0.85, halfH + 2.5, -dist);
    const vel = new THREE.Vector3((Math.random() - 0.5) * 1.5, -1.5, 0);
    const rd = new Ragdoll(this.world, this.R, this.scene, pos, vel, cos, 10 * 60 * 1000);
    this.fallers.push({ rd, killY: -halfH - 3 });
  }

  private frame() {
    if (!this.world || !this.renderer) return;
    const dt = Math.min(0.05, this.clock.getDelta());
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
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    if (this.spawnTimer) clearTimeout(this.spawnTimer);
    window.removeEventListener('resize', this.onResize);
    for (const f of this.fallers) f.rd.dispose(this.scene);
    this.fallers = [];
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
