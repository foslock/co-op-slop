import * as THREE from 'three';
import { ANIM, COSMETIC_COLORS, type Cosmetics } from 'shared';

/**
 * Where every piece of the character is right now, in world space relative to
 * the rig's origin. Handing this to a ragdoll lets it start in exactly the pose
 * the animated rig was in, so a knockdown doesn't visibly snap.
 */
export interface RigPose {
  quat: THREE.Quaternion; // torso orientation (yaw plus any animation lean)
  limbs: { pos: THREE.Vector3; quat: THREE.Quaternion }[]; // armL, armR, legL, legR
}

export interface CharacterRig {
  group: THREE.Group;
  color: number;
  animate(anim: number, time: number, speed: number, vy: number): void;
  /** Snapshot of the current pose, for handing off to a ragdoll. */
  pose(): RigPose;
  /** Fade the whole rig (1 = solid, 0 = hidden) — used for telescope zoom. */
  setOpacity(o: number): void;
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

/**
 * Builds the bean character. With `withLimbs: false` it returns just the core
 * (body, belly, eyes, hat) — used as the ragdoll torso so knockdowns keep the
 * same blobby look instead of swapping to generic shapes.
 */
export function buildCharacter(cos: Cosmetics, nameLabel?: string, withLimbs = true): CharacterRig {
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
  const darkest = mat(new THREE.Color(color).multiplyScalar(0.58).getHex());

  // Everything below the root can lean, bob and squash without disturbing the
  // group transform the game owns (position + yaw) or the name label.
  const root = new THREE.Group();
  group.add(root);

  // Body: one lathed silhouette rather than a capsule with shapes bolted on.
  // The profile (radius against height) carries all the definition — wide hips,
  // a waist, a soft neck dip and a rounded head — so the surface stays smooth
  // and there are no seams or bulges where parts would otherwise overlap.
  const BODY_PROFILE: [number, number][] = [
    [0.02, -0.450], // the body stops here so the legs actually show below it
    [0.150, -0.432],
    [0.232, -0.395],
    [0.276, -0.330],
    [0.293, -0.245], // widest — hips
    [0.293, -0.140],
    [0.281, -0.020],
    [0.268, 0.080], // waist
    [0.258, 0.150],
    [0.244, 0.200], // neck dip
    [0.254, 0.250],
    [0.272, 0.310], // head, where the face sits
    [0.266, 0.380],
    [0.248, 0.440],
    [0.205, 0.500],
    [0.140, 0.550],
    [0.02, 0.575],
  ];
  const body = new THREE.Mesh(
    geo(new THREE.LatheGeometry(BODY_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 22)),
    bodyMat,
  );
  body.castShadow = true;
  root.add(body);

  // eyes
  const eyeWhite = mat(0xffffff);
  const eyeBlack = mat(0x1f2125);
  const eyeMeshes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const e = new THREE.Mesh(geo(new THREE.SphereGeometry(0.085, 10, 8)), eyeWhite);
    e.position.set(side * 0.105, 0.3, 0.245);
    if (cos.eyes === 1) e.scale.y = 0.62; // happy squint
    root.add(e);
    eyeMeshes.push(e);
    const p = new THREE.Mesh(geo(new THREE.SphereGeometry(0.042, 8, 6)), eyeBlack);
    p.position.set(side * 0.105, cos.eyes === 1 ? 0.285 : 0.3, 0.31);
    root.add(p);
    eyeMeshes.push(p);
    if (cos.eyes === 2) {
      const lid = new THREE.Mesh(geo(new THREE.BoxGeometry(0.19, 0.085, 0.1)), bodyMat);
      lid.position.set(side * 0.105, 0.355, 0.26);
      lid.rotation.x = 0.25;
      root.add(lid);
    }
  }
  const eyeBaseY = eyeMeshes.map((m) => m.scale.y);

