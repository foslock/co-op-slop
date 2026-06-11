import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_LEVEL, GROUP_PLAYER, groups } from './physics';
import type { Input } from '../input';

const SENS = 0.0024;
const DIST = 5.6;
const BASE_FOV = 72;
const ZOOM_FOV = 20;

export class FollowCamera {
  camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = -0.25;
  zoom = 0; // 0..1 telescope zoom blend
  private world: RAPIER.World;
  private R: typeof RAPIER;
  private smoothTarget = new THREE.Vector3();
  private initialized = false;

  constructor(world: RAPIER.World, R: typeof RAPIER, aspect: number) {
    this.world = world;
    this.R = R;
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.1, 600);
  }

  /** Horizontal camera-relative movement basis. */
  basis(): { forward: THREE.Vector3; right: THREE.Vector3 } {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    return { forward, right };
  }

  aimDir(): THREE.Vector3 {
    return new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
  }

  update(dt: number, target: THREE.Vector3, input: Input, excludeBody: RAPIER.RigidBody, zoomActive: boolean) {
    const { dx, dy } = input.consumeMouse();
    const sens = SENS * (1 - this.zoom * 0.8);
    this.yaw -= dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, -1.25, 1.05);

    this.zoom += ((zoomActive ? 1 : 0) - this.zoom) * Math.min(1, 9 * dt);
    this.camera.fov = THREE.MathUtils.lerp(BASE_FOV, ZOOM_FOV, this.zoom);
    this.camera.updateProjectionMatrix();

    if (!this.initialized) {
      this.smoothTarget.copy(target);
      this.initialized = true;
    }
    this.smoothTarget.lerp(target, Math.min(1, 18 * dt));
    const head = this.smoothTarget.clone();
    head.y += 0.45;

    const dir = this.aimDir().negate(); // from head toward camera
    let dist = DIST * (1 - this.zoom * 0.85);
    const ray = new this.R.Ray({ x: head.x, y: head.y, z: head.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRay(ray, dist + 0.3, true, undefined, groups(GROUP_PLAYER, GROUP_LEVEL), undefined, excludeBody);
    if (hit) dist = Math.max(0.6, hit.timeOfImpact - 0.3);

    this.camera.position.copy(head).addScaledVector(dir, dist);
    this.camera.lookAt(head);
  }
}
