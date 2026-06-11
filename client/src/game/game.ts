import * as THREE from 'three';
import {
  ANIM, COSMETIC_COLORS, GAME, NET, generateLevel,
  type ItemType, type LevelData, type PlayerInfo, type S2C,
} from 'shared';
import { initPhysics, RAPIER as R_NS, GROUP_PLAYER, GROUP_LEVEL, groups } from './physics';
import { buildLevel, type LevelHandles } from './levelBuilder';
import { Environment } from './environment';
import { LocalPlayer } from './localPlayer';
import { RemotePlayer } from './remotePlayer';
import { RagdollManager } from './ragdoll';
import { GrabSystem } from './grab';
import { FollowCamera } from './camera';
import { buildCharacter, type CharacterRig } from './characterMesh';
import { Hud } from '../hud';
import { Input } from '../input';
import type { Net } from '../net';
import { sfx } from '../audio';

const FIXED_DT = 1 / 60;

export interface FinishInfo {
  durationMs: number;
  falls: Record<string, number>;
  rank: number | null;
  top: { names: string[]; durationMs: number; seed: string; date: string }[];
}

export class Game {
  level: LevelData;
  private container: HTMLElement;
  private net: Net;
  private myId: string;
  private players: PlayerInfo[];
  private onFinish: (info: FinishInfo) => void;

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private world!: InstanceType<typeof R_NS.World>;
  private handles!: LevelHandles;
  private env!: Environment;
  private local!: LocalPlayer;
  private localRig!: CharacterRig;
  private remotes = new Map<string, RemotePlayer>();
  private ragdolls!: RagdollManager;
  private grab!: GrabSystem;
  private cam!: FollowCamera;
  private hud!: Hud;
  private input!: Input;
  private clock = new THREE.Clock();
  private accumulator = 0;
  private elapsed = 0;
  private unsub: (() => void)[] = [];
  private onResize = () => this.resize();

  private phase: 'preGo' | 'playing' | 'done' = 'preGo';
  private startAt = Infinity;
  private inventory: ItemType | null = null;
  private flagReached = false;
  private finishedSet = new Set<string>();
  private platesOn = new Set<string>();
  private pickupCooldown = new Map<number, number>();
  private tetherTo: THREE.Vector3 | null = null;
  private pingMarkers: { sprite: THREE.Sprite; until: number }[] = [];
  private lastStateSentAt = 0;
  private goPlayed = false;

  constructor(
    container: HTMLElement,
    uiRoot: HTMLElement,
    net: Net,
    seed: string,
    players: PlayerInfo[],
    myId: string,
    onFinish: (info: FinishInfo) => void,
  ) {
    this.container = container;
    this.net = net;
    this.myId = myId;
    this.players = players;
    this.onFinish = onFinish;
    this.level = generateLevel(seed);
    this.hud = new Hud(uiRoot, () => this.input.requestLock());
  }

  me(): PlayerInfo {
    return this.players.find((p) => p.id === this.myId)!;
  }

  async init() {
    const R = await initPhysics();
    this.world = new R.World({ x: 0, y: -22, z: 0 });

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);
    this.input = new Input(this.renderer.domElement);
    this.input.onLockFallback = () => {
      this.hud.toast('Pointer lock is blocked here — hold the left mouse button and drag to look around 🖱️');
    };
    this.renderer.domElement.addEventListener('click', () => this.input.requestLock());

    this.env = new Environment(this.scene);
    this.handles = buildLevel(this.scene, this.world, R, this.level);

    // spawn everyone in a little ring on the base pad
    const myIdx = Math.max(0, this.players.findIndex((p) => p.id === this.myId));
    const spawnFor = (idx: number) => {
      const a = (idx / 4) * Math.PI * 2;
      return new THREE.Vector3(
        this.level.spawn.x + Math.cos(a) * 1.2,
        this.level.spawn.y,
        this.level.spawn.z + Math.sin(a) * 1.2,
      );
    };
    this.local = new LocalPlayer(this.world, R, spawnFor(myIdx));
    this.localRig = buildCharacter(this.me().cosmetics);
    this.scene.add(this.localRig.group);
    for (const p of this.players) {
      if (p.id === this.myId) continue;
      this.remotes.set(p.id, new RemotePlayer(p.id, p.name, p.cosmetics, this.scene));
    }

