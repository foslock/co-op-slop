import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LevelData } from 'shared';
import { ARCHETYPES } from 'shared';
import { occlusionUniforms } from './levelBuilder';

// ---- per-zone look ----
// Indoor rooms are lit like rooms (warm haze, the "sun" is the ceiling light);
// from the rooftop up the sky opens, darkens and finally fills with stars.
interface Palette {
  skyTop: number;
  skyHorizon: number;
  skyBottom: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  env: number; // environment-map reflection strength
  exposure: number;
  rim: number;
  stars: number;
}

const DAY = { skyTop: 0x3f8fde, skyHorizon: 0xcfe8ff, skyBottom: 0x9aa7b5 };

const PALETTES: Record<string, Palette> = {
  basement: { ...DAY, fog: 0x3e3631, fogNear: 30, fogFar: 115, sun: 0xffd9a0, sunI: 1.8, hemiSky: 0xffe2c0, hemiGround: 0x3a2f28, hemiI: 0.41, env: 0.21, exposure: 1.0, rim: 0.12, stars: 0 },
  garage: { ...DAY, fog: 0x5d646f, fogNear: 34, fogFar: 125, sun: 0xf1f6ff, sunI: 2.23, hemiSky: 0xe8f0ff, hemiGround: 0x4a4f58, hemiI: 0.49, env: 0.27, exposure: 1.0, rim: 0.14, stars: 0 },
  kitchen: { ...DAY, fog: 0xd8c9b0, fogNear: 40, fogFar: 140, sun: 0xfff1d6, sunI: 2.44, hemiSky: 0xfff6e8, hemiGround: 0x8a7a66, hemiI: 0.58, env: 0.3, exposure: 1.0, rim: 0.15, stars: 0 },
  livingroom: { ...DAY, fog: 0xc6bf9f, fogNear: 40, fogFar: 140, sun: 0xffe6c2, sunI: 2.28, hemiSky: 0xfff0dc, hemiGround: 0x6d5f4a, hemiI: 0.54, env: 0.27, exposure: 1.0, rim: 0.15, stars: 0 },
  library: { ...DAY, fog: 0x7d5c40, fogNear: 34, fogFar: 125, sun: 0xffd08a, sunI: 2.07, hemiSky: 0xffe2b0, hemiGround: 0x4a3324, hemiI: 0.46, env: 0.24, exposure: 1.02, rim: 0.14, stars: 0 },
  bedroom: { ...DAY, fog: 0xc4b3d4, fogNear: 40, fogFar: 140, sun: 0xffe2ee, sunI: 2.17, hemiSky: 0xf8e8ff, hemiGround: 0x6b5a7a, hemiI: 0.56, env: 0.27, exposure: 1.0, rim: 0.15, stars: 0 },
  bathroom: { ...DAY, fog: 0xcde5ee, fogNear: 42, fogFar: 145, sun: 0xf4fbff, sunI: 2.44, hemiSky: 0xf0fbff, hemiGround: 0x7a8c94, hemiI: 0.61, env: 0.33, exposure: 1.0, rim: 0.15, stars: 0 },
  office: { ...DAY, fog: 0xb7c1cb, fogNear: 40, fogFar: 140, sun: 0xf6f8ff, sunI: 2.28, hemiSky: 0xeef3ff, hemiGround: 0x5c6670, hemiI: 0.56, env: 0.3, exposure: 1.0, rim: 0.15, stars: 0 },
  attic: { ...DAY, fog: 0x8c7054, fogNear: 34, fogFar: 125, sun: 0xffcf8f, sunI: 1.96, hemiSky: 0xffdcae, hemiGround: 0x4d3a2a, hemiI: 0.42, env: 0.23, exposure: 1.03, rim: 0.14, stars: 0 },
  backyard: { skyTop: 0x4b9be0, skyHorizon: 0xc4e6ff, skyBottom: 0x8fbf72, fog: 0xc4e6ff, fogNear: 70, fogFar: 260, sun: 0xfff1d0, sunI: 2.86, hemiSky: 0xd7ecff, hemiGround: 0x6f8a4f, hemiI: 0.61, env: 0.3, exposure: 1.0, rim: 0.17, stars: 0 },
  rooftop: { skyTop: 0x3f8fde, skyHorizon: 0xcfe8ff, skyBottom: 0x9ab0c4, fog: 0xcfe8ff, fogNear: 70, fogFar: 280, sun: 0xfff3dc, sunI: 2.86, hemiSky: 0xd9ecff, hemiGround: 0x7c7468, hemiI: 0.6, env: 0.3, exposure: 1.0, rim: 0.17, stars: 0 },
  sky: { skyTop: 0x2f7fd6, skyHorizon: 0xbfe0ff, skyBottom: 0xf4f8ff, fog: 0xd6ecff, fogNear: 80, fogFar: 320, sun: 0xffffff, sunI: 2.97, hemiSky: 0xe0f0ff, hemiGround: 0xb0c0d0, hemiI: 0.65, env: 0.33, exposure: 1.0, rim: 0.18, stars: 0 },
  stratosphere: { skyTop: 0x0b1f5c, skyHorizon: 0x4b7fc9, skyBottom: 0x9cc4ef, fog: 0x4b7fc9, fogNear: 110, fogFar: 520, sun: 0xfff7ea, sunI: 3.07, hemiSky: 0x9fbfff, hemiGround: 0x3a4f7a, hemiI: 0.42, env: 0.27, exposure: 1.02, rim: 0.22, stars: 0.45 },
  space: { skyTop: 0x01020a, skyHorizon: 0x0a1030, skyBottom: 0x0a1838, fog: 0x03050f, fogNear: 260, fogFar: 1400, sun: 0xffffff, sunI: 3.5, hemiSky: 0x8090c0, hemiGround: 0x101830, hemiI: 0.26, env: 0.24, exposure: 1.05, rim: 0.27, stars: 1 },
};

