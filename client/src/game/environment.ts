import * as THREE from 'three';

// Sky color stops from ground level (0) to the summit (1).
const SKY_STOPS: [number, THREE.Color][] = [
  [0.0, new THREE.Color(0x8ecdf0)],
  [0.3, new THREE.Color(0x6fb0e8)],
  [0.55, new THREE.Color(0x3f6db5)],
  [0.75, new THREE.Color(0x1c2c5e)],
  [0.9, new THREE.Color(0x0a0f24)],
  [1.0, new THREE.Color(0x03040a)],
];

function skyColorAt(f: number, out: THREE.Color) {
  for (let i = 1; i < SKY_STOPS.length; i++) {
    if (f <= SKY_STOPS[i][0]) {
      const [f0, c0] = SKY_STOPS[i - 1];
      const [f1, c1] = SKY_STOPS[i];
      out.lerpColors(c0, c1, (f - f0) / (f1 - f0));
      return;
    }
  }
  out.copy(SKY_STOPS[SKY_STOPS.length - 1][1]);
}

export class Environment {
  private scene: THREE.Scene;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private stars: THREE.Points;
  private starsMat: THREE.PointsMaterial;
  private bg = new THREE.Color();
  private fog: THREE.Fog;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.fog = new THREE.Fog(0x8ecdf0, 45, 150);
    scene.fog = this.fog;

    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b6250, 0.85);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2d9, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 120;
    const s = 32;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0008;
    scene.add(this.sun, this.sun.target);

    // star shell, faded in as you climb
    const starGeo = new THREE.BufferGeometry();
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(220 + Math.random() * 160);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = Math.abs(v.y) * (Math.random() < 0.85 ? 1 : -0.3);
      pos[i * 3 + 2] = v.z;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.frustumCulled = false;
    scene.add(this.stars);
    this.disposables.push(starGeo, this.starsMat);
  }

  update(playerPos: THREE.Vector3, totalHeight: number) {
    const f = THREE.MathUtils.clamp(playerPos.y / Math.max(1, totalHeight), 0, 1);
    skyColorAt(f, this.bg);
    this.scene.background = this.bg;
    this.fog.color.copy(this.bg);
    this.fog.near = 45 + f * 30;
    this.fog.far = 150 + f * 80;

    this.starsMat.opacity = THREE.MathUtils.smoothstep(f, 0.55, 0.85);
    this.stars.position.copy(playerPos);

    // light cools and dims slightly as the air thins
    this.sun.intensity = 2.2 - f * 0.6;
    this.hemi.intensity = 0.85 - f * 0.45;
    this.sun.color.setHSL(0.12 - f * 0.04, 0.55, 0.92 - f * 0.12);

    // keep the shadow frustum centered on the player
    this.sun.position.set(playerPos.x + 18, playerPos.y + 32, playerPos.z + 12);
    this.sun.target.position.copy(playerPos);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.scene.remove(this.stars, this.sun, this.hemi, this.sun.target);
  }
}