    this.ragdolls = new RagdollManager(this.world, R, this.scene);
    this.grab = new GrabSystem(this.scene);
    this.cam = new FollowCamera(this.world, R, window.innerWidth / window.innerHeight);

    this.bindNet();
    window.addEventListener('resize', this.onResize);
    this.renderer.setAnimationLoop(() => this.frame());

    // debug helpers
    (window as unknown as Record<string, unknown>).__onlyUs = {
      game: this,
      tp: (i: number) => {
        const cp = this.level.checkpoints[i];
        if (cp) this.local.teleport(new THREE.Vector3(cp.pos.x, cp.pos.y, cp.pos.z));
      },
      flag: () => {
        const f = this.level.flagPos;
        this.local.teleport(new THREE.Vector3(f.x, f.y + 1, f.z));
      },
    };
  }

  start(startAt: number) {
    this.startAt = startAt;
  }

  private nameOf(id: string): string {
    return this.players.find((p) => p.id === id)?.name ?? '???';
  }

  private colorOf(id: string): number {
    const p = this.players.find((q) => q.id === id);
    return COSMETIC_COLORS[(p?.cosmetics.color ?? 0) % COSMETIC_COLORS.length];
  }

  private posOf(id: string): THREE.Vector3 | null {
    if (id === this.myId) {
      const rd = this.ragdolls.get(this.myId);
      return rd ? rd.torsoPos() : this.local.pos().clone();
    }
    const rp = this.remotes.get(id);
    return rp && rp.pos.y > -50 ? rp.pos : null;
  }

  private bindNet() {
    const on = this.net.on.bind(this.net);
    this.unsub.push(
      on('S', (msg) => {
        for (const [id, arr] of Object.entries(msg.players)) {
          if (id === this.myId) continue;
          this.remotes.get(id)?.push(msg.time, arr);
        }
      }),
      on('gadget', (msg) => {
        const bridge = this.handles.bridges.get(msg.id);
        if (bridge) {
          const wasActive = bridge.state?.active ?? false;
          bridge.state = msg.state;
          if (msg.state.active && !wasActive) sfx.button();
        }
        for (const plate of this.handles.plates) {
          if (plate.gadgetId !== msg.id) continue;
          const pressed = (msg.state.plates[plate.plateIdx] ?? 0) > 0;
          plate.mesh.position.y = plate.pos.y + (pressed ? 0.02 : 0.08);
          const mat = plate.mesh.material as THREE.MeshStandardMaterial;
          mat.color.setHex(msg.state.active ? 0x2eaa52 : 0xc0392b);
          mat.emissive.setHex(msg.state.active ? 0x14552a : 0x731f14);
        }
      }),
      on('checkpoint', (msg) => {
        if (msg.player !== this.myId) {
          this.hud.toast(`${this.nameOf(msg.player)} reached ${this.level.zones[msg.index]?.label ?? 'a checkpoint'}`, 'good');
        }
      }),
      on('fell', (msg) => {
        if (msg.player !== this.myId) this.hud.toast(`${this.nameOf(msg.player)} fell! 💨`, 'bad');
      }),
      on('pickup', (msg) => {
        const item = this.handles.items.get(msg.item);
        if (!item) return;
        item.taken = true;
        item.group.visible = false;
        if (msg.player === this.myId) {
          this.inventory = item.type;
          this.hud.setItem(this.inventory);
          sfx.pickup();
        } else {
          this.hud.toast(`${this.nameOf(msg.player)} picked up ${item.type === 'doublejump' ? 'Double Jump' : item.type === 'telescope' ? 'a Telescope' : 'a Grappling Hook'}`);
        }
      }),
      on('item', (msg) => {
        if (msg.player === this.myId) {
          const had = this.inventory;
          this.inventory = msg.item;
          this.hud.setItem(this.inventory);
          if (msg.item && !had) sfx.pickup();
        } else if (msg.item) {
          this.hud.toast(`${this.nameOf(msg.player)} received ${msg.item === 'doublejump' ? 'Double Jump' : msg.item === 'telescope' ? 'the Telescope' : 'the Grappling Hook'}`);
        }
      }),
      on('rope', (msg) => {
        this.handles.addRope({ x: msg.top[0], y: msg.top[1], z: msg.top[2] }, msg.length);
        sfx.grapple();
        this.hud.toast(`${this.nameOf(msg.by)} threw a grappling rope! Press E to climb it`);
      }),
      on('grab', (msg) => {
        this.grab.set(msg.from, msg.target, msg.on);
      }),
      on('knock', (msg) => {
        if (msg.player === this.myId) return;
        const rp = this.remotes.get(msg.player);
        if (rp) {
          this.ragdolls.spawn(msg.player, rp.pos.clone(), new THREE.Vector3(...msg.vel), rp.rig.color, GAME.ragdollTimeMs + 600);
        }
      }),
      on('ping', (msg) => {
        this.addPingMarker(new THREE.Vector3(msg.p[0], msg.p[1] + 1.6, msg.p[2]), this.colorOf(msg.player));
        sfx.ping();
        this.hud.toast(`${this.nameOf(msg.player)} pinged! 📍`);
      }),
      on('flag', (msg) => {
        this.finishedSet = new Set(msg.done);
        const total = this.players.length;
        if (msg.player === this.myId) {
          this.hud.toast(`You reached the flag! Waiting for the team… (${msg.done.length}/${total})`, 'good');
        } else {
          this.hud.toast(`${this.nameOf(msg.player)} reached the flag! (${msg.done.length}/${total})`, 'good');
        }
      }),
      on('finish', (msg) => {
        this.phase = 'done';
        this.local.control = false;
        sfx.finish();
        document.exitPointerLock();
        this.onFinish(msg);
      }),
      on('lobby', (msg) => {
        // roster changed mid-game (someone left)
        const ids = new Set(msg.players.map((p) => p.id));
        for (const [id, rp] of [...this.remotes]) {
          if (!ids.has(id)) {
            this.hud.toast(`${rp.name} left the game`, 'bad');
            this.grab.clearFor(id);
            this.ragdolls.remove(id);
            rp.dispose(this.scene);
            this.remotes.delete(id);
          }
        }
        this.players = this.players.filter((p) => ids.has(p.id) || p.id === this.myId);
      }),
    );
  }

  private addPingMarker(pos: THREE.Vector3, color: number) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const c = canvas.getContext('2d')!;
    c.font = 'bold 72px system-ui';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.strokeStyle = 'rgba(0,0,0,0.8)';
    c.lineWidth = 8;
    c.strokeText('!', 48, 48);
    c.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    c.fillText('!', 48, 48);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.position.copy(pos);
    sprite.scale.set(1.4, 1.4, 1);
    sprite.renderOrder = 6;
    this.scene.add(sprite);
    this.pingMarkers.push({ sprite, until: performance.now() + 6000 });
  }

  private startLocalRagdoll(vel: THREE.Vector3) {
    if (this.local.ragdolling) return;
    this.local.ragdolling = true;
    this.localRig.group.visible = false;
    this.ragdolls.spawn(this.myId, this.local.pos().clone(), vel, this.localRig.color);
    this.net.send({ t: 'knock', vel: [vel.x, vel.y, vel.z] });
  }

  private endLocalRagdoll(respawn: boolean) {
    const rd = this.ragdolls.get(this.myId);
    const landing = rd ? rd.torsoPos() : this.local.pos().clone();
    this.ragdolls.remove(this.myId);
    this.local.ragdolling = false;
    this.localRig.group.visible = true;
    if (respawn) {
      this.local.teleport(this.local.checkpoint.pos);
      this.net.send({ t: 'fell' });
      this.hud.toast('You fell! Back to the checkpoint', 'bad');
      sfx.fell();
    } else {
      landing.y += 0.2;
      this.local.teleport(landing);
    }
  }

  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;
    const serverNow = this.net.serverNow();

    // unlock controls when the countdown hits zero
    if (this.phase === 'preGo' && serverNow >= this.startAt) {
      this.phase = 'playing';
      this.local.control = true;
      this.hud.countdown(0); // renders "GO!" and clears any stale digit
      if (!this.goPlayed) {
        this.goPlayed = true;
        sfx.countdown(true);
      }
    }

    const { forward, right } = this.cam.basis();

    // fixed-step simulation
    this.accumulator = Math.min(0.12, this.accumulator + dt);
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      for (const bridge of this.handles.bridges.values()) bridge.step(FIXED_DT);
      const events = this.local.step(FIXED_DT, {
        input: this.input,
        forward,
        right,
        bridgeByCollider: this.handles.bridgeByCollider,
        climbables: this.handles.climbables,
        tetherTo: this.tetherTo,
      });
      this.world.step();
      for (const ev of events) {
        if (ev.type === 'knockdown') this.startLocalRagdoll(ev.vel);
        else if (ev.type === 'fell') {
          this.net.send({ t: 'fell' });
          this.hud.toast('You fell! Back to the checkpoint', 'bad');
          sfx.fell();
        }
      }
    }
    for (const bridge of this.handles.bridges.values()) bridge.syncMesh();

    // ragdoll bookkeeping
    const expired = this.ragdolls.syncAndExpire(performance.now());
    for (const id of expired) {
      if (id === this.myId) this.endLocalRagdoll(false);
      else this.ragdolls.remove(id);
    }
    if (this.local.ragdolling) {
      const rd = this.ragdolls.get(this.myId);
      if (rd && rd.torsoPos().y < this.local.checkpoint.pos.y - GAME.respawnFallBelow) {
        this.endLocalRagdoll(true);
      }
    }

    // remote players (also clean up stale remote ragdolls when their anim leaves ragdoll state)
    const renderTime = serverNow - NET.interpDelayMs;
    for (const rp of this.remotes.values()) {
      rp.update(renderTime, dt);
      if (rp.anim !== ANIM.ragdoll && this.ragdolls.get(rp.id)) this.ragdolls.remove(rp.id);
    }

    if (this.phase === 'playing' && !this.local.ragdolling) this.gameplayChecks();

    // grab tether bookkeeping for the local player
    const partners = this.grab.partnersOf(this.myId);
    this.tetherTo = null;
    if (partners.length > 0) {
      const myPos = this.local.pos();
      let best: THREE.Vector3 | null = null;
      let bestD = Infinity;
      for (const pid of partners) {
        const pp = this.posOf(pid);
        if (!pp) continue;
        const d = pp.distanceToSquared(myPos);
        if (d < bestD) {
          bestD = d;
          best = pp.clone();
        }
      }
      this.tetherTo = best;
      const grabbing = this.grab.isGrabbing(this.myId);
      if (grabbing && bestD > 81) {
        this.grab.set(this.myId, grabbing, false);
        this.net.send({ t: 'grab', target: grabbing, on: false });
      }
    }
    this.grab.update((id) => this.posOf(id));

    // local rig
    const myPos = this.posOf(this.myId)!;
    if (!this.local.ragdolling) {
      this.localRig.group.position.copy(myPos);
      this.localRig.group.rotation.y = this.local.yaw;
      const hSpeed = Math.hypot(this.local.vel.x, this.local.vel.z);
      this.localRig.animate(this.local.anim, this.elapsed, hSpeed, this.local.vel.y);
    }

    // camera + environment + visuals
    const zoomActive = this.inventory === 'telescope' && this.input.zoomHeld;
    this.cam.update(dt, myPos, this.input, this.local.body, zoomActive);
    this.env.update(myPos, this.level.totalHeight);
    this.handles.updateVisuals(this.elapsed);
    const now = performance.now();
    this.pingMarkers = this.pingMarkers.filter((m) => {
      if (now > m.until) {
        this.scene.remove(m.sprite);
        (m.sprite.material as THREE.SpriteMaterial).map?.dispose();
        m.sprite.material.dispose();
        return false;
      }
      m.sprite.position.y += dt * 0.3;
      return true;
    });

    // HUD
    if (this.phase === 'preGo') {
      const left = (this.startAt - serverNow) / 1000;
      if (Number.isFinite(left) && left > 0 && left < 4) {
        const n = this.hud.countdown(left);
        if (n !== null && n > 0) sfx.countdown(false);
      }
      this.hud.setTimer(0);
    } else if (this.phase === 'playing') {
      this.hud.setTimer(serverNow - this.startAt);
    }
    const zone = this.level.zones.find((z) => myPos.y <= z.yEnd + 2) ?? this.level.zones[this.level.zones.length - 1];
    this.hud.setZoneInfo(zone?.label ?? '', myPos.y, this.level.totalHeight);
    this.hud.setTeam(
      this.players.map((p) => {
        const pos = this.posOf(p.id);
        return {
          name: p.id === this.myId ? `${p.name} (you)` : p.name,
          color: `#${this.colorOf(p.id).toString(16).padStart(6, '0')}`,
          height: pos?.y ?? 0,
          finished: this.finishedSet.has(p.id),
        };
      }),
    );
    this.hud.setPointerLocked(this.input.lookActive, this.phase !== 'done');

    // outbound state @ 20Hz
    if (now - this.lastStateSentAt > 1000 / NET.sendHz) {
      this.lastStateSentAt = now;
      const p = this.posOf(this.myId)!;
      this.net.send({
        t: 'state',
        p: [Number(p.x.toFixed(2)), Number(p.y.toFixed(2)), Number(p.z.toFixed(2))],
        yaw: Number(this.local.yaw.toFixed(2)),
        anim: this.local.ragdolling ? ANIM.ragdoll : this.local.anim,
        vy: Number(this.local.vel.y.toFixed(1)),
      });
    }

    this.input.endFrame();
    this.renderer.render(this.scene, this.cam.camera);
  }

  /** Plates, pickups, checkpoints, flag, give/grapple/grab inputs. */
  private gameplayChecks() {
    const myPos = this.local.pos();
    const feetY = myPos.y - 0.7;

    // pressure plates
    for (const plate of this.handles.plates) {
      const key = `${plate.gadgetId}:${plate.plateIdx}`;
      const onIt =
        this.local.grounded &&
        Math.hypot(myPos.x - plate.pos.x, myPos.z - plate.pos.z) < 1.05 &&
        Math.abs(feetY - plate.pos.y) < 1.0;
      if (onIt && !this.platesOn.has(key)) {
        this.platesOn.add(key);
        this.net.send({ t: 'plate', gadget: plate.gadgetId, plate: plate.plateIdx, on: true });
      } else if (!onIt && this.platesOn.has(key)) {
        this.platesOn.delete(key);
        this.net.send({ t: 'plate', gadget: plate.gadgetId, plate: plate.plateIdx, on: false });
      }
    }

    // item pickups
    if (!this.inventory) {
      const now = performance.now();
      for (const item of this.handles.items.values()) {
        if (item.taken) continue;
        if (myPos.distanceToSquared(item.basePos) < GAME.pickupRange * GAME.pickupRange + 1) {
          if ((this.pickupCooldown.get(item.id) ?? 0) < now) {
            this.pickupCooldown.set(item.id, now + 1200);
            this.net.send({ t: 'pickup', item: item.id });
          }
        }
      }
    }

    // checkpoints
    for (const cp of this.level.checkpoints) {
      if (cp.index <= this.local.checkpoint.index) continue;
      if (Math.hypot(myPos.x - cp.pos.x, myPos.z - cp.pos.z) < 2.7 && Math.abs(feetY - cp.pos.y) < 2.5) {
        this.local.checkpoint = { index: cp.index, pos: new THREE.Vector3(cp.pos.x, cp.pos.y + 0.1, cp.pos.z) };
        this.net.send({ t: 'checkpoint', index: cp.index });
        this.hud.toast(`Checkpoint: ${this.level.zones[cp.zone]?.label ?? ''} ✓`, 'good');
        sfx.checkpoint();
      }
    }

    // flag
    if (!this.flagReached) {
      const f = this.level.flagPos;
      if (myPos.distanceToSquared(new THREE.Vector3(f.x, f.y + 1, f.z)) < GAME.flagRange * GAME.flagRange) {
        this.flagReached = true;
        this.net.send({ t: 'flag' });
        sfx.checkpoint();
      }
    }

    // give item
    if (this.input.consumePress('KeyG') && this.inventory) {
      let best: RemotePlayer | null = null;
      let bestD = GAME.giveRange * GAME.giveRange;
      for (const rp of this.remotes.values()) {
        const d = rp.pos.distanceToSquared(myPos);
        if (d < bestD) {
          bestD = d;
          best = rp;
        }
      }
      if (best) {
        this.net.send({ t: 'give', to: best.id });
        sfx.give();
      } else {
        this.hud.toast('No teammate close enough to give to');
      }
    }

    // grapple: raycast where the camera aims, hang a rope from the hit point
    if (this.input.consumePress('KeyQ') && this.inventory === 'grapple') {
      const origin = this.cam.camera.position;
      const dir = this.cam.aimDir();
      const ray = new R_NS.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
      const hit = this.world.castRay(ray, GAME.grappleRange, true, undefined, groups(GROUP_PLAYER, GROUP_LEVEL), undefined, this.local.body);
      if (hit) {
        const pt = ray.pointAt(hit.timeOfImpact);
        if (pt.y > myPos.y + 1.5) {
          const length = THREE.MathUtils.clamp(pt.y - feetY + 1.2, 4, 45);
          this.net.send({ t: 'grapple', top: [pt.x, pt.y, pt.z], length });
        } else {
          this.hud.toast('Aim higher — hook something above you');
        }
      } else {
        this.hud.toast('Nothing in range to hook onto');
      }
    }

    // grab/release
    if (this.input.consumePress('KeyF')) {
      const grabbing = this.grab.isGrabbing(this.myId);
      if (grabbing) {
        this.grab.set(this.myId, grabbing, false);
        this.net.send({ t: 'grab', target: grabbing, on: false });
      } else {
        let best: RemotePlayer | null = null;
        let bestD = GAME.grabRange * GAME.grabRange;
        for (const rp of this.remotes.values()) {
          const d = rp.pos.distanceToSquared(myPos);
          if (d < bestD) {
            bestD = d;
            best = rp;
          }
        }
        if (best) {
          this.grab.set(this.myId, best.id, true);
          this.net.send({ t: 'grab', target: best.id, on: true });
          this.hud.toast(`Holding on to ${best.name} 🤝`);
        }
      }
    }

    // ping
    if (this.input.consumePress('KeyB')) {
      this.net.send({ t: 'ping' });
    }

    // double jump item is passive
    this.local.hasDoubleJump = this.inventory === 'doublejump';
  }

  private resize() {
    this.cam.camera.aspect = window.innerWidth / window.innerHeight;
    this.cam.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  dispose() {
    for (const u of this.unsub) u();
    window.removeEventListener('resize', this.onResize);
    this.renderer.setAnimationLoop(null);
    this.ragdolls.disposeAll();
    this.grab.dispose();
    for (const rp of this.remotes.values()) rp.dispose(this.scene);
    this.remotes.clear();
    this.localRig.dispose();
    this.scene.remove(this.localRig.group);
    this.handles.dispose();
    this.env.dispose();
    this.world.free();
    this.hud.dispose();
    this.input.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    delete (window as unknown as Record<string, unknown>).__onlyUs;
  }
}
