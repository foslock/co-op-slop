import * as THREE from 'three';

// Visual hand-holding tethers between players + the spring data for the local player.
export class GrabSystem {
  private pairs = new Map<string, { from: string; target: string }>();
  private lines = new Map<string, THREE.Mesh>();
  private scene: THREE.Scene;
  private geo: THREE.CylinderGeometry;
  private mat: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.geo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
    this.geo.translate(0, 0.5, 0); // pivot at one end so we can stretch a→b
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffe066 });
  }

  set(from: string, target: string, on: boolean) {
    const key = `${from}|${target}`;
    if (on) {
      this.pairs.set(key, { from, target });
    } else {
      this.pairs.delete(key);
      const line = this.lines.get(key);
      if (line) {
        this.scene.remove(line);
        this.lines.delete(key);
      }
    }
  }

  clearFor(playerId: string) {
    for (const key of [...this.pairs.keys()]) {
      const p = this.pairs.get(key)!;
      if (p.from === playerId || p.target === playerId) this.set(p.from, p.target, false);
    }
  }

  /** Is the local player in any tether, and with whom? */
  partnersOf(playerId: string): string[] {
    const out: string[] = [];
    for (const p of this.pairs.values()) {
      if (p.from === playerId) out.push(p.target);
      else if (p.target === playerId) out.push(p.from);
    }
    return out;
  }

  isGrabbing(from: string): string | null {
    for (const p of this.pairs.values()) if (p.from === from) return p.target;
    return null;
  }

  update(getPos: (id: string) => THREE.Vector3 | null) {
    for (const [key, p] of this.pairs) {
      const a = getPos(p.from);
      const b = getPos(p.target);
      if (!a || !b) continue;
      let line = this.lines.get(key);
      if (!line) {
        line = new THREE.Mesh(this.geo, this.mat);
        this.scene.add(line);
        this.lines.set(key, line);
      }
      const from = a.clone();
      from.y += 0.1;
      const to = b.clone();
      to.y += 0.1;
      const d = to.clone().sub(from);
      const len = Math.max(0.01, d.length());
      line.position.copy(from);
      line.scale.set(1, len, 1);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    }
  }

  dispose() {
    for (const line of this.lines.values()) this.scene.remove(line);
    this.lines.clear();
    this.pairs.clear();
    this.geo.dispose();
    this.mat.dispose();
  }
}
