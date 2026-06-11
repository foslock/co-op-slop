import * as THREE from 'three';
import type { Cosmetics } from 'shared';
import { buildCharacter, type CharacterRig } from './game/characterMesh';

// Tiny rotating character preview used in the lobby.
export class CharacterPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig: CharacterRig | null = null;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement, cosmetics: Cosmetics) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(canvas.clientWidth || 170, canvas.clientHeight || 200, false);
    this.camera = new THREE.PerspectiveCamera(34, 170 / 200, 0.1, 20);
    this.camera.position.set(0, 0.45, 3.1);
    this.camera.lookAt(0, 0.05, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556699, 1.4));
    const dir = new THREE.DirectionalLight(0xfff2d9, 1.8);
    dir.position.set(2, 3, 2);
    this.scene.add(dir);
    this.setCosmetics(cosmetics);
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      if (this.rig) {
        this.rig.group.rotation.y = t * 0.0011;
        this.rig.animate(0, t / 1000, 0, 0);
      }
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setCosmetics(cos: Cosmetics) {
    if (this.rig) {
      this.scene.remove(this.rig.group);
      this.rig.dispose();
    }
    this.rig = buildCharacter(cos);
    this.scene.add(this.rig.group);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.rig) {
      this.scene.remove(this.rig.group);
      this.rig.dispose();
    }
    this.renderer.dispose();
  }
}
