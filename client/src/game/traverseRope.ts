import * as THREE from 'three';
import { TRAVERSE, type Vec3 } from 'shared';

const RADIAL = 5; // sides of the rope tube
const RADIUS = 0.07;
const KNOT = 1.55; // radius multiplier at knot rings
const DAMPING = 0.985;
const ITERATIONS = 8;

/**
 * A slack rope strung between two platform edges, simulated as a verlet string.
 *
 * Both ends are pinned; every node in between falls, swings, and is pulled back
 * by distance constraints, so the rope settles into a catenary and sways when
 * something moves along it. A rider (the local player, hanging at parameter `t`)
 * loads the nearest nodes with extra gravity, which is what makes the rope dip
 * under you and recoil when you let go.
 *
 * This is a purely local simulation — it drives visuals and where the local
 * player's body sits. Remote players are drawn at the positions they broadcast,
 * so nobody has to agree on the exact shape of the string.
 */
export class TraverseRope {
  id: number;
  a = new THREE.Vector3();
  b = new THREE.Vector3();
  deckY: number;
  /** Unit vector from anchor a to anchor b. */
  dir = new THREE.Vector3();
  span: number;
  mesh: THREE.Mesh;

  private nodes: THREE.Vector3[] = [];
  private prev: THREE.Vector3[] = [];
  private segLen: number;
  private geo: THREE.BufferGeometry;
  private riderT: number | null = null;
  private time = 0;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(id: number, a: Vec3, b: Vec3, deckY: number, mat: THREE.Material) {
    this.id = id;
    this.a.set(a.x, a.y, a.z);
    this.b.set(b.x, b.y, b.z);
    this.deckY = deckY;
    this.dir.subVectors(this.b, this.a);
    this.span = this.dir.length();
    this.dir.normalize();
    const n = TRAVERSE.segments;
    this.segLen = (this.span * (1 + TRAVERSE.slack)) / n;

    // start already sagging so the rope doesn't visibly drop on the first frames
    const sag = this.span * TRAVERSE.slack * 1.2;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = this.a.clone().lerp(this.b, t);
      p.y -= Math.sin(t * Math.PI) * sag;
      this.nodes.push(p);
      this.prev.push(p.clone());
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * RADIAL * 3), 3));
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const j2 = (j + 1) % RADIAL;
        const r0 = i * RADIAL;
        const r1 = (i + 1) * RADIAL;
        index.push(r0 + j, r1 + j, r0 + j2, r0 + j2, r1 + j, r1 + j2);
      }
    }
    this.geo.setIndex(index);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.updateGeometry();
  }

  /** Tell the rope a player is hanging at parameter `t` (null when nobody is). */
  setRider(t: number | null) {
    this.riderT = t;
  }

  /** One fixed physics step: integrate, load, then satisfy the distance constraints. */
  step(dt: number, gravityScale = 1) {
    this.time += dt;
    const n = TRAVERSE.segments;
    const g = 22 * gravityScale * dt * dt;
    const riderIdx = this.riderT === null ? -1 : Math.round(this.riderT * n);
    // a slow breeze perpendicular to the span keeps idle ropes alive
    const swayAxis = this.tmpA.set(-this.dir.z, 0, this.dir.x);
    const sway = Math.sin(this.time * 1.3 + this.id) * 0.00035;

    for (let i = 1; i < n; i++) {
      const p = this.nodes[i];
      const q = this.prev[i];
      const vx = (p.x - q.x) * DAMPING;
      const vy = (p.y - q.y) * DAMPING;
      const vz = (p.z - q.z) * DAMPING;
      q.copy(p);
      // nodes right under the rider carry their weight, so the rope dips there
      const load = riderIdx < 0 ? 1 : 1 + 7 / (1 + Math.abs(i - riderIdx) * 2.2);
      p.x += vx + swayAxis.x * sway;
      p.y += vy - g * load;
      p.z += vz + swayAxis.z * sway;
    }

    for (let k = 0; k < ITERATIONS; k++) {
      this.nodes[0].copy(this.a);
      this.nodes[n].copy(this.b);
      for (let i = 0; i < n; i++) {
        const p = this.nodes[i];
        const q = this.nodes[i + 1];
        const d = this.tmpB.subVectors(q, p);
        const len = d.length();
        if (len < 1e-5) continue;
        const push = ((len - this.segLen) / len) * 0.5;
        d.multiplyScalar(push);
        if (i > 0) p.add(d);
        if (i + 1 < n) q.sub(d);
      }
    }
  }

  /** World position of the rope at parameter t (0 = anchor a, 1 = anchor b). */
  pointAt(t: number, out = new THREE.Vector3()): THREE.Vector3 {
    const n = TRAVERSE.segments;
    const f = THREE.MathUtils.clamp(t, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(f));
    return out.lerpVectors(this.nodes[i], this.nodes[i + 1], f - i);
  }

  /** Per-step motion of the rope at t, scaled to m/s — the fling you get on release. */
  velocityAt(t: number, dt: number, out = new THREE.Vector3()): THREE.Vector3 {
    const n = TRAVERSE.segments;
    const i = THREE.MathUtils.clamp(Math.round(t * n), 0, n);
    return out.subVectors(this.nodes[i], this.prev[i]).divideScalar(Math.max(1e-4, dt));
  }

  /** Closest point on the rope to p — used for grabbing on. */
  nearest(p: THREE.Vector3): { t: number; dist: number } {
    const n = TRAVERSE.segments;
    let bestT = 0;
    let bestD = Infinity;
    for (let i = 0; i <= n; i++) {
      const d = this.nodes[i].distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        bestT = i / n;
      }
    }
    return { t: bestT, dist: Math.sqrt(bestD) };
  }

  /** Where a player pulls themselves up when they reach an end. */
  exitPoint(t: number, out = new THREE.Vector3()): THREE.Vector3 {
    const end = t < 0.5 ? this.a : this.b;
    const sign = t < 0.5 ? -1 : 1;
    return out.copy(end).addScaledVector(this.dir, sign * 1.1).setY(this.deckY + 0.35);
  }

  updateGeometry() {
    const n = TRAVERSE.segments;
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const tangent = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const binormal = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= n; i++) {
      const prev = this.nodes[Math.max(0, i - 1)];
      const next = this.nodes[Math.min(n, i + 1)];
      tangent.subVectors(next, prev);
      if (tangent.lengthSq() < 1e-8) tangent.copy(this.dir);
      tangent.normalize();
      normal.crossVectors(tangent, up);
      if (normal.lengthSq() < 1e-6) normal.set(1, 0, 0);
      normal.normalize();
      binormal.crossVectors(normal, tangent).normalize();
      const r = RADIUS * (i % 3 === 1 ? KNOT : 1);
      const c = this.nodes[i];
      for (let j = 0; j < RADIAL; j++) {
        const ang = (j / RADIAL) * Math.PI * 2;
        const cos = Math.cos(ang) * r;
        const sin = Math.sin(ang) * r;
        const o = (i * RADIAL + j) * 3;
        arr[o] = c.x + normal.x * cos + binormal.x * sin;
        arr[o + 1] = c.y + normal.y * cos + binormal.y * sin;
        arr[o + 2] = c.z + normal.z * cos + binormal.z * sin;
      }
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }

  dispose() {
    this.geo.dispose();
  }
}