  // limbs: pivot groups at shoulders/hips so swing rotates naturally, each
  // capped with a hand or a foot so the ends read at a glance
  const limb = (r: number, len: number, px: number, py: number, foot: boolean): { pivot: THREE.Group; end: THREE.Mesh } => {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, 0);
    const m = new THREE.Mesh(geo(new THREE.CapsuleGeometry(r, len, 4, 8)), darker);
    m.position.y = -(len / 2 + r * 0.5);
    m.castShadow = true;
    pivot.add(m);
    const endGeo = foot
      ? geo(new THREE.SphereGeometry(r * 1.5, 10, 8))
      : geo(new THREE.SphereGeometry(r * 1.2, 10, 8));
    const end = new THREE.Mesh(endGeo, darkest);
    end.position.y = -(len + r * 0.9);
    if (foot) {
      end.scale.set(1.0, 0.62, 1.45);
      end.position.z = 0.05;
    }
    end.castShadow = true;
    pivot.add(end);
    root.add(pivot);
    return { pivot, end };
  };
  let armL: THREE.Group | null = null;
  let armR: THREE.Group | null = null;
  let legL: THREE.Group | null = null;
  let legR: THREE.Group | null = null;
  let footL: THREE.Mesh | null = null;
  let footR: THREE.Mesh | null = null;
  if (withLimbs) {
    ({ pivot: armL } = limb(0.07, 0.2, -0.29, 0.17, false));
    ({ pivot: armR } = limb(0.07, 0.2, 0.29, 0.17, false));
    ({ pivot: legL, end: footL } = limb(0.09, 0.19, -0.135, -0.30, true));
    ({ pivot: legR, end: footR } = limb(0.09, 0.19, 0.135, -0.30, true));
  }

  // hat
  const hatGroup = new THREE.Group();
  hatGroup.position.y = 0.52;
  root.add(hatGroup);
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

  // Damped state so poses ease between each other instead of snapping — most
  // visibly at the top of a jump, where vy crosses from rising to falling.
  let lastTime = 0;
  let airBlend = 0; // 0 = falling pose, 1 = rising pose
  let stretch = 1; // current body stretch, chased toward the pose's target

  const animate = (anim: number, time: number, speed: number, vy: number) => {
    const dt = THREE.MathUtils.clamp(time - lastTime, 0, 0.1);
    lastTime = time;
    const ease = 1 - Math.exp(-dt * 9); // frame-rate independent smoothing

    // blink on a lazy cycle — cheap, and it stops the face reading as a mask
    if (cos.eyes !== 1) {
      const blink = (time % 3.6) < 0.11 ? 0.12 : 1;
      eyeMeshes.forEach((m, i) => { m.scale.y = eyeBaseY[i] * blink; });
    }
    if (!armL || !armR || !legL || !legR || !footL || !footR) return;

    const lerp = THREE.MathUtils.lerp;
    let stretchTarget = 1;

    if (anim === ANIM.run) {
      const ph = time * Math.min(11, 5 + speed);
      const swing = Math.sin(ph);
      const lean = Math.min(0.26, speed * 0.035);
      armL.rotation.x = swing * 0.95;
      armR.rotation.x = -swing * 0.95;
      armL.rotation.z = 0.12;
      armR.rotation.z = -0.12;
      // legs lift at the front of the stride and the feet flick up behind
      legL.rotation.x = -swing * 1.0;
      legR.rotation.x = swing * 1.0;
      footL.rotation.x = Math.max(0, -swing) * 0.8;
      footR.rotation.x = Math.max(0, swing) * 0.8;
      body.position.y = Math.abs(swing) * 0.04;
      root.position.y = Math.abs(Math.sin(ph)) * 0.035;
      root.rotation.x = lean;                    // lean into the run
      root.rotation.z = Math.sin(ph) * 0.05;     // and roll a little with each step
      root.rotation.y = Math.sin(ph) * 0.07;     // shoulders counter-rotate
    } else if (anim === ANIM.air) {
      // Rising and falling are two poses blended by vy rather than switched
      // between, and the blend itself is damped, so going over the apex reads
      // as the body easing from a stretched leap into a bracing fall.
      airBlend += (THREE.MathUtils.smoothstep(vy, -5, 5) - airBlend) * ease;
      const b = airBlend;
      armL.rotation.x = lerp(-1.4, -2.6, b);
      armR.rotation.x = lerp(-1.4, -2.6, b);
      // Z swings a limb toward the body's centre line, so the left arm needs a
      // negative angle to spread outward — with both positive the hands end up
      // crossed over the chest and clip through it.
      armL.rotation.z = -lerp(0.75, 0.45, b);
      armR.rotation.z = lerp(0.75, 0.45, b);
      legL.rotation.x = lerp(-0.35, 0.55, b);
      legR.rotation.x = lerp(-0.6, 0.2, b);
      footL.rotation.x = lerp(0, 0.5, b);
      footR.rotation.x = lerp(0, 0.5, b);
      root.position.y = 0;
      root.rotation.set(lerp(0.14, -0.12, b), 0, 0);
      // stretch going up, squash coming down — classic cartoon weight
      stretchTarget = THREE.MathUtils.clamp(1 + vy * 0.012, 0.9, 1.1);
    } else if (anim === ANIM.climb) {
      const ph = time * 6;
      const reach = Math.sin(ph);
      armL.rotation.x = -2.4 + reach * 0.5;
      armR.rotation.x = -2.4 - reach * 0.5;
      armL.rotation.z = 0.25;
      armR.rotation.z = -0.25;
      legL.rotation.x = reach * 0.6;
      legR.rotation.x = -reach * 0.6;
      footL.rotation.x = 0.3;
      footR.rotation.x = 0.3;
      root.position.y = reach * 0.02;
      root.rotation.set(0, 0, reach * 0.06);
    } else {
      // idle: breathing, a slow sway, and arms hanging with a bit of life
      const ph = time * 2.2;
      const breath = Math.sin(ph);
      armL.rotation.x = breath * 0.08;
      armR.rotation.x = -breath * 0.08;
      armL.rotation.z = 0.16 + breath * 0.03;
      armR.rotation.z = -0.16 - breath * 0.03;
      legL.rotation.x = 0;
      legR.rotation.x = 0;
      footL.rotation.x = 0;
      footR.rotation.x = 0;
      body.position.y = breath * 0.012;
      root.position.y = 0;
      root.rotation.set(0, Math.sin(time * 0.7) * 0.05, Math.sin(time * 0.9) * 0.02);
      stretchTarget = 1 + breath * 0.02;
    }

    // one damped squash/stretch for every state, so landing eases back to
    // neutral instead of popping the instant the anim changes
    stretch += (stretchTarget - stretch) * ease;
    body.scale.set(2 - stretch, stretch, 2 - stretch);
  };

  const pose = (): RigPose => {
    group.updateMatrixWorld(true);
    const origin = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
    const quat = root.getWorldQuaternion(new THREE.Quaternion());
    const limbs = [armL, armR, legL, legR].flatMap((pivot) => {
      const capsule = pivot?.children[0];
      if (!capsule) return [];
      return [{
        pos: capsule.getWorldPosition(new THREE.Vector3()).sub(origin),
        quat: capsule.getWorldQuaternion(new THREE.Quaternion()),
      }];
    });
    return { quat, limbs };
  };

  const setOpacity = (o: number) => {
    group.visible = o > 0.03;
    for (const m of mats) {
      m.transparent = o < 0.999;
      m.opacity = o;
      m.depthWrite = o >= 0.999; // ghostly but artifact-free while faded
    }
  };

  const dispose = () => {
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  };

  return { group, color, animate, pose, setOpacity, dispose };
}
