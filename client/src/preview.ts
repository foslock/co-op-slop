import * as THREE from 'three';
import type { Cosmetics } from 'shared';
import { buildCharacter, type CharacterRig } from './game/characterMesh';

const FEET_Y = -0.66; // bottom of the bean's feet in rig space
const AUTO_SPIN = 0.55; // rad/s when nobody is dragging

// Lobby turntable: the player's bean on a little toy podium, gently spinning.
// Drag to spin it yourself; changing cosmetics gives it a happy hop.
export class CharacterPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig: CharacterRig | null = null;
  private raf = 0;
  private canvas: HTMLCanvasElement;
  private stage = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private yaw = 0.5;
  private spinVel = AUTO_SPIN;
  private dragging = false;
  private lastX = 0;
  private hopStart = -1;
  private lastT = 0;
  private reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  private resizeObs: ResizeObserver | null = null;

  private onDown = (e: PointerEvent) => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    this.lastX = e.clientX;
    this.yaw += dx * 0.012;
    this.spinVel = dx * 0.6; // flick momentum, eased back to the idle spin
  };
  private onUp = (e: PointerEvent) => {
    this.dragging = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
  };

  constructor(canvas: HTMLCanvasElement, cosmetics: Cosmetics) {
    this.canvas = canvas;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 236;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(w, h, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    // frame the bean (feet ~-0.66, halo ~0.85) plus the podium below it
    this.camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 20);
    this.camera.position.set(0, 0.32, 3.7);
    this.camera.lookAt(0, -0.04, 0);

    // toy-photo lighting: warm key, cool rim from behind, soft sky/ground fill
    this.scene.add(new THREE.HemisphereLight(0xe4ecff, 0x40306f, 1.15));
    const key = new THREE.DirectionalLight(0xffe7c4, 2.3);
    key.position.set(2.2, 3, 2.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xa9b8ff, 2.2);
    rim.position.set(-2.4, 1.6, -2.6);
    this.scene.add(rim);
    const under = new THREE.PointLight(0xffc96b, 1.4, 3, 2);
    under.position.set(0, FEET_Y - 0.05, 0.9);
    this.scene.add(under);

    this.buildPodium();
    this.scene.add(this.stage);
    this.setCosmetics(cosmetics, false);

    // keep the drawing buffer matched to the CSS box (the stage is fluid on narrow screens)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        if (!cw || !ch) return;
        this.renderer.setSize(cw, ch, false);
        this.camera.aspect = cw / ch;
        this.camera.updateProjectionMatrix();
      });
      this.resizeObs.observe(canvas);
    }

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);

    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 0;
      this.lastT = t;
      const idle = this.reduced ? AUTO_SPIN * 0.4 : AUTO_SPIN;
      if (!this.dragging) {
        this.spinVel += (idle - this.spinVel) * Math.min(1, dt * 2.5);
        this.yaw += this.spinVel * dt;
      }
      if (this.rig) {
        this.rig.group.rotation.y = this.yaw;
        this.rig.animate(0, t / 1000, 0, 0);
        // a little celebratory hop + squash whenever the outfit changes
        let y = 0;
        let sq = 1;
        if (this.hopStart >= 0) {
          const k = (t - this.hopStart) / 420;
          if (k >= 1) this.hopStart = -1;
          else {
            y = Math.sin(k * Math.PI) * 0.16;
            sq = 1 + Math.sin(k * Math.PI * 2) * 0.06;
          }
        }
        this.rig.group.position.y = y;
        this.rig.group.scale.set(2 - sq, sq, 2 - sq);
      }
      this.stage.rotation.y = this.yaw * 0.25;
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private buildPodium() {
    const track = <T extends { dispose(): void }>(o: T): T => {
      this.disposables.push(o);
      return o;
    };
    const topY = FEET_Y - 0.01;
    const baseMat = track(new THREE.MeshStandardMaterial({ color: 0x3a3f9c, roughness: 0.55 }));
    const base = new THREE.Mesh(track(new THREE.CylinderGeometry(0.62, 0.7, 0.18, 48)), baseMat);
    base.position.y = topY - 0.09;
    this.stage.add(base);
    const trimMat = track(new THREE.MeshStandardMaterial({ color: 0xffd24d, roughness: 0.35, emissive: 0x6b4a00, emissiveIntensity: 0.35 }));
    const trim = new THREE.Mesh(track(new THREE.TorusGeometry(0.625, 0.025, 10, 64)), trimMat);
    trim.rotation.x = Math.PI / 2;
    trim.position.y = topY;
    this.stage.add(trim);
    // candy dots around the rim, so the spin reads even on a plain podium
    const dotGeo = track(new THREE.SphereGeometry(0.035, 10, 8));
    const dotColors = [0xff7a7a, 0x69db7c, 0x4dabf7, 0x9775fa];
    const dotMats = dotColors.map((c) => track(new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, emissive: c, emissiveIntensity: 0.25 })));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const d = new THREE.Mesh(dotGeo, dotMats[i % dotMats.length]);
      d.position.set(Math.cos(a) * 0.67, topY - 0.1, Math.sin(a) * 0.67);
      this.stage.add(d);
    }
    // soft contact shadow under the feet
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(8,6,30,0.55)');
    grad.addColorStop(1, 'rgba(8,6,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = track(new THREE.CanvasTexture(c));
    const shadow = new THREE.Mesh(
      track(new THREE.PlaneGeometry(0.95, 0.95)),
      track(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = topY + 0.003;
    this.scene.add(shadow);
  }

  setCosmetics(cos: Cosmetics, hop = true) {
    if (this.rig) {
      this.scene.remove(this.rig.group);
      this.rig.dispose();
    }
    this.rig = buildCharacter(cos);
    this.rig.group.rotation.y = this.yaw;
    this.scene.add(this.rig.group);
    if (hop && !this.reduced) this.hopStart = performance.now();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    if (this.rig) {
      this.scene.remove(this.rig.group);
      this.rig.dispose();
    }
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
  }
}
