import * as THREE from 'three';
import { TRAVERSE, type Vec3 } from 'shared';

const RADIAL = 5; // sides of the rope tube
const RADIUS = 0.07;
const KNOT = 1.55; // radius multiplier at knot rings
const DAMPING = 0.985;
const ITERATIONS = 8;
const SEGMENTS = TRAVERSE.segments;

export type RopeKind =
  | 'span' // strung between two platform edges: both ends pinned, sags in the middle
  | 'hang'; // dangling from a single anchor: top pinned, free end swings

/**
 * A rope simulated as a verlet string, used for both the slack ropes strung
 * across gaps and the vertical ropes you climb (including grappling-hook ropes).
 *
 * Every node integrates under gravity and is pulled back into place by distance
 * constraints, so the rope hangs in a catenary, sways, and swings like a real
 * one. A rider — the player gripping it at parameter `s` — loads the nodes
 * nearest their hands with extra weight and hands over their momentum when they
 * catch it, which is what makes a rope dip under you, swing when you jump on,
 * and carry you along as it moves.
 *
 * The simulation is local to each client: it drives visuals and where the local
 * player's body sits. Remote players are drawn at the positions they broadcast,
 * so no two clients need to agree on the exact shape of the string.
 */
export class Rope {
  id: number;
  kind: RopeKind;
  /** Anchor: the near edge for a span, the top knot for a hanging rope. */
  a = new THREE.Vector3();
  /** Far anchor for a span; the resting free end for a hanging rope. */
  b = new THREE.Vector3();
  /** Unit vector a → b at rest. */
  dir = new THREE.Vector3();
  /** Straight-line distance between the anchors. */
  span: number;
  /** Platform surface height at both ends (span ropes only). */
  deckY: number;
  /** Where to step off when topping out a hanging rope. */
  exitDir: THREE.Vector3 | null = null;
  mesh: THREE.Mesh;