const INDOOR = new Set(['basement', 'garage', 'kitchen', 'livingroom', 'library', 'bedroom', 'bathroom', 'office', 'attic']);
const WALL_R = 62;
const SUN_DIR = new THREE.Vector3(0.42, 0.78, 0.32).normalize();

// ---- procedural textures ----

type Draw = (c: CanvasRenderingContext2D, w: number, h: number) => void;

function shade(n: number, k: number): string {
  const c = new THREE.Color(n);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/** Deterministic tiny noise so textures look the same every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WALLS: Record<string, Draw> = {
  basement: (c, w, h) => { // brick
    c.fillStyle = '#5a4a44'; c.fillRect(0, 0, w, h);
    const r = prng(1);
    const bh = h / 8, bw = w / 4;
    for (let row = 0; row < 8; row++) {
      for (let col = -1; col < 5; col++) {
        const x = col * bw + (row % 2) * bw / 2;
        c.fillStyle = shade(0x9a5440, 0.8 + r() * 0.3);
        c.fillRect(x + 4, row * bh + 4, bw - 8, bh - 8);
      }
    }
  },
  garage: (c, w, h) => { // pegboard over cinder block
    c.fillStyle = '#a7a39a'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#c9a77a'; c.fillRect(0, h * 0.18, w, h * 0.5);
    c.fillStyle = '#7a6448';
    for (let y = h * 0.21; y < h * 0.66; y += 22) for (let x = 11; x < w; x += 22) { c.beginPath(); c.arc(x, y, 3.2, 0, 7); c.fill(); }
    c.strokeStyle = '#8c887f'; c.lineWidth = 4;
    for (let y = h * 0.7; y < h; y += h * 0.1) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    for (let x = 0; x < w; x += w / 3) { c.beginPath(); c.moveTo(x, h * 0.68); c.lineTo(x, h); c.stroke(); }
  },
  kitchen: (c, w, h) => { // glossy tiles with an accent band
    c.fillStyle = '#e6ddd0'; c.fillRect(0, 0, w, h);
    const n = 8, s = w / n;
    for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
      const accent = Math.abs(y - h * 0.5) < s * 0.6;
      c.fillStyle = accent ? '#4f9e9b' : ((x / s + y / s) % 2 ? '#f7f1e6' : '#efe7d9');
      c.fillRect(x + 3, y + 3, s - 6, s - 6);
    }
  },
  livingroom: (c, w, h) => { // regency stripes
    c.fillStyle = '#9fb48a'; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += w / 6) {
      c.fillStyle = '#e7e0c4'; c.fillRect(x, 0, w / 12, h);
      c.fillStyle = '#c9b77e'; c.fillRect(x + w / 12, 0, 3, h); c.fillRect(x - 3, 0, 3, h);
    }
  },
  library: (c, w, h) => { // floor-to-ceiling bookshelves
    c.fillStyle = '#4a2f1f'; c.fillRect(0, 0, w, h);
    const r = prng(7);
    const shelves = 5, sh = h / shelves;
    const colors = [0x8c2f2f, 0x2f4f8c, 0x2f6b46, 0xc9a227, 0x6b3a7a, 0xb05a2a, 0x2b3a55, 0x9a6b4f];
    for (let s = 0; s < shelves; s++) {
      let x = 6;
      while (x < w - 6) {
        const bw = 10 + r() * 16, bh = sh * (0.6 + r() * 0.3);
        c.fillStyle = shade(colors[Math.floor(r() * colors.length)], 0.8 + r() * 0.35);
        c.fillRect(x, s * sh + sh - bh - 8, bw - 2, bh);
        c.fillStyle = 'rgba(255,220,140,0.5)'; c.fillRect(x + 2, s * sh + sh - bh * 0.7 - 8, bw - 6, 3);
        x += bw;
      }
      c.fillStyle = '#6d4c41'; c.fillRect(0, s * sh + sh - 8, w, 10);
    }
  },
  bedroom: (c, w, h) => { // soft diamond wallpaper
    c.fillStyle = '#c3b0d8'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#d8cbe6';
    const s = w / 6;
    for (let y = 0; y < h + s; y += s) for (let x = 0; x < w + s; x += s) {
      const ox = (y / s) % 2 ? s / 2 : 0;
      c.beginPath(); c.moveTo(x + ox, y - s * 0.35); c.lineTo(x + ox + s * 0.25, y); c.lineTo(x + ox, y + s * 0.35); c.lineTo(x + ox - s * 0.25, y); c.fill();
    }
    c.fillStyle = '#f2c6d6';
    for (let y = s / 2; y < h; y += s) for (let x = 0; x < w; x += s) { c.beginPath(); c.arc(x + ((y / s) % 2 ? 0 : s / 2), y, 5, 0, 7); c.fill(); }
  },
  bathroom: (c, w, h) => { // subway tile
    c.fillStyle = '#b9d3dc'; c.fillRect(0, 0, w, h);
    const th = h / 16, tw = w / 6;
    for (let row = 0; row < 16; row++) for (let col = -1; col < 7; col++) {
      c.fillStyle = row > 10 ? '#7fb3c9' : '#eef7fa';
      c.fillRect(col * tw + (row % 2) * tw / 2 + 2, row * th + 2, tw - 4, th - 4);
    }
  },
  office: (c, w, h) => { // pinstripe over a dado
    c.fillStyle = '#8fa3b8'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#9fb2c6';
    for (let x = 0; x < w; x += 16) c.fillRect(x, 0, 6, h * 0.62);
    c.fillStyle = '#5c6e82'; c.fillRect(0, h * 0.62, w, h * 0.38);
    c.fillStyle = '#e8e4d8'; c.fillRect(0, h * 0.6, w, 10);
  },
  attic: (c, w, h) => { // rough planks
    c.fillStyle = '#7a5a3c'; c.fillRect(0, 0, w, h);
    const r = prng(3);
    for (let x = 0; x < w; x += w / 8) {
      c.fillStyle = shade(0x9a7250, 0.75 + r() * 0.35);
      c.fillRect(x + 2, 0, w / 8 - 4, h);
      c.strokeStyle = 'rgba(60,40,25,0.35)'; c.lineWidth = 2;
      for (let k = 0; k < 5; k++) { const gx = x + 6 + r() * (w / 8 - 12); c.beginPath(); c.moveTo(gx, 0); c.bezierCurveTo(gx + 6, h * 0.3, gx - 6, h * 0.6, gx + 3, h); c.stroke(); }
      c.fillStyle = '#3a2a1d'; c.beginPath(); c.arc(x + w / 16, h * 0.2, 3, 0, 7); c.arc(x + w / 16, h * 0.8, 3, 0, 7); c.fill();
    }
  },
};

const FLOORS: Record<string, Draw> = {
  basement: (c, w, h) => { c.fillStyle = '#7b7873'; c.fillRect(0, 0, w, h); const r = prng(11); for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(0,0,0,${r() * 0.12})`; c.fillRect(r() * w, r() * h, 3, 3); } c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 3; c.strokeRect(0, 0, w, h); },
  garage: (c, w, h) => { c.fillStyle = '#76736d'; c.fillRect(0, 0, w, h); const r = prng(12); for (let i = 0; i < 700; i++) { c.fillStyle = `rgba(0,0,0,${r() * 0.1})`; c.fillRect(r() * w, r() * h, 4, 4); } c.fillStyle = '#d9b44a'; c.fillRect(0, h * 0.48, w, 6); c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 3; c.strokeRect(0, 0, w, h); },
  kitchen: (c, w, h) => { const s = w / 4; for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { c.fillStyle = (x + y) % 2 ? '#2d3038' : '#f2efe8'; c.fillRect(x * s, y * s, s, s); } },
  livingroom: (c, w, h) => { const r = prng(5); for (let y = 0; y < h; y += h / 8) { let x = -r() * w / 3; while (x < w) { const L = w / 3 + r() * w / 3; c.fillStyle = shade(0xa0703f, 0.8 + r() * 0.3); c.fillRect(x + 1, y + 1, L - 2, h / 8 - 2); x += L; } } },
  library: (c, w, h) => { c.fillStyle = '#7a1f2b'; c.fillRect(0, 0, w, h); c.strokeStyle = '#c9a227'; c.lineWidth = 6; c.strokeRect(10, 10, w - 20, h - 20); c.fillStyle = '#8f2a37'; for (let i = 0; i < 6; i++) { c.beginPath(); c.arc(w / 2, h / 2, 30 + i * 30, 0, 7); c.stroke(); } },
  bedroom: (c, w, h) => { c.fillStyle = '#9bb4d6'; c.fillRect(0, 0, w, h); const r = prng(9); for (let i = 0; i < 2000; i++) { c.fillStyle = `rgba(255,255,255,${r() * 0.12})`; c.fillRect(r() * w, r() * h, 2, 2); } },
  bathroom: (c, w, h) => { const s = w / 8; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { c.fillStyle = (x + y) % 3 === 0 ? '#7fb3c9' : '#f4f9fb'; c.fillRect(x * s + 2, y * s + 2, s - 4, s - 4); } },
  office: (c, w, h) => { c.fillStyle = '#6b7480'; c.fillRect(0, 0, w, h); c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 2; for (let x = 0; x <= w; x += w / 2) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); c.beginPath(); c.moveTo(0, x); c.lineTo(w, x); c.stroke(); } },
  attic: (c, w, h) => { const r = prng(13); for (let y = 0; y < h; y += h / 6) { c.fillStyle = shade(0x8a6545, 0.75 + r() * 0.3); c.fillRect(0, y + 1, w, h / 6 - 2); } },
  backyard: (c, w, h) => { c.fillStyle = '#6faa4f'; c.fillRect(0, 0, w, h); const r = prng(17); for (let i = 0; i < 1600; i++) { c.fillStyle = r() > 0.5 ? 'rgba(40,90,30,0.35)' : 'rgba(170,220,120,0.3)'; c.fillRect(r() * w, r() * h, 2, 5); } },
};

const WINDOW: Draw = (c, w, h) => {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#7fbfff');
  g.addColorStop(0.7, '#d8efff');
  g.addColorStop(1, '#a8d8a0');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.fillStyle = 'rgba(255,255,255,0.8)';
  c.beginPath(); c.ellipse(w * 0.3, h * 0.28, w * 0.18, h * 0.06, 0, 0, 7); c.fill();
  c.beginPath(); c.ellipse(w * 0.72, h * 0.4, w * 0.14, h * 0.05, 0, 0, 7); c.fill();
  c.fillStyle = '#f5f1e6';
  c.fillRect(0, 0, w, 14); c.fillRect(0, h - 14, w, 14); c.fillRect(0, 0, 14, h); c.fillRect(w - 14, 0, 14, h);
  c.fillRect(w / 2 - 6, 0, 12, h); c.fillRect(0, h / 2 - 6, w, 12);
};

const CEILING: Draw = (c, w, h) => {
  c.fillStyle = '#efe9dc'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(0,0,0,0.08)'; c.lineWidth = 3;
  for (let x = 0; x <= w; x += w / 4) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); c.beginPath(); c.moveTo(0, x); c.lineTo(w, x); c.stroke(); }
};

const SIDING: Draw = (c, w, h) => {
  c.fillStyle = '#e9e1cf'; c.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += h / 10) { c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(0, y, w, 4); c.fillStyle = 'rgba(255,255,255,0.4)'; c.fillRect(0, y + 4, w, 3); }
};

const SHINGLES: Draw = (c, w, h) => {
  c.fillStyle = '#5a3a34'; c.fillRect(0, 0, w, h);
  const r = prng(21);
  const rows = 8, sw = w / 6;
  for (let row = 0; row < rows; row++) for (let col = -1; col < 7; col++) {
    c.fillStyle = shade(0xa8543a, 0.7 + r() * 0.35);
    const x = col * sw + (row % 2) * sw / 2;
    c.beginPath(); c.roundRect(x + 2, row * (h / rows) + 2, sw - 4, h / rows + 6, [0, 0, 10, 10]); c.fill();
  }
};

const CLOUD: Draw = (c, w, h) => {
  const r = prng(31);
  for (let i = 0; i < 14; i++) {
    const x = w * (0.2 + r() * 0.6), y = h * (0.4 + r() * 0.25), rad = w * (0.1 + r() * 0.16);
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, rad, 0, 7); c.fill();
  }
};

const EARTH: Draw = (c, w, h) => {
  // planar map of the hemisphere under the tower: blue ocean, green-brown land, cloud swirls
  c.fillStyle = '#2a6fb5'; c.fillRect(0, 0, w, h);
  const r = prng(41);
  for (let i = 0; i < 26; i++) {
    const x = r() * w, y = r() * h, rad = 30 + r() * 110;
    c.fillStyle = r() > 0.3 ? shade(0x5f9e4a, 0.75 + r() * 0.35) : shade(0xb79a62, 0.8 + r() * 0.3);
    c.beginPath();
    for (let a = 0; a < Math.PI * 2; a += 0.4) {
      const rr = rad * (0.6 + r() * 0.6);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (a === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath(); c.fill();
  }
  // a big green patch right under the house
  c.fillStyle = '#5f9e4a'; c.beginPath(); c.ellipse(w / 2, h / 2, 90, 70, 0.3, 0, 7); c.fill();
  for (let i = 0; i < 40; i++) {
    c.strokeStyle = `rgba(255,255,255,${0.35 + r() * 0.4})`;
    c.lineWidth = 6 + r() * 14;
    c.beginPath();
    const x = r() * w, y = r() * h;
    c.arc(x, y, 40 + r() * 90, r() * 6, r() * 6 + 1 + r() * 2);
    c.stroke();
  }
};

const MOON: Draw = (c, w, h) => {
  c.fillStyle = '#cfd2d8'; c.fillRect(0, 0, w, h);
  const r = prng(51);
  for (let i = 0; i < 70; i++) {
    const x = r() * w, y = r() * h, rad = 4 + r() * 26;
    c.fillStyle = `rgba(90,95,110,${0.2 + r() * 0.3})`;
    c.beginPath(); c.arc(x, y, rad, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.beginPath(); c.arc(x - rad * 0.25, y - rad * 0.25, rad * 0.6, 0, 7); c.fill();
  }
};

export class Environment {
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private level: LevelData;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private starsMat: THREE.PointsMaterial;
  private fog: THREE.Fog;
  private bgColor = new THREE.Color();
  private group = new THREE.Group();
  private clouds: THREE.Object3D[] = [];
  private planets = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private pal: Palette = { ...PALETTES.kitchen };
  private zonePal: Palette[];
  private envTex: THREE.Texture;
  private c0 = new THREE.Color();
  private c1 = new THREE.Color();

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, level: LevelData) {
    this.scene = scene;
    this.renderer = renderer;
    this.level = level;
    this.zonePal = level.zones.map((z) => PALETTES[z.theme] ?? PALETTES.rooftop);
    this.fog = new THREE.Fog(0xcfe8ff, 45, 150);
    scene.fog = this.fog;
    scene.add(this.group);

    // soft reflections for the glossy toy materials
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTex = pmrem.fromScene(room, 0.04).texture;
    scene.environment = this.envTex;
    room.dispose();
    pmrem.dispose();

    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b6250, 0.85);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2d9, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 140;
    const s = 26;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    (this.sun.shadow as THREE.LightShadow & { intensity?: number }).intensity = 0.72;
    scene.add(this.sun, this.sun.target);

    // gradient sky dome with a sun disc, always centered on the camera
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uBottom: { value: new THREE.Color() },
        uSunDir: { value: SUN_DIR.clone() },
        uSunColor: { value: new THREE.Color(0xfff2d9) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: `
        uniform vec3 uTop, uHorizon, uBottom, uSunDir, uSunColor;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(h, 0.55)) : mix(uHorizon, uBottom, pow(-h, 0.45));
          float s = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.28);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.disposables.push(this.sky.geometry, this.skyMat);

    // star shell, faded in as you climb
    const starGeo = new THREE.BufferGeometry();
    const n = 1600;
    const pos = new Float32Array(n * 3);
    const cols = new Float32Array(n * 3);
    const r = prng(99);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize().multiplyScalar(420);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = Math.abs(v.y) * (r() < 0.85 ? 1 : -0.4);
      pos[i * 3 + 2] = v.z;
      const tint = new THREE.Color().setHSL(0.55 + r() * 0.15, 0.4 * r(), 0.75 + r() * 0.25);
      cols[i * 3] = tint.r; cols[i * 3 + 1] = tint.g; cols[i * 3 + 2] = tint.b;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.starsMat = new THREE.PointsMaterial({
      size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, vertexColors: true, fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    scene.add(this.stars);
    this.disposables.push(starGeo, this.starsMat);

    this.buildHouse();
    this.buildSky();
  }

  private tex(draw: Draw, w = 512, h = 512, repeat?: [number, number]): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    draw(canvas.getContext('2d')!, w, h);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    if (repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
    }
    this.disposables.push(t);
    return t;
  }

  private mat(opts: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.9, ...opts });
    this.disposables.push(m);
    return m;
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.disposables.push(g);
    return g;
  }

  /** How far from the axis the climb reaches around height y — floors leave a hole that wide. */
  private holeRadius(y: number): number {
    let r = 0;
    for (const p of this.level.props) {
      if (!p.solid) continue;
      const arch = ARCHETYPES[p.archetype];
      const top = p.pos.y + arch.topY;
      if (top < y - 6 || p.pos.y > y + 6) continue;
      r = Math.max(r, Math.hypot(p.pos.x, p.pos.z) + arch.topRadius + 3);
    }
    return THREE.MathUtils.clamp(r + 2, 20, 46);
  }

  /**
   * The indoor zones become actual rooms: wallpapered walls with windows, a
   * floor (with a hole the tower climbs through) and a ceiling. The house gets
   * an outside shell and a roof, and above it the open sky.
   */
  private buildHouse() {
    const zones = this.level.zones;
    const firstOutdoor = zones.findIndex((z) => !INDOOR.has(z.theme));
    const roofY = firstOutdoor >= 0 ? zones[firstOutdoor].yStart : zones[zones.length - 1].yEnd;
    const windowTex = this.tex(WINDOW, 256, 320);
    const windowMat = new THREE.MeshBasicMaterial({ map: windowTex, toneMapped: false, fog: true });
    this.disposables.push(windowMat);
    const windowGeo = this.geo(new THREE.PlaneGeometry(9, 11));
    const ceilingTex = this.tex(CEILING, 256, 256, [24, 24]);
    const ceilingMat = this.mat({ map: ceilingTex, side: THREE.DoubleSide, roughness: 0.95 });
    const trimMat = this.mat({ color: 0xf2ece0, roughness: 0.6, side: THREE.BackSide }); // seen from inside the rooms
    const lipMat = this.mat({ color: 0x8a5a3a, roughness: 0.7, side: THREE.BackSide }); // the stairwell's wooden edge

    zones.forEach((z, i) => {
      const indoor = INDOOR.has(z.theme);
      const isBackyard = z.theme === 'backyard';
      if (!indoor && !isBackyard) return;
      const y0 = i === 0 ? 0 : z.yStart;
      const y1 = i + 1 < zones.length ? zones[i + 1].yStart : z.yEnd + 8;
      const hole = i === 0 ? 0 : this.holeRadius(y0);

      // floor
      const floorDraw = FLOORS[z.theme] ?? FLOORS.basement;
      const tile = z.theme === 'kitchen' ? 8 : z.theme === 'bathroom' ? 6 : 12;
      const floorTex = this.tex(floorDraw, 256, 256, [(WALL_R * 2) / tile, (WALL_R * 2) / tile]);
      const floorGeo = this.geo(hole > 0 ? new THREE.RingGeometry(hole, WALL_R + 0.5, 72, 1) : new THREE.CircleGeometry(WALL_R + 0.5, 72));
      const floor = new THREE.Mesh(floorGeo, this.mat({ map: floorTex, roughness: 0.75 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = y0 - 0.01;
      floor.receiveShadow = true;
      this.group.add(floor);
      if (hole > 0) {
        // the ceiling of the room below is the underside of this floor
        const ceil = new THREE.Mesh(floorGeo, ceilingMat);
        ceil.rotation.x = Math.PI / 2;
        ceil.position.y = y0 - 1.2;
        this.group.add(ceil);
        const lip = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(hole, hole, 1.25, 72, 1, true)), lipMat);
        lip.position.y = y0 - 0.6;
        this.group.add(lip);
      }
      if (isBackyard) {
        // a garden terrace on the roof: a picket fence and hedges round the edge
        const fenceMat = this.mat({ color: 0xf5f1e6, roughness: 0.7 });
        const hedgeMat = this.mat({ color: 0x4f8a3c, roughness: 1 });
        const picket = this.geo(new THREE.BoxGeometry(0.5, 3.4, 0.25));
        for (let k = 0; k < 120; k++) {
          const a = (k / 120) * Math.PI * 2;
          const p = new THREE.Mesh(picket, fenceMat);
          p.position.set(Math.cos(a) * (WALL_R - 2), y0 + 1.7, Math.sin(a) * (WALL_R - 2));
          p.rotation.y = -a;
          this.group.add(p);
        }
        const hedge = new THREE.Mesh(this.geo(new THREE.TorusGeometry(WALL_R - 4, 1.6, 8, 96)), hedgeMat);
        hedge.rotation.x = Math.PI / 2;
        hedge.position.y = y0 + 0.8;
        this.group.add(hedge);
        return;
      }

      // walls
      const h = y1 - y0;
      const wallTex = this.tex(WALLS[z.theme] ?? WALLS.basement, 512, 512, [44, Math.max(1, h / 9)]);
      const wall = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(WALL_R, WALL_R, h + 1.4, 96, 1, true)),
        this.mat({ map: wallTex, side: THREE.BackSide, roughness: 0.85 }),
      );
      wall.position.y = y0 + h / 2 - 0.6;
      wall.receiveShadow = true;
      this.group.add(wall);
      // skirting board and crown molding
      for (const [yy, hh] of [[y0 + 0.6, 1.2], [y1 - 1.6, 0.6]] as const) {
        const band = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(WALL_R - 0.15, WALL_R - 0.15, hh, 96, 1, true)), trimMat);
        band.position.y = yy;
        this.group.add(band);
      }
      // windows letting daylight in (the basement gets little ones up high)
      const count = z.theme === 'basement' ? 8 : z.theme === 'library' ? 3 : 6;
      const wy = z.theme === 'basement' ? y1 - 4 : y0 + Math.min(h * 0.45, 12);
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2 + i * 0.7;
        const win = new THREE.Mesh(windowGeo, windowMat);
        win.position.set(Math.cos(a) * (WALL_R - 0.3), wy, Math.sin(a) * (WALL_R - 0.3));
        win.lookAt(0, wy, 0);
        if (z.theme === 'basement') win.scale.set(0.6, 0.35, 1);
        this.group.add(win);
      }
    });

    // outside of the house and its roof, seen once you climb out on top
    const sidingTex = this.tex(SIDING, 256, 256, [40, Math.max(1, roofY / 6)]);
    const shell = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(WALL_R + 0.6, WALL_R + 0.6, roofY, 96, 1, true)),
      this.mat({ map: sidingTex, roughness: 0.85 }),
    );
    shell.position.y = roofY / 2;
    this.group.add(shell);
    const rTop = firstOutdoor >= 0 ? this.holeRadius(roofY) : 30;
    const roofH = 12;
    const shingles = this.tex(SHINGLES, 512, 512, [60, 6]);
    const roof = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(rTop, WALL_R + 8, roofH, 96, 1, true)),
      this.mat({ map: shingles, side: THREE.DoubleSide, roughness: 0.8 }),
    );
    roof.position.y = roofY - roofH / 2 + 0.5;
    roof.receiveShadow = true;
    this.group.add(roof);
    const gutter = new THREE.Mesh(this.geo(new THREE.TorusGeometry(rTop, 0.5, 8, 96)), this.mat({ color: 0xeeeeee, roughness: 0.5, metalness: 0.3 }));
    gutter.rotation.x = Math.PI / 2;
    gutter.position.y = roofY + 0.5;
    this.group.add(gutter);
  }

  private buildSky() {
    const zones = this.level.zones;
    const zoneOf = (id: string) => zones.find((z) => z.theme === id);
    const skyZ = zoneOf('sky');
    const strat = zoneOf('stratosphere');
    const space = zoneOf('space');
    const cloudTex = this.tex(CLOUD, 256, 256);

    // puffy billboard clouds drifting around the open-sky zones
    const r = prng(7);
    const lo = (zoneOf('rooftop')?.yStart ?? 120) - 5;
    const hi = (strat?.yStart ?? lo + 60) + 5;
    for (let i = 0; i < 46; i++) {
      const m = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.9, fog: true });
      this.disposables.push(m);
      const s = new THREE.Sprite(m);
      const a = r() * Math.PI * 2;
      const rad = 36 + r() * 90;
      s.position.set(Math.cos(a) * rad, lo + r() * (hi - lo), Math.sin(a) * rad);
      const k = 14 + r() * 22;
      s.scale.set(k, k * 0.55, 1);
      s.userData.drift = 0.3 + r() * 0.6;
      this.group.add(s);
      this.clouds.push(s);
    }
    // a sea of clouds below the stratosphere, looked down on from above
    if (strat) {
      const sea = this.geo(new THREE.PlaneGeometry(1, 1));
      for (let i = 0; i < 70; i++) {
        const m = new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.85, fog: true });
        this.disposables.push(m);
        const p = new THREE.Mesh(sea, m);
        const a = r() * Math.PI * 2;
        const rad = 30 + r() * 320;
        p.position.set(Math.cos(a) * rad, strat.yStart - 14 - r() * 6, Math.sin(a) * rad);
        p.rotation.x = -Math.PI / 2;
        p.rotation.z = r() * Math.PI;
        const k = 50 + r() * 70;
        p.scale.set(k, k * 0.7, 1);
        p.userData.drift = 0.15 + r() * 0.2;
        this.group.add(p);
        this.clouds.push(p);
      }
    }
    void skyZ;

    // the Earth the tower stands on, curving away below you up high
    const R = 1500;
    const earthGeo = this.geo(new THREE.SphereGeometry(R, 128, 64, 0, Math.PI * 2, 0, Math.PI * 0.45));
    const uv = earthGeo.attributes.uv;
    const p = earthGeo.attributes.position;
    for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 + p.getX(i) / (2 * R), 0.5 + p.getZ(i) / (2 * R));
    const earth = new THREE.Mesh(earthGeo, this.mat({ map: this.tex(EARTH, 1024, 1024), roughness: 1 }));
    earth.position.y = -R - 3;
    this.group.add(earth);
    const atmo = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(R * 1.02, 96, 48, 0, Math.PI * 2, 0, Math.PI * 0.5)),
      new THREE.MeshBasicMaterial({ color: 0x6fb6ff, transparent: true, opacity: 0.18, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    this.disposables.push(atmo.material as THREE.Material);
    atmo.position.copy(earth.position);
    this.group.add(atmo);

    // a moon and a ringed planet hang in deep space
    if (space) {
      const moon = new THREE.Mesh(this.geo(new THREE.SphereGeometry(28, 48, 32)), this.mat({ map: this.tex(MOON, 512, 256), roughness: 1, fog: false }));
      moon.position.set(-260, space.yStart + 110, -210);
      this.planets.add(moon);
      const planet = new THREE.Mesh(this.geo(new THREE.SphereGeometry(42, 48, 32)), this.mat({ color: 0xe0a86a, roughness: 0.9, fog: false }));
      planet.position.set(300, space.yStart + 60, 160);
      this.planets.add(planet);
      const ring = new THREE.Mesh(this.geo(new THREE.RingGeometry(56, 86, 96)), this.mat({ color: 0xf2d9a8, side: THREE.DoubleSide, transparent: true, opacity: 0.8, roughness: 1, fog: false }));
      ring.position.copy(planet.position);
      ring.rotation.set(Math.PI / 2 - 0.45, 0.2, 0);
      this.planets.add(ring);
      this.group.add(this.planets);
    }
  }

  /** Palette for a height, blending into the next zone's look over the top quarter of each zone. */
  private paletteAt(y: number, out: Palette): Palette {
    const zones = this.level.zones;
    let i = 0;
    for (let k = 0; k < zones.length; k++) if (y >= zones[k].yStart - 0.5) i = k;
    const z = zones[i];
    const frac = THREE.MathUtils.clamp((y - z.yStart) / Math.max(1, z.yEnd - z.yStart), 0, 1);
    const a = this.zonePal[i];
    const b = this.zonePal[Math.min(zones.length - 1, i + 1)];
    // indoor → indoor changes at the floor; anything opening to the sky eases over
    const t = INDOOR.has(z.theme) && INDOOR.has(zones[Math.min(zones.length - 1, i + 1)].theme) ? 0 : THREE.MathUtils.smoothstep(frac, 0.7, 1.0);
    const lerpC = (ka: number, kb: number) => this.c0.setHex(ka).lerp(this.c1.setHex(kb), t).getHex();
    const lerpN = (na: number, nb: number) => na + (nb - na) * t;
    out.skyTop = lerpC(a.skyTop, b.skyTop);
    out.skyHorizon = lerpC(a.skyHorizon, b.skyHorizon);
    out.skyBottom = lerpC(a.skyBottom, b.skyBottom);
    out.fog = lerpC(a.fog, b.fog);
    out.fogNear = lerpN(a.fogNear, b.fogNear);
    out.fogFar = lerpN(a.fogFar, b.fogFar);
    out.sun = lerpC(a.sun, b.sun);
    out.sunI = lerpN(a.sunI, b.sunI);
    out.hemiSky = lerpC(a.hemiSky, b.hemiSky);
    out.hemiGround = lerpC(a.hemiGround, b.hemiGround);
    out.hemiI = lerpN(a.hemiI, b.hemiI);
    out.env = lerpN(a.env, b.env);
    out.exposure = lerpN(a.exposure, b.exposure);
    out.rim = lerpN(a.rim, b.rim);
    out.stars = lerpN(a.stars, b.stars);
    return out;
  }

  update(playerPos: THREE.Vector3, dt: number, camera: THREE.Camera) {
    const p = this.paletteAt(playerPos.y, this.pal);
    this.bgColor.setHex(p.fog);
    this.scene.background = this.bgColor;
    this.fog.color.setHex(p.fog);
    this.fog.near = p.fogNear;
    this.fog.far = p.fogFar;
    const u = this.skyMat.uniforms;
    (u.uTop.value as THREE.Color).setHex(p.skyTop);
    (u.uHorizon.value as THREE.Color).setHex(p.skyHorizon);
    (u.uBottom.value as THREE.Color).setHex(p.skyBottom);
    (u.uSunColor.value as THREE.Color).setHex(p.sun);
    this.sky.position.copy(camera.position);

    this.starsMat.opacity = p.stars;
    this.stars.visible = p.stars > 0.01;
    this.stars.position.copy(camera.position);

    this.sun.color.setHex(p.sun);
    this.sun.intensity = p.sunI;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemiI;
    (this.scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity = p.env;
    this.renderer.toneMappingExposure = p.exposure;
    occlusionUniforms.uRim.value = p.rim;

    for (const c of this.clouds) c.position.x += Math.sin(c.position.z * 0.01) * dt * c.userData.drift;
    // the moon and the ringed planet only belong to deep space
    this.planets.visible = p.stars > 0.85;
    this.planets.rotation.y += dt * 0.002;

    // keep the shadow frustum centered on the player
    this.sun.position.copy(playerPos).addScaledVector(SUN_DIR, 60);
    this.sun.target.position.copy(playerPos);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.envTex.dispose();
    this.scene.environment = null;
    this.scene.remove(this.stars, this.sun, this.hemi, this.sun.target, this.sky, this.group);
  }
}
