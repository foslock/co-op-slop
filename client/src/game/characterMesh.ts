import * as THREE from 'three';
import { ANIM, COSMETIC_COLORS, type Cosmetics } from 'shared';

export interface CharacterRig {
  group: THREE.Group;
  color: number;
  animate(anim: number, time: number, speed: number, vy: number): void;
  dispose(): void;
}

function makeNameSprite(name: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const c = canvas.getContext('2d')!;
  c.font = 'bold 34px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineWidth = 6;
  c.strokeStyle = 'rgba(0,0,0,0.75)';
  c.strokeText(name, 128, 32);
  c.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  c.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.7, 0.42, 1);
  sprite.position.y = 1.05;
  sprite.renderOrder = 5;
  return sprite;
}

export function buildCharacter(cos: Cosmetics, nameLabel?: string): CharacterRig {
  const color = COSMETIC_COLORS[cos.color % COSMETIC_COLORS.length];
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const geos: THREE.BufferGeometry[] = [];

  const mat = (c: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, ...opts });
    mats.push(m);
    return m;
  };
  const geo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };

  const bodyMat = mat(color);
  const darker = mat(new THREE.Color(color).multiplyScalar(0.72).getHex());

  // body (origin = capsule center; feet at ~-0.62)
  const body = new THREE.Mesh(geo(new THREE.CapsuleGeometry(0.3, 0.45, 6, 14)), bodyMat);
  body.position.y = 0.08;
  body.castShadow = true;
  group.add(body);

  // belly accent
  const belly = new THREE.Mesh(geo(new THREE.SphereGeometry(0.22, 12, 10)), mat(0xffffff, { roughness: 0.9 }));
  belly.position.set(0, -0.02, 0.14);
  belly.scale.set(1, 1.15, 0.55);
  group.add(belly);

  // eyes
  const eyeWhite = mat(0xffffff);
  const eyeBlack = mat(0x1f2125);
  for (const side of [-1, 1]) {
    const e = new THREE.Mesh(geo(new THREE.SphereGeometry(0.085, 10, 8)), eyeWhite);
    e.position.set(side * 0.105, 0.3, 0.245);
    if (cos.eyes === 1) e.scale.y = 0.62; // happy squint
    group.add(e);
    const p = new THREE.Mesh(geo(new THREE.SphereGeometry(0.042, 8, 6)), eyeBlack);
    p.position.set(side * 0.105, cos.eyes === 1 ? 0.285 : 0.3, 0.31);
    group.add(p);
    if (cos.eyes === 2) {
      const lid = new THREE.Mesh(geo(new THREE.BoxGeometry(0.19, 0.085, 0.1)), bodyMat);
      lid.position.set(side * 0.105, 0.355, 0.26);
      lid.rotation.x = 0.25;
      group.add(lid);
    }
  }

  // limbs: pivot groups at shoulders/hips so swing rotates naturally
  const limb = (r: number, len: number, px: number, py: number): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, 0);
    const m = new THREE.Mesh(geo(new THREE.CapsuleGeometry(r, len, 4, 8)), darker);
    m.position.y = -(len / 2 + r * 0.5);
    m.castShadow = true;
    pivot.add(m);
    group.add(pivot);
    return pivot;
  };
  const armL = limb(0.07, 0.2, -0.33, 0.16);
  const armR = limb(0.07, 0.2, 0.33, 0.16);
  const legL = limb(0.09, 0.17, -0.14, -0.3);
  const legR = limb(0.09, 0.17, 0.14, -0.3);

  // hat
  const hatGroup = new THREE.Group();
  hatGroup.position.y = 0.52;
  group.add(hatGroup);
  switch (cos.hat) {
    case 1: { // cap
      const dome = new THREE.Mesh(geo(new THREE.SphereGeometry(0.24, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)), mat(0xe05d5d));
      const brim = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.16, 0.16, 0.04, 10)), mat(0xe05d5d));
      brim.position.set(0, 0.02, 0.3);
      brim.scale.set(1.2, 1, 1.4);
      hatGroup.add(dome, brim);
      break;
    }
    case 2: { // traffic cone
      const cone = new THREE.Mesh(geo(new THREE.ConeGeometry(0.2, 0.42, 12)), mat(0xff7b29));
      cone.position.y = 0.2;
      const stripe = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.13, 0.155, 0.09, 12)), mat(0xffffff));
      stripe.position.y = 0.2;
      hatGroup.add(cone, stripe);
      break;
    }
    case 3: { // crown
      const band = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 10)), mat(0xd4af37, { metalness: 0.6, roughness: 0.3 }));
      band.position.y = 0.06;
      hatGroup.add(band);
      for (let i = 0; i < 5; i++) {
        const spike = new THREE.Mesh(geo(new THREE.ConeGeometry(0.05, 0.13, 4)), mat(0xd4af37, { metalness: 0.6, roughness: 0.3 }));
        const a = (i / 5) * Math.PI * 2;
        spike.position.set(Math.cos(a) * 0.18, 0.18, Math.sin(a) * 0.18);
        hatGroup.add(spike);
      }
      break;
    }
    case 4: { // chef
      const base = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.2, 0.2, 0.18, 12)), mat(0xffffff));
      base.position.y = 0.08;
      const puff = new THREE.Mesh(geo(new THREE.SphereGeometry(0.24, 12, 8)), mat(0xffffff));
      puff.position.y = 0.26;
      puff.scale.y = 0.75;
      hatGroup.add(base, puff);
      break;
    }
    case 5: { // halo
      const halo = new THREE.Mesh(geo(new THREE.TorusGeometry(0.2, 0.035, 8, 20)), mat(0xffe066, { emissive: 0xffd24d, emissiveIntensity: 0.9 }));
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.22;
      hatGroup.add(halo);
      break;
    }
  }

  if (nameLabel) group.add(makeNameSprite(nameLabel, color));

  const animate = (anim: number, time: number, speed: number, vy: number) => {
    if (anim === ANIM.run) {
      const ph = time * Math.min(11, 5 + speed);
      armL.rotation.x = Math.sin(ph) * 0.9;
      armR.rotation.x = -Math.sin(ph) * 0.9;
      legL.rotation.x = -Math.sin(ph) * 0.95;
      legR.rotation.x = Math.sin(ph) * 0.95;
      body.position.y = 0.08 + Math.abs(Math.sin(ph)) * 0.035;
    } else if (anim === ANIM.air) {
      const up = vy > 1;
      armL.rotation.x = up ? -2.6 : -1.4;
      armR.rotation.x = up ? -2.6 : -1.4;
      legL.rotation.x = up ? 0.5 : -0.3;
      legR.rotation.x = up ? 0.2 : -0.55;
    } else if (anim === ANIM.climb) {
      const ph = time * 6;
      armL.rotation.x = -2.4 + Math.sin(ph) * 0.5;
      armR.rotation.x = -2.4 - Math.sin(ph) * 0.5;
      legL.rotation.x = Math.sin(ph) * 0.6;
      legR.rotation.x = -Math.sin(ph) * 0.6;
    } else {
      // idle
      const ph = time * 2.2;
      armL.rotation.x = Math.sin(ph) * 0.08;
      armR.rotation.x = -Math.sin(ph) * 0.08;
      legL.rotation.x = 0;
      legR.rotation.x = 0;
      body.position.y = 0.08 + Math.sin(ph) * 0.012;
    }
  };

  const dispose = () => {
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  };

  return { group, color, animate, dispose };
}
