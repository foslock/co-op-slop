import * as THREE from 'three';
import {
  ANIM, COSMETIC_COLORS, CRANK, GAME, LEDGE, MOVE, NET, SEESAW, THEMES, ballisticVelocity, generateLevel, gravityScaleAtY,
  type ItemType, type LevelData, type PlayerInfo, type Pose,
} from 'shared';
import { initPhysics, RAPIER as R_NS, GROUP_PLAYER, GROUP_LEVEL, groups } from './physics';
import { buildLevel, occlusionUniforms, ITEM_COLORS, type Interactable, type LevelHandles } from './levelBuilder';
import { Environment } from './environment';
import { LocalPlayer, type PlayerEvent } from './localPlayer';
import { RemotePlayer } from './remotePlayer';
import { RagdollManager } from './ragdoll';
import { GrabSystem } from './grab';
import { FollowCamera } from './camera';
import { buildCharacter, type CharacterRig } from './characterMesh';
import { Effects } from './effects';
import type { Seesaw } from './contraptions';
import { Hud, type CrosshairMode, type Prompt, type TeamMarker } from '../hud';
import { Input } from '../input';
import type { Net } from '../net';
import { sfx } from '../audio';

const FIXED_DT = 1 / 60;

const ITEM_NAMES: Record<ItemType, string> = {
  doublejump: 'Double Jump boots',
  telescope: 'Telescope',
  grapple: 'Grappling Hook',
};

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
  private teamSize: number;
  private onFinish: (info: FinishInfo) => void;
  private onLeave: () => void;

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
  private fx!: Effects;
  private clock = new THREE.Clock();
  private accumulator = 0;
  private elapsed = 0;
  private unsub: (() => void)[] = [];
  private onResize = () => this.resize();

  private phase: 'preGo' | 'playing' | 'done' = 'preGo';
  private startAt = Infinity;
  /** Shared game time (seconds since GO) that drives the moving platforms. */
  private gameClock = 0;
  private inventory: ItemType | null = null;
  private flagReached = false;
  private finishedSet = new Set<string>();
  private platesOn = new Set<string>();
  private leversOn = new Set<number>();
  private pickupCooldown = new Map<number, number>();
  private tetherTo: THREE.Vector3 | null = null;
  private pingMarkers: { sprite: THREE.Sprite; until: number }[] = [];
  private lastStateSentAt = 0;
  private goPlayed = false;
  private hintsShown = new Set<string>();
  private interactCooldown = new Map<Interactable, number>();
  private paused = false;
  private prevLocked = false;
  private fallCounts = new Map<string, number>();
  /** Team shrank to one climber mid-run: co-op contraptions work solo. */
  private assist = false;
  private pendingFlips = new Map<number, number>(); // seesaw id → clock when the plank snaps over
  private seatSince = new Map<number, number>(); // solo-assist: how long we've sat on each seat
  private helpCooldownUntil = 0;
  private grappleAim: { top: THREE.Vector3; exit: THREE.Vector3 } | null = null;
  private wasHanging = false;

  constructor(
    container: HTMLElement,
    uiRoot: HTMLElement,
    net: Net,
    seed: string,
    teamSize: number,
    players: PlayerInfo[],
    myId: string,
    onFinish: (info: FinishInfo) => void,
    onLeave: () => void,
  ) {
    this.container = container;
    this.net = net;
    this.myId = myId;
    this.players = players;
    this.teamSize = teamSize;
    this.onFinish = onFinish;
    this.onLeave = onLeave;
    this.level = generateLevel(seed, teamSize);
    this.hud = new Hud(uiRoot, {
      onClickToPlay: () => this.input.requestLock(),
      onResume: () => this.closePause(true),
      onLeave: () => {
        this.net.send({ t: 'leave' });
        this.onLeave();
      },
    });
  }

  private openPause() {
    if (this.phase === 'done' || this.paused) return;
    this.paused = true;
    this.input.keys.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.showPause();
  }

  private closePause(relock: boolean) {
    if (!this.paused) return;
    this.paused = false;
    this.hud.hidePause();
    if (relock) this.input.requestLock();
  }

  me(): PlayerInfo {
    return this.players.find((p) => p.id === this.myId)!;
  }

  async init() {
    const R = await initPhysics();
    this.world = new R.World({ x: 0, y: -22, z: 0 });

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);
    this.input = new Input(this.renderer.domElement);
    this.input.onLockFallback = () => {
      this.hud.toast('Pointer lock is blocked here — hold the left mouse button and drag to look around 🖱️');
    };
    this.renderer.domElement.addEventListener('click', () => this.input.requestLock());

    this.env = new Environment(this.scene, this.renderer, this.level);
    this.handles = buildLevel(this.scene, this.world, R, this.level);
    this.fx = new Effects(this.scene);

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
    this.cam = new FollowCamera(window.innerWidth / window.innerHeight);
    this.fx.setViewport(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y, this.cam.camera.fov);

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
      node: (i: number) => {
        const n = this.level.nodes[i];
        if (n) this.local.teleport(new THREE.Vector3(n.x, n.y + 0.1, n.z));
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

  private cssColor(id: string): string {
    return `#${this.colorOf(id).toString(16).padStart(6, '0')}`;
  }

  private posOf(id: string): THREE.Vector3 | null {
    if (id === this.myId) {
      const rd = this.ragdolls.get(this.myId);
      return rd ? rd.torsoPos() : this.local.pos().clone();
    }
    const rp = this.remotes.get(id);
    return rp && rp.pos.y > -50 ? rp.pos : null;
  }

  private hint(key: string, text: string) {
    if (this.hintsShown.has(key)) return;
    this.hintsShown.add(key);
    this.hud.toast(text);
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
        const crank = this.handles.cranks.get(msg.id);
        const wasActive = (bridge?.state ?? crank?.state)?.active ?? false;
        this.handles.setGadgetState(msg.id, msg.state);
        if (msg.state.active && !wasActive) sfx.button();
      }),
      on('launch', (msg) => {
        const sw = this.handles.seesaws.get(msg.gadget);
        if (!sw) return;
        sw.launch(this.gameClock, msg.lever);
        this.pendingFlips.set(msg.gadget, this.gameClock + sw.flipDelay);
        sfx.clack();
        if (msg.lever && msg.by !== this.myId) this.hud.toast(`${this.nameOf(msg.by)} pulled the lever!`);
      }),
      on('help', (msg) => {
        if (msg.target === this.myId) {
          if (this.local.pullUp()) {
            sfx.give();
            this.hud.flash('good');
            this.hud.toast(`${this.nameOf(msg.from)} pulled you up! 🤝`, 'good');
          }
        } else if (msg.from !== this.myId) {
          this.hud.toast(`${this.nameOf(msg.from)} pulled ${this.nameOf(msg.target)} up 🤝`, 'good');
        }
      }),
      on('assist', (msg) => {
        this.assist = msg.on;
        if (msg.on) this.hud.toast('You\'re climbing alone now — the two-player contraptions will work for one', 'good');
      }),
      on('checkpoint', (msg) => {
        if (msg.player !== this.myId) {
          this.hud.toast(`${this.nameOf(msg.player)} reached ${this.level.zones[msg.index]?.label ?? 'a checkpoint'}`, 'good');
        }
      }),
      on('fell', (msg) => {
        if (msg.player !== this.myId) {
          this.fallCounts.set(msg.player, (this.fallCounts.get(msg.player) ?? 0) + 1);
          this.hud.toast(`${this.nameOf(msg.player)} fell! 💨`, 'bad');
        }
      }),
      on('pickup', (msg) => {
        const item = this.handles.items.get(msg.item);
        if (!item) return;
        item.taken = true;
        item.group.visible = false;
        this.fx.burst('sparkle', item.basePos, ITEM_COLORS[item.type]);
        if (msg.player === this.myId) {
          this.inventory = item.type;
          this.hud.setItem(this.inventory);
          sfx.pickup();
        } else {
          this.hud.toast(`${this.nameOf(msg.player)} picked up the ${ITEM_NAMES[item.type]}`);
        }
      }),
      on('item', (msg) => {
        if (msg.player === this.myId) {
          const had = this.inventory;
          this.inventory = msg.item;
          this.hud.setItem(this.inventory);
          if (msg.item && !had) sfx.pickup();
        } else if (msg.item) {
          this.hud.toast(`${this.nameOf(msg.player)} received the ${ITEM_NAMES[msg.item]}`);
        }
      }),
      on('dropped', (msg) => {
        const item = this.handles.items.get(msg.item);
        if (!item) return;
        item.taken = false;
        item.basePos.set(msg.p[0], msg.p[1], msg.p[2]);
        item.group.position.copy(item.basePos);
        item.group.visible = true;
        if (msg.player === this.myId) {
          this.inventory = null;
          this.hud.setItem(null);
          // don't scoop it straight back up while you're still standing on it
          this.pickupCooldown.set(msg.item, performance.now() + 2500);
          this.hud.toast('Item set down — anyone can grab it');
        } else {
          this.hud.toast(`${this.nameOf(msg.player)} set down an item`);
        }
      }),
      on('rope', (msg) => {
        const exit = msg.exit ? { x: msg.exit[0], y: msg.exit[1], z: msg.exit[2] } : undefined;
        this.handles.addRope({ x: msg.top[0], y: msg.top[1], z: msg.top[2] }, msg.length, exit);
        sfx.grapple();
        this.hud.toast(`${this.nameOf(msg.by)} threw a grappling rope! Hold Shift to climb it`);
      }),
      on('grab', (msg) => {
        this.grab.set(msg.from, msg.target, msg.on);
      }),
      on('knock', (msg) => {
        if (msg.player === this.myId) return;
        const rp = this.remotes.get(msg.player);
        const info = this.players.find((q) => q.id === msg.player);
        if (rp && info) {
          this.ragdolls.spawn(
            msg.player, rp.pos.clone(), new THREE.Vector3(...msg.vel), info.cosmetics,
            GAME.ragdollTimeMs + 600, gravityScaleAtY(rp.pos.y, this.level.zones), rp.rig.pose(),
          );
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
        const f = this.level.flagPos;
        this.fx.burst('confetti', new THREE.Vector3(f.x, f.y + 1.5, f.z), undefined, 90);
        if (msg.player === this.myId) {
          this.hud.toast(total > 1 ? `You reached the flag! Waiting for the team… (${msg.done.length}/${total})` : 'You reached the flag! 🚩', 'good');
        } else {
          this.hud.toast(`${this.nameOf(msg.player)} reached the flag! (${msg.done.length}/${total})`, 'good');
        }
      }),
      on('finish', (msg) => {
        this.phase = 'done';
        this.local.control = false;
        this.closePause(false);
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
            this.fx.removeShadow(id);
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
    canvas.width = canvas.height = 128;
    const c = canvas.getContext('2d')!;
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    c.fillStyle = hex;
    c.beginPath();
    c.arc(64, 54, 40, Math.PI, 0);
    c.lineTo(64, 122);
    c.closePath();
    c.fill();
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.stroke();
    c.fillStyle = '#fff';
    c.font = '800 54px "Fredoka", system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('!', 64, 58);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.position.copy(pos);
    sprite.scale.set(1.3, 1.3, 1);
    sprite.renderOrder = 6;
    this.scene.add(sprite);
    this.pingMarkers.push({ sprite, until: performance.now() + 6000 });
  }

  /** Count, announce, and report one of our own falls/resets to the server. */
  private recordOwnFall(toastText: string) {
    this.fallCounts.set(this.myId, (this.fallCounts.get(this.myId) ?? 0) + 1);
    this.net.send({ t: 'fell' });
    this.hud.toast(toastText, 'bad');
    this.hud.flash('bad');
    sfx.fell();
    this.fx.burst('puff', this.local.checkpoint.pos);
  }

  private startLocalRagdoll(vel: THREE.Vector3) {
    if (this.local.ragdolling) return;
    this.local.ragdolling = true;
    // a knocked-over climber isn't standing on anything any more
    for (const key of this.platesOn) {
      const [gadget, plate] = key.split(':').map(Number);
      this.net.send({ t: 'plate', gadget, plate, on: false });
    }
    this.platesOn.clear();
    this.leversOn.clear();
    this.localRig.group.visible = false;
    const pos = this.local.pos().clone();
    // hand over the rig's current pose so the switch to physics is seamless
    const pose = this.localRig.pose();
    this.ragdolls.spawn(this.myId, pos, vel, this.me().cosmetics, GAME.ragdollTimeMs, gravityScaleAtY(pos.y, this.level.zones), pose);
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
      this.recordOwnFall('You fell! Back to the checkpoint');
    } else {
      landing.y += 0.2;
      this.local.teleport(landing);
    }
  }

  /** Keep the platform clock on the server's game time without jerking the decks around. */
  private syncGameClock() {
    if (this.phase === 'preGo') {
      this.gameClock = 0;
      return;
    }
    const target = Math.max(0, (this.net.serverNow() - this.startAt) / 1000);
    const diff = target - this.gameClock;
    if (Math.abs(diff) > 0.5) this.gameClock = target;
    else this.gameClock += diff * 0.05;
  }

  private onPlayerEvent(ev: PlayerEvent) {
    if (ev.type === 'knockdown') this.startLocalRagdoll(ev.vel);
    else if (ev.type === 'fell') this.recordOwnFall('You fell! Back to the checkpoint');
    else if (ev.type === 'ropeGrabbed') this.hint('rope', 'Holding on! W/S to climb or shimmy · A/D to swing · Space to jump off · release Shift to drop');
    else if (ev.type === 'landed') {
      if (ev.impact > 4) {
        const p = this.local.pos();
        this.fx.burst('dust', new THREE.Vector3(p.x, p.y - 0.66, p.z), undefined, ev.impact > 9 ? 16 : 9);
      }
      // landing on a seesaw's raised end slams it
      for (const [id, sw] of this.handles.seesaws) {
        if (ev.handle === sw.kin.collider.handle && ev.impact > 2.5 && sw.alongOf(this.local.pos()) > 0.2) {
          this.net.send({ t: 'slam', gadget: id, lever: false });
        }
      }
    } else if (ev.type === 'ledgeGrabbed') {
      sfx.grapple();
      this.hint('ledge', 'Hanging on! Keep holding Shift — a teammate can pull you up');
    } else if (ev.type === 'ledgeLost') {
      if (ev.timedOut) this.hud.toast('Your grip gave out!', 'bad');
    } else if (ev.type === 'pulledUp') {
      const p = this.local.pos();
      this.fx.burst('sparkle', p, 0xffe066, 16);
    }
  }

  /** A seesaw just snapped over: if we're sitting on its seat, fly. */
  private flingFromSeat(sw: Seesaw) {
    if (this.local.ragdolling || this.local.groundHandle !== sw.kin.collider.handle) return;
    const p = this.local.pos();
    if (sw.alongOf(p) > -0.2) return;
    const feet = { x: p.x, y: p.y - 0.66, z: p.z };
    const target = sw.g.target;
    const g = MOVE.gravity * gravityScaleAtY((feet.y + target.y) / 2 + SEESAW.apexAbove, this.level.zones);
    const v = ballisticVelocity(feet, target, g, SEESAW.apexAbove);
    this.local.launchTo(new THREE.Vector3(target.x, target.y, target.z), new THREE.Vector3(v.x, v.y, v.z), v.time);
    this.hud.flash('launch');
    sfx.jump();
    this.fx.burst('puff', new THREE.Vector3(feet.x, feet.y, feet.z), 0xffe9a8, 14);
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
        const z0 = this.level.zones[0];
        this.hud.zoneBanner(1, z0.label, THEMES.find((t) => t.id === z0.theme)?.flavor ?? '');
        this.hud.toast('Press Esc for controls & pause');
      }
    }

    // pause menu: Escape in drag-look mode, or the browser's pointer-lock exit
    // (Esc never reaches the page while locked — we see the unlock instead)
    if (this.input.consumePress('Escape')) {
      if (this.paused) this.closePause(false);
      else this.openPause();
    }
    if (this.prevLocked && !this.input.locked && !this.paused) this.openPause();
    this.prevLocked = this.input.locked;

    // R: manual reset to the latest checkpoint (for when you're wedged somewhere)
    if (this.phase === 'playing' && !this.paused && this.input.consumePress('KeyR')) {
      if (this.local.ragdolling) {
        this.endLocalRagdoll(true);
      } else {
        this.local.teleport(this.local.checkpoint.pos);
        this.recordOwnFall('Reset to checkpoint');
      }
    }

    const { forward, right } = this.cam.basis();
    const gravityScale = gravityScaleAtY(this.local.pos().y, this.level.zones);
    const ledgeEnabled = this.teamSize >= 2 && !this.assist && this.remotes.size > 0;
    this.syncGameClock();

    // fixed-step simulation
    this.accumulator = Math.min(0.12, this.accumulator + dt);
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      if (this.phase !== 'preGo') this.gameClock += FIXED_DT;
      // contraptions move first, then scene queries are refreshed so the
      // character controller sees every deck where it is this step
      this.handles.stepGadgets(FIXED_DT, this.gameClock);
      this.world.updateSceneQueries();
      for (const [id, at] of this.pendingFlips) {
        if (this.gameClock < at) continue;
        this.pendingFlips.delete(id);
        const sw = this.handles.seesaws.get(id);
        if (sw) this.flingFromSeat(sw);
      }
      this.handles.stepRopes(FIXED_DT, gravityScale);
      const events = this.local.step(FIXED_DT, {
        input: this.input,
        forward,
        right,
        kinematics: this.handles.kinematics,
        climbables: this.handles.climbables,
        ropes: this.handles.ropes,
        tetherTo: this.tetherTo,
        gravityScale,
        ledgeEnabled,
      });
      this.world.step();
      for (const ev of events) this.onPlayerEvent(ev);
    }
    this.handles.syncGadgets(this.elapsed, this.gameClock);

    // ragdoll bookkeeping. A knocked-down player stays down until their body
    // lands and settles — but one that's fallen out of the level never will, so
    // check for that first and send them straight back to the checkpoint.
    let fellOut = false;
    if (this.local.ragdolling) {
      const rd = this.ragdolls.get(this.myId);
      const y = rd ? rd.torsoPos().y : 0;
      if (rd && (y < this.local.checkpoint.pos.y - GAME.respawnFallBelow || y < GAME.killPlaneY)) {
        this.endLocalRagdoll(true);
        fellOut = true;
      }
    }
    const expired = this.ragdolls.syncAndExpire(performance.now());
    for (const id of expired) {
      if (id === this.myId) {
        if (!fellOut) this.endLocalRagdoll(false);
      } else this.ragdolls.remove(id);
    }

    // remote players (also clean up stale remote ragdolls when their anim leaves ragdoll state)
    const renderTime = serverNow - NET.interpDelayMs;
    for (const rp of this.remotes.values()) {
      rp.update(renderTime, dt);
      if (rp.anim !== ANIM.ragdoll && this.ragdolls.get(rp.id)) this.ragdolls.remove(rp.id);
      this.correctRemoteOnDecks(rp);
      // a remote ragdoll is simulated here but should end up where its owner says
      const rd = this.ragdolls.get(rp.id);
      if (rd) {
        const d = rp.pos.clone().sub(rd.torsoPos());
        if (d.lengthSq() > 1) {
          const lv = rd.torso.linvel();
          rd.torso.setLinvel({ x: lv.x + (d.x * 3 - lv.x) * 0.12, y: lv.y + (d.y * 3 - lv.y) * 0.12, z: lv.z + (d.z * 3 - lv.z) * 0.12 }, true);
        }
      }
    }

    const prompt = this.phase === 'playing' && !this.local.ragdolling ? this.gameplayChecks() : null;

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
      // fade yourself out while the telescope zooms so you're not blocking the lens
      this.localRig.setOpacity(1 - THREE.MathUtils.smoothstep(this.cam.zoom, 0.1, 0.6));
    }

    // camera + environment + visuals
    const zoomActive = this.inventory === 'telescope' && this.input.zoomHeld;
    this.cam.update(dt, myPos, this.input, zoomActive, this.local.vel.y);
    this.updateOcclusionFade(myPos);
    this.env.update(myPos, dt, this.cam.camera);
    this.handles.updateVisuals(this.elapsed);
    this.fx.update(dt);
    this.fx.updateShadow(this.myId, this.local.ragdolling ? null : myPos, this.world, R_NS, this.local.body);
    for (const rp of this.remotes.values()) {
      this.fx.updateShadow(rp.id, rp.anim === ANIM.ragdoll || rp.pos.y < -50 ? null : rp.pos, this.world, R_NS);
    }
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

    this.updateHud(serverNow, myPos, gravityScale, prompt);

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

  /**
   * Remote players are drawn ~120 ms in the past, but moving decks are drawn
   * now — so a teammate riding a shuttle would visibly slide off it. Shift
   * anyone standing on a deck by how far the deck has moved since then.
   */
  private correctRemoteOnDecks(rp: RemotePlayer) {
    if (rp.anim === ANIM.ragdoll) return;
    const lag = NET.interpDelayMs / 1000 + 0.05;
    const then: Pose = { x: 0, y: 0, z: 0, rotY: 0 };
    const nowPose: Pose = { x: 0, y: 0, z: 0, rotY: 0 };
    for (const m of this.handles.movers) {
      m.poseAt(this.gameClock - lag, then);
      const [L, , W] = m.g.size;
      // deck-local coordinates at the lagged pose (rotY is a generator heading: direction (cos h, sin h))
      const c = Math.cos(then.rotY);
      const s = Math.sin(then.rotY);
      const dx = rp.pos.x - then.x;
      const dz = rp.pos.z - then.z;
      const along = dx * c + dz * s;
      const across = -dx * s + dz * c;
      const dy = rp.pos.y - 0.66 - then.y;
      if (Math.abs(along) > L / 2 + 0.35 || Math.abs(across) > W / 2 + 0.35 || dy < -0.3 || dy > 0.6) continue;
      // carry them by the deck's rigid motion from then to now
      m.poseAt(this.gameClock, nowPose);
      const da = nowPose.rotY - then.rotY;
      const ca = Math.cos(da);
      const sa = Math.sin(da);
      rp.pos.set(nowPose.x + dx * ca - dz * sa, rp.pos.y + (nowPose.y - then.y), nowPose.z + dx * sa + dz * ca);
      rp.yaw -= da; // a heading turn is the opposite sign of three's Y rotation
      rp.rig.group.position.copy(rp.pos);
      rp.rig.group.rotation.y = rp.yaw;
      return;
    }
    for (const c of this.handles.cranks.values()) {
      const top = c.kin.pos.y + CRANK.deck[1] / 2;
      if (Math.hypot(rp.pos.x - c.kin.pos.x, rp.pos.z - c.kin.pos.z) > CRANK.deck[0] * 0.75) continue;
      const dy = rp.pos.y - 0.66 - top;
      if (dy < -0.8 || dy > 0.8) continue;
      rp.pos.y = top + 0.66;
      rp.rig.group.position.copy(rp.pos);
      return;
    }
  }

  /** Plates, pickups, checkpoints, flag, give/grapple/grab/help inputs. Returns the contextual prompt. */
  private gameplayChecks(): Prompt | null {
    const myPos = this.local.pos();
    const feetY = myPos.y - 0.7;
    let prompt: Prompt | null = null;

    // pressure plates (bridges and crank lifts)
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
    // a lone climber's weight on a crank lift's deck works the crank
    for (const [id, c] of this.handles.cranks) {
      const key = `${id}:2`;
      const onIt = this.assist && this.local.groundHandle === c.kin.collider.handle;
      if (onIt && !this.platesOn.has(key)) {
        this.platesOn.add(key);
        this.net.send({ t: 'plate', gadget: id, plate: 2, on: true });
      } else if (!onIt && this.platesOn.has(key)) {
        this.platesOn.delete(key);
        this.net.send({ t: 'plate', gadget: id, plate: 2, on: false });
      }
    }

    // seesaw levers: stepping on drops the weight
    for (const lv of this.handles.levers) {
      const onIt = this.local.grounded && Math.hypot(myPos.x - lv.pos.x, myPos.z - lv.pos.z) < 1.0 && Math.abs(feetY - lv.pos.y) < 0.9;
      if (onIt && !this.leversOn.has(lv.gadgetId)) {
        this.leversOn.add(lv.gadgetId);
        this.net.send({ t: 'slam', gadget: lv.gadgetId, lever: true });
      } else if (!onIt) this.leversOn.delete(lv.gadgetId);
    }
    // sitting on a seesaw seat
    for (const [id, sw] of this.handles.seesaws) {
      const seated = this.local.grounded && this.local.groundHandle === sw.kin.collider.handle && sw.alongOf(myPos) < -0.2;
      if (!seated) {
        this.seatSince.delete(id);
        continue;
      }
      if (this.assist) {
        // nobody left to slam it: sitting still for a moment works the seesaw
        const since = this.seatSince.get(id) ?? this.elapsed;
        this.seatSince.set(id, since);
        if (this.elapsed - since > 1.2) {
          this.seatSince.set(id, this.elapsed + 2);
          this.net.send({ t: 'slam', gadget: id, lever: false });
        }
        prompt = { key: '…', text: 'Sit tight — launching!' };
      } else {
        prompt = { key: '2+', text: 'Sit tight — a teammate jumps on the far end to launch you' };
      }
    }

    // touch-responsive props: cosmetic only — a wiggle and a noise, no collision change
    for (const it of this.handles.interactables) {
      if (it.startedAt >= 0 || this.elapsed - (this.interactCooldown.get(it) ?? -99) < 1.4) continue;
      if (myPos.distanceToSquared(it.pos) > it.def.radius * it.def.radius) continue;
      it.startedAt = this.elapsed;
      this.interactCooldown.set(it, this.elapsed + it.def.duration);
      sfx[it.def.sound]();
      if (it.def.hint) this.hint('interact', it.def.hint);
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
        const zone = this.level.zones[cp.zone];
        this.hud.zoneBanner(cp.index + 1, zone?.label ?? '', THEMES.find((t) => t.id === zone?.theme)?.flavor ?? '');
        this.hud.flash('good');
        this.handles.setCheckpointReached(cp.index);
        this.fx.burst('confetti', new THREE.Vector3(cp.pos.x, cp.pos.y + 1.2, cp.pos.z));
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

    // nearest teammate, for giving items / holding hands
    let nearest: RemotePlayer | null = null;
    let nearestD = GAME.giveRange * GAME.giveRange;
    for (const rp of this.remotes.values()) {
      const d = rp.pos.distanceToSquared(myPos);
      if (d < nearestD) {
        nearestD = d;
        nearest = rp;
      }
    }

    // give item — or, with nobody in range, set it down where you're standing
    if (this.input.consumePress('KeyG') && this.inventory) {
      if (nearest) this.net.send({ t: 'give', to: nearest.id });
      else this.net.send({ t: 'drop', p: this.dropSpot(myPos) });
      sfx.give();
    }

    // grapple: aim where the camera points, anchor on the top edge of what you hit
    this.grappleAim = this.inventory === 'grapple' ? this.findGrappleAnchor(myPos) : null;
    if (this.input.consumePress('KeyQ') && this.inventory === 'grapple') {
      const aim = this.grappleAim;
      if (aim) {
        const length = THREE.MathUtils.clamp(aim.top.y - feetY + 1.2, 4, 45);
        this.net.send({
          t: 'grapple',
          top: [aim.top.x, aim.top.y, aim.top.z],
          length,
          exit: [aim.exit.x, aim.exit.y, aim.exit.z],
        });
      } else {
        this.hud.toast('Aim at something above you to hook onto');
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

    // pull up a teammate hanging off a ledge next to you
    let hanging: RemotePlayer | null = null;
    let hangD = LEDGE.helpRange;
    for (const rp of this.remotes.values()) {
      if (rp.anim !== ANIM.hang) continue;
      const handsY = rp.pos.y + 0.45;
      const d = Math.hypot(myPos.x - rp.pos.x, myPos.z - rp.pos.z);
      if (d < hangD && feetY > handsY - 0.7 && feetY < handsY + 1.4) {
        hangD = d;
        hanging = rp;
      }
    }
    const shiftPressed = this.input.consumePress('ShiftLeft') || this.input.consumePress('ShiftRight');
    if (hanging && !this.local.isClimbing()) {
      prompt = { key: 'Shift', text: `Pull ${hanging.name} up!` };
      if (shiftPressed && this.elapsed > this.helpCooldownUntil) {
        this.helpCooldownUntil = this.elapsed + 0.8;
        this.net.send({ t: 'help', target: hanging.id });
        this.hud.toast(`You pulled ${hanging.name} up! 🤝`, 'good');
        sfx.give();
      }
    }

    // ping
    if (this.input.consumePress('KeyB')) {
      this.net.send({ t: 'ping' });
    }

    // double jump item is passive
    this.local.hasDoubleJump = this.inventory === 'doublejump';

    // contextual prompt, most urgent first
    if (this.local.isHanging()) return { key: 'Shift', text: 'Keep holding — a teammate can pull you up' };
    if (prompt) return prompt;
    if (!this.local.isClimbing()) {
      const hands = new THREE.Vector3(myPos.x, myPos.y + 0.35, myPos.z);
      const nearRope = this.handles.ropes.some((r) => r.nearest(hands).dist < 1.6);
      const nearLadder = this.handles.climbables.some((c) => myPos.y > c.a.y - 0.6 && myPos.y < c.b.y + 0.6 &&
        Math.hypot(myPos.x - c.a.x, myPos.z - c.a.z) < 1.6);
      if (nearRope || nearLadder) return { key: 'Shift', text: nearLadder ? 'Hold to climb the ladder' : 'Hold to grab the rope' };
    }
    if (this.grappleAim) return { key: 'Q', text: 'Throw the grappling hook' };
    if (nearest && this.inventory) return { key: 'G', text: `Give ${nearest.name} your ${ITEM_NAMES[this.inventory]}` };
    return null;
  }

  /**
   * Where a grappling rope would hang if thrown now. The ray starts level with
   * the player (not at the camera, which can sit behind or inside a prop), and a
   * hit on a wall or underside is walked up to the top edge so the rope hangs
   * off a lip you can actually climb onto.
   */
  private findGrappleAnchor(myPos: THREE.Vector3): { top: THREE.Vector3; exit: THREE.Vector3 } | null {
    const camPos = this.cam.camera.position;
    const dir = this.cam.aimDir();
    const head = myPos.clone().setY(myPos.y + 0.45);
    const skip = Math.max(0, head.clone().sub(camPos).dot(dir));
    const origin = camPos.clone().addScaledVector(dir, skip);
    const filter = groups(GROUP_PLAYER, GROUP_LEVEL);
    const hit = this.world.castRayAndGetNormal(new R_NS.Ray(origin, dir), GAME.grappleRange, true, undefined, filter, undefined, this.local.body);
    if (!hit || hit.timeOfImpact < 0.05) return null;
    const pt = origin.clone().addScaledVector(dir, hit.timeOfImpact);
    const down = (x: number, y: number, z: number, len: number) => {
      const r = this.world.castRayAndGetNormal(new R_NS.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }), len, true, undefined, filter, undefined, this.local.body);
      return r && r.timeOfImpact > 0.01 && r.normal.y > 0.6 ? y - r.timeOfImpact : null;
    };
    // horizontal direction from the hit back toward us: the lip we hang from faces us
    const back = new THREE.Vector3(myPos.x - pt.x, 0, myPos.z - pt.z);
    if (back.lengthSq() < 1e-4) return null;
    back.normalize();
    let topY: number | null = null;
    let lip = pt.clone();
    if (hit.normal.y > 0.6) {
      // landed on a top surface: walk toward the player until the surface ends
      topY = pt.y;
      for (let k = 1; k <= 40; k++) {
        const p = pt.clone().addScaledVector(back, k * 0.15);
        const y = down(p.x, topY + 0.4, p.z, 0.8);
        if (y === null) break;
        lip = p;
      }
    } else {
      // a wall or underside: find the top above the hit, just behind the face
      const n = new THREE.Vector3(hit.normal.x, 0, hit.normal.z);
      const inward = n.lengthSq() > 1e-4 ? n.normalize().negate() : back.clone().negate();
      const probe = pt.clone().addScaledVector(inward, 0.3);
      for (const lift of [3, 6, 10]) {
        const y = down(probe.x, pt.y + lift, probe.z, lift + 0.5);
        if (y !== null && y > pt.y - 0.3) {
          topY = y;
          break;
        }
      }
      if (topY === null) return null;
      lip = pt.clone();
    }
    if (topY === null || topY < myPos.y + 1.5) return null;
    const top = lip.clone().addScaledVector(back, 0.3);
    top.y = topY + 0.3;
    const exit = lip.clone().addScaledVector(back, -0.7);
    exit.y = topY + 0.05;
    return { top, exit };
  }

  private updateHud(serverNow: number, myPos: THREE.Vector3, gravityScale: number, prompt: Prompt | null) {
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
    // the zone you're in is the highest one whose floor you've passed
    const feetY = myPos.y - 0.66;
    let zone = this.level.zones[0];
    for (const z of this.level.zones) if (feetY >= z.yStart - 0.1) zone = z;
    this.hud.setZoneInfo(zone?.label ?? '', myPos.y, this.level.totalHeight, gravityScale);
    this.hud.setTeam(
      this.players.map((p) => {
        const pos = this.posOf(p.id);
        return {
          name: p.id === this.myId ? `${p.name} (you)` : p.name,
          color: this.cssColor(p.id),
          height: pos?.y ?? 0,
          finished: this.finishedSet.has(p.id),
          falls: this.fallCounts.get(p.id) ?? 0,
        };
      }),
    );
    this.hud.setAltimeter({
      total: this.level.totalHeight,
      checkpoints: this.level.zones.slice(1).map((z) => ({
        height: z.yStart, label: z.label, reached: this.local.checkpoint.index >= z.index,
      })),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: this.cssColor(p.id),
        height: this.posOf(p.id)?.y ?? 0,
        me: p.id === this.myId,
        finished: this.finishedSet.has(p.id),
      })),
    });
    // teammate markers
    const cam = this.cam.camera;
    const camDir = cam.getWorldDirection(new THREE.Vector3());
    const markers: TeamMarker[] = [];
    for (const rp of this.remotes.values()) {
      if (rp.pos.y < -50) continue;
      const head = rp.pos.clone().setY(rp.pos.y + 1.0);
      const behind = head.clone().sub(cam.position).dot(camDir) < 0;
      const ndc = head.clone().project(cam);
      markers.push({
        id: rp.id, name: rp.name, color: this.cssColor(rp.id),
        ndcX: ndc.x, ndcY: ndc.y, behind, distance: rp.pos.distanceTo(myPos),
      });
    }
    this.hud.setMarkers(markers);
    let cross: CrosshairMode = 'hidden';
    if (this.inventory === 'grapple' && this.phase === 'playing') cross = this.grappleAim ? 'aim-ok' : 'aim-bad';
    else if (this.inventory === 'telescope' && this.cam.zoom > 0.5) cross = 'dot';
    this.hud.setCrosshair(cross);
    this.hud.setPrompt(this.phase === 'playing' ? prompt : null);
    const remaining = this.local.hangRemaining();
    this.hud.setHangTimer(remaining !== null ? { remaining, total: LEDGE.hangSeconds } : null);
    if (remaining !== null && !this.wasHanging) this.wasHanging = true;
    if (remaining === null) this.wasHanging = false;
    this.hud.setPointerLocked(this.input.lookActive, this.phase !== 'done' && !this.paused);
  }

  /** Where a dropped item lands: the surface under your feet, or your feet if there's nothing below. */
  private dropSpot(myPos: THREE.Vector3): [number, number, number] {
    const feetY = myPos.y - 0.7;
    const ray = new R_NS.Ray({ x: myPos.x, y: feetY + 0.2, z: myPos.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 3, true, undefined, groups(GROUP_PLAYER, GROUP_LEVEL), undefined, this.local.body);
    const y = hit ? feetY + 0.2 - hit.timeOfImpact + 0.7 : feetY + 0.7;
    return [Number(myPos.x.toFixed(2)), Number(y.toFixed(2)), Number(myPos.z.toFixed(2))];
  }

  /** Feed the occlusion-fade shader the player's screen position, view depth, and cutout radius. */
  private updateOcclusionFade(myPos: THREE.Vector3) {
    const cam = this.cam.camera;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const center = myPos.clone();
    center.y += 0.2;
    const depth = -center.clone().applyMatrix4(cam.matrixWorldInverse).z;
    const ndc = center.project(cam);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    occlusionUniforms.uOccDepth.value = depth;
    occlusionUniforms.uOccCenter.value.set((ndc.x * 0.5 + 0.5) * size.x, (ndc.y * 0.5 + 0.5) * size.y);
    const halfFovTan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    occlusionUniforms.uOccRadius.value = (1.4 / Math.max(1, depth) / halfFovTan) * (size.y / 2);
  }

  private resize() {
    this.cam.camera.aspect = window.innerWidth / window.innerHeight;
    this.cam.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.fx.setViewport(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y, this.cam.camera.fov);
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
    this.fx.dispose();
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