  private nodes: THREE.Vector3[] = [];
  private prev: THREE.Vector3[] = [];
  private segLen: number;
  private geo: THREE.BufferGeometry;
  private riderS: number | null = null;
  private time = 0;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(id: number, kind: RopeKind, a: Vec3, b: Vec3, deckY: number, mat: THREE.Material) {
    this.id = id;
    this.kind = kind;
    this.a.set(a.x, a.y, a.z);
    this.b.set(b.x, b.y, b.z);
    this.deckY = deckY;
    this.dir.subVectors(this.b, this.a);
    this.span = this.dir.length();
    this.dir.normalize();
    // span ropes carry slack so they sag into the gap; a hanging rope is taut
    this.segLen = (this.span * (1 + (kind === 'span' ? TRAVERSE.slack : 0))) / SEGMENTS;

    const sag = kind === 'span' ? this.span * TRAVERSE.slack * 1.2 : 0;
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const p = this.a.clone().lerp(this.b, t);
      p.y -= Math.sin(t * Math.PI) * sag;
      this.nodes.push(p);
      this.prev.push(p.clone());
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * RADIAL * 3), 3));
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
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

  /** Tell the rope someone is gripping it at parameter `s` (null when nobody is). */
  setRider(s: number | null) {
    this.riderS = s;
  }

  /** Hand the rope some momentum at `s` — a player catching it sets it swinging. */
  nudge(s: number, vel: THREE.Vector3, dt = 1 / 60) {
    const idx = Math.round(THREE.MathUtils.clamp(s, 0, 1) * SEGMENTS);
    for (let i = Math.max(1, idx - 2); i <= Math.min(SEGMENTS, idx + 2); i++) {
      const falloff = 1 - Math.abs(i - idx) / 3;
      this.prev[i].addScaledVector(vel, -dt * falloff * 0.5);
    }
  }

  /** One fixed physics step: integrate, load, then satisfy the distance constraints. */
  step(dt: number, gravityScale = 1) {
    this.time += dt;
    const last = this.kind === 'span' ? SEGMENTS - 1 : SEGMENTS; // free end on a hanging rope
    const g = 22 * gravityScale * dt * dt;
    const riderIdx = this.riderS === null ? -1 : Math.round(this.riderS * SEGMENTS);
    // a slow breeze perpendicular to the rope keeps idle ropes alive
    const swayAxis = this.tmpA.set(-this.dir.z, 0, this.dir.x);
    if (swayAxis.lengthSq() < 1e-6) swayAxis.set(1, 0, 0);
    const sway = Math.sin(this.time * 1.3 + this.id) * 0.00035;

    for (let i = 1; i <= last; i++) {
      const p = this.nodes[i];
      const q = this.prev[i];
      const vx = (p.x - q.x) * DAMPING;
      const vy = (p.y - q.y) * DAMPING;
      const vz = (p.z - q.z) * DAMPING;
      q.copy(p);
      // nodes under the rider carry their weight, so the rope dips and swings there
      const load = riderIdx < 0 ? 1 : 1 + 7 / (1 + Math.abs(i - riderIdx) * 2.2);
      p.x += vx + swayAxis.x * sway;
      p.y += vy - g * load;
      p.z += vz + swayAxis.z * sway;
    }

    for (let k = 0; k < ITERATIONS; k++) {
      this.nodes[0].copy(this.a);
      if (this.kind === 'span') this.nodes[SEGMENTS].copy(this.b);
      for (let i = 0; i < SEGMENTS; i++) {
        const p = this.nodes[i];
        const q = this.nodes[i + 1];
        const d = this.tmpB.subVectors(q, p);
        const len = d.length();
        if (len < 1e-5) continue;
        const push = ((len - this.segLen) / len) * 0.5;
        d.multiplyScalar(push);
        if (i > 0) p.add(d);
        if (i + 1 <= last) q.sub(d);
      }
    }
  }

  /** World position of the rope at parameter s (0 = anchor a, 1 = the far/free end). */
  pointAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = THREE.MathUtils.clamp(s, 0, 1) * SEGMENTS;
    const i = Math.min(SEGMENTS - 1, Math.floor(f));
    return out.lerpVectors(this.nodes[i], this.nodes[i + 1], f - i);
  }

  /** Per-step motion of the rope at s, in m/s — the fling you get on release. */
  velocityAt(s: number, dt: number, out = new THREE.Vector3()): THREE.Vector3 {
    const i = THREE.MathUtils.clamp(Math.round(s * SEGMENTS), 0, SEGMENTS);
    return out.subVectors(this.nodes[i], this.prev[i]).divideScalar(Math.max(1e-4, dt));
  }

  /** Closest point on the rope to p — used for grabbing on. */
  nearest(p: THREE.Vector3): { s: number; dist: number } {
    let bestS = 0;
    let bestD = Infinity;
    for (let i = 0; i <= SEGMENTS; i++) {
      const d = this.nodes[i].distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        bestS = i / SEGMENTS;
      }
    }
    return { s: bestS, dist: Math.sqrt(bestD) };
  }

  /** Span ropes: where you haul yourself up when you reach an end. */
  exitPoint(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const end = s < 0.5 ? this.a : this.b;
    const sign = s < 0.5 ? -1 : 1;
    return out.copy(end).addScaledVector(this.dir, sign * 1.1).setY(this.deckY + 0.35);
  }

  updateGeometry() {
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const tangent = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const binormal = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i <= SEGMENTS; i++) {
      const prev = this.nodes[Math.max(0, i - 1)];
      const next = this.nodes[Math.min(SEGMENTS, i + 1)];
      tangent.subVectors(next, prev);
      if (tangent.lengthSq() < 1e-8) tangent.copy(this.dir);
      tangent.normalize();
      // a vertical rope's tangent is parallel to world up, so fall back to a
      // fixed side vector rather than producing a degenerate frame
      normal.crossVectors(tangent, Math.abs(tangent.y) > 0.99 ? side : up);
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
