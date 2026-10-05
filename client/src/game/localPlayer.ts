import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ANIM, GAME, LEDGE, MOVE, PLAYER, TRAVERSE } from 'shared';
import { GROUP_LEVEL, GROUP_PLAYER, groups } from './physics';
import type { Climbable } from './levelBuilder';
import type { Kinematic } from './kinematic';
import type { Rope } from './rope';
import type { Input } from '../input';
import { sfx } from '../audio';

export interface StepCtx {
  input: Input;
  forward: THREE.Vector3; // camera-relative horizontal basis
  right: THREE.Vector3;
  kinematics: Map<number, Kinematic>; // moving colliders by handle
  climbables: Climbable[];
  ropes: Rope[];
  tetherTo: THREE.Vector3 | null;
  gravityScale: number; // altitude-based: 1.0 at ground level → 0.55 in space
  ledgeEnabled: boolean; // co-op ledge hangs — off for a solo climber
}

export type PlayerEvent =
  | { type: 'knockdown'; vel: THREE.Vector3 }
  | { type: 'fell' }
  | { type: 'ropeGrabbed' }
  | { type: 'landed'; impact: number; handle: number | null }
  | { type: 'ledgeGrabbed' }
  | { type: 'ledgeLost'; timedOut: boolean }
  | { type: 'pulledUp' };

type Grip =
  | { kind: 'ladder'; line: Climbable; t: number }
  | { kind: 'rope'; rope: Rope; s: number; along: number }
  // hands on a ledge lip; stored in the collider's local frame when it moves
  | { kind: 'ledge'; kin: Kinematic | null; hands: THREE.Vector3; normal: THREE.Vector3; timer: number };

const HALF = PLAYER.capsuleHalfHeight + PLAYER.capsuleRadius; // body center to feet
const ROT0 = { x: 0, y: 0, z: 0, w: 1 };

export class LocalPlayer {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private world: RAPIER.World;
  private R: typeof RAPIER;
  private capsule: RAPIER.Capsule;
  private probeBall: RAPIER.Ball;

  vel = new THREE.Vector3();
  yaw = 0;
  anim: number = ANIM.idle;
  grounded = false;
  control = false;
  ragdolling = false;
  hasDoubleJump = false;
  checkpoint: { index: number; pos: THREE.Vector3 } = { index: 0, pos: new THREE.Vector3(0, 2, 0) };
  /** Collider we're standing on (set at the end of each step). */
  groundHandle: number | null = null;

  private lastGroundedAt = -10;
  private jumpBufferedAt = -10;
  private jumpsUsed = 0;
  private grip: Grip | null = null;
  private pull: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private launch: { target: THREE.Vector3; until: number } | null = null;
  private platformVel = new THREE.Vector3();
  private requireGrabRelease = false;
  private climbCooldownUntil = 0;
  private time = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(world: RAPIER.World, R: typeof RAPIER, spawn: THREE.Vector3) {
    this.world = world;
    this.R = R;
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + 0.7, spawn.z),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(PLAYER.capsuleHalfHeight, PLAYER.capsuleRadius)
        .setCollisionGroups(groups(GROUP_PLAYER, GROUP_LEVEL)),
      this.body,
    );
    this.capsule = new R.Capsule(PLAYER.capsuleHalfHeight, PLAYER.capsuleRadius);
    this.probeBall = new R.Ball(0.24);
    this.controller = world.createCharacterController(0.06);
    this.controller.enableAutostep(0.5, 0.2, true);
    this.controller.enableSnapToGround(0.45);
    this.controller.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.checkpoint.pos.copy(spawn);
  }

  pos(): THREE.Vector3 {
    const t = this.body.translation();
    return this.tmp.set(t.x, t.y, t.z);
  }

  teleport(p: THREE.Vector3) {
    this.body.setTranslation({ x: p.x, y: p.y + 0.7, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + 0.7, z: p.z });
    this.vel.set(0, 0, 0);
    this.releaseGrip();
    this.pull = null;
    this.launch = null;
    this.platformVel.set(0, 0, 0);
    this.groundHandle = null;
    this.jumpsUsed = 0;
  }

  private releaseGrip() {
    if (this.grip?.kind === 'rope') this.grip.rope.setRider(null);
    this.grip = null;
  }

  setPositionDirect(p: THREE.Vector3) {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
  }

  /** Move the body before this step's character-controller query (carrying, pushing). */
  private shiftBody(p: THREE.Vector3) {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  isClimbing(): boolean {
    return this.grip !== null || this.pull !== null;
  }

  /** Hanging off a ledge: seconds left before the grip gives out, else null. */
  hangRemaining(): number | null {
    return this.grip?.kind === 'ledge' ? Math.max(0, LEDGE.hangSeconds - this.grip.timer) : null;
  }

  isHanging(): boolean {
    return this.grip?.kind === 'ledge';
  }

  /** A teammate grabbed our hand: haul us up onto the ledge. */
  pullUp(): boolean {
    if (this.grip?.kind !== 'ledge') return false;
    const { hands, normal } = this.ledgeWorld(this.grip);
    const from = this.pos().clone();
    const to = hands.clone().addScaledVector(normal, -0.6);
    to.y = hands.y + HALF + 0.04;
    this.grip = null;
    this.pull = { from, to, t: 0 };
    this.vel.set(0, 0, 0);
    return true;
  }

  /** Seesaw: fly toward `target` (a surface point), steering mid-air so the landing is reliable. */
  launchTo(target: THREE.Vector3, vel: THREE.Vector3, flightTime: number) {
    this.releaseGrip();
    this.pull = null;
    this.vel.copy(vel);
    this.grounded = false;
    this.groundHandle = null;
    this.platformVel.set(0, 0, 0);
    this.launch = { target: target.clone(), until: this.time + flightTime + 0.8 };
  }

  private ledgeWorld(g: Extract<Grip, { kind: 'ledge' }>): { hands: THREE.Vector3; normal: THREE.Vector3 } {
    if (!g.kin) return { hands: g.hands.clone(), normal: g.normal.clone() };
    return { hands: g.kin.toWorld(g.hands), normal: g.normal.clone().applyQuaternion(g.kin.quat).setY(0).normalize() };
  }

  /** Probe for a ledge lip just above our reach in direction `dir`. */
  private findLedge(pos: THREE.Vector3, dir: THREE.Vector3, ctx: StepCtx): Grip | null {
    const filter = groups(GROUP_PLAYER, GROUP_LEVEL);
    const origin = { x: pos.x, y: pos.y + 0.2, z: pos.z };
    const wallHit = this.world.castRayAndGetNormal(new this.R.Ray(origin, { x: dir.x, y: 0, z: dir.z }), PLAYER.capsuleRadius + 0.45, true, undefined, filter, undefined, this.body);
    if (!wallHit || wallHit.timeOfImpact < 0.01 || Math.abs(wallHit.normal.y) > 0.45) return null;
    const n = new THREE.Vector3(wallHit.normal.x, 0, wallHit.normal.z).normalize();
    const wx = origin.x + dir.x * wallHit.timeOfImpact;
    const wz = origin.z + dir.z * wallHit.timeOfImpact;
    // look down onto the lip just behind the wall face; starting inside geometry
    // means the wall carries on upward, so there's nothing to catch
    const probeTop = pos.y + LEDGE.reach + 0.5;
    const topHit = this.world.castRayAndGetNormal(
      new this.R.Ray({ x: wx - n.x * 0.25, y: probeTop, z: wz - n.z * 0.25 }, { x: 0, y: -1, z: 0 }),
      LEDGE.reach + 0.8, true, undefined, filter, undefined, this.body,
    );
    if (!topHit || topHit.timeOfImpact < 0.02 || topHit.normal.y < 0.7) return null;
    const topY = probeTop - topHit.timeOfImpact;
    if (topY < pos.y + 0.1 || topY > pos.y + LEDGE.reach) return null;
    // and room to be pulled up onto it
    const clear = this.world.castRay(new this.R.Ray({ x: wx - n.x * 0.5, y: topY + 0.05, z: wz - n.z * 0.5 }, { x: 0, y: 1, z: 0 }), 1.4, true, undefined, filter, undefined, this.body);
    if (clear) return null;
    const lip = new THREE.Vector3(wx, topY, wz);
    const kin = ctx.kinematics.get(topHit.collider.handle) ?? null;
    if (kin) {
      const inv = kin.quat.clone().invert();
      return { kind: 'ledge', kin, hands: kin.toLocal(lip), normal: n.clone().applyQuaternion(inv), timer: 0 };
    }
    return { kind: 'ledge', kin: null, hands: lip, normal: n, timer: 0 };
  }

  /** Run one fixed physics step. Returns gameplay events for the orchestrator. */
  step(dt: number, ctx: StepCtx): PlayerEvent[] {
    this.time += dt;
    const events: PlayerEvent[] = [];
    const t = this.body.translation();
    const pos = new THREE.Vector3(t.x, t.y, t.z);

    if (this.ragdolling) {
      this.anim = ANIM.ragdoll;
      return events;
    }

    // ---- respawn rules ----
    const feetY = pos.y - 0.7;
    if (
      pos.y < GAME.killPlaneY ||
      (this.vel.y < -6 && feetY < this.checkpoint.pos.y - GAME.respawnFallBelow && !this.grip && !this.pull)
    ) {
      this.teleport(this.checkpoint.pos);
      events.push({ type: 'fell' });
      return events;
    }

    // ---- ride whatever moved under us ----
    // Moving colliders were advanced (and scene queries refreshed) before this
    // step, so the deck already sits at its new pose: carry the body by the same
    // rigid motion first, then run the controller from there.
    if (!this.grip && !this.pull && this.groundHandle !== null) {
      const kin = ctx.kinematics.get(this.groundHandle);
      if (kin?.moved) {
        const carried = kin.carry(pos, this.tmp2);
        this.platformVel.subVectors(carried, pos).divideScalar(dt);
        this.yaw += kin.yawDelta();
        pos.copy(carried);
        this.shiftBody(pos);
      } else {
        this.platformVel.set(0, 0, 0);
      }
    }
    // ...and get shoved by a moving collider that swept into us
    if (!this.grip && !this.pull && ctx.kinematics.size > 0) {
      const pushers: Kinematic[] = [];
      this.world.intersectionsWithShape(pos, ROT0, this.capsule, (c) => {
        const kin = ctx.kinematics.get(c.handle);
        if (kin?.moved && c.handle !== this.groundHandle) pushers.push(kin);
        return true;
      }, undefined, groups(GROUP_PLAYER, GROUP_LEVEL), this.collider, this.body);
      for (const kin of pushers) {
        pos.copy(kin.carry(pos, this.tmp2));
        pos.y += 0.02;
      }
      if (pushers.length > 0) this.shiftBody(pos);
    }

    if (!this.control) {
      this.anim = ANIM.idle;
      return events;
    }

    const input = ctx.input;
    const f = (input.keys.has('KeyW') ? 1 : 0) - (input.keys.has('KeyS') ? 1 : 0);
    const s = (input.keys.has('KeyD') ? 1 : 0) - (input.keys.has('KeyA') ? 1 : 0);

    if (input.consumePress('Space')) this.jumpBufferedAt = this.time;

    // Ropes, ladders and ledges are held, not magnetised to: you only catch one
    // while Shift is down, and letting go of Shift lets go.
    const holdingGrab = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
    if (!holdingGrab) this.requireGrabRelease = false;

    // ---- being hauled up a ledge by a teammate ----
    if (this.pull) {
      this.pull.t = Math.min(1, this.pull.t + dt / LEDGE.pullTime);
      const u = this.pull.t;
      const lift = this.tmp2.set(this.pull.from.x, this.pull.to.y + 0.15, this.pull.from.z);
      const p = u < 0.6
        ? this.pull.from.clone().lerp(lift, u / 0.6)
        : lift.clone().lerp(this.pull.to, (u - 0.6) / 0.4);
      this.setPositionDirect(p);
      this.anim = ANIM.climb;
      if (u >= 1) {
        this.pull = null;
        this.vel.set(0, 0, 0);
        this.jumpsUsed = 0;
        this.climbCooldownUntil = this.time + 0.4;
        events.push({ type: 'pulledUp' });
      }
      return events;
    }

    if (this.grip) {
      const jumpOff = this.time - this.jumpBufferedAt < MOVE.jumpBuffer;
      const grip = this.grip;
      if (grip.kind === 'ledge') {
        grip.timer += dt;
        const { hands, normal } = this.ledgeWorld(grip);
        const timedOut = grip.timer >= LEDGE.hangSeconds;
        if (!holdingGrab || jumpOff || timedOut || input.consumePress('KeyE')) {
          // grip gives out: drop away from the wall
          this.jumpBufferedAt = -10;
          this.grip = null;
          this.requireGrabRelease = true;
          this.climbCooldownUntil = this.time + 0.35;
          this.vel.set(normal.x * 1.2, -1, normal.z * 1.2);
          events.push({ type: 'ledgeLost', timedOut });
        } else {
          const p = hands.addScaledVector(normal, PLAYER.capsuleRadius + 0.05);
          p.y -= 0.45;
          this.setPositionDirect(p);
          this.yaw = Math.atan2(-normal.x, -normal.z);
          this.anim = ANIM.hang;
          this.grounded = false;
          return events;
        }
      } else if (!holdingGrab || jumpOff || input.consumePress('KeyE')) {
        // Let go. Jumping off pushes you away; simply releasing Shift drops you,
        // carrying whatever the rope was swinging you at.
        const launch = new THREE.Vector3();
        if (grip.kind === 'rope') grip.rope.velocityAt(grip.s, dt, launch).multiplyScalar(0.6);
        this.jumpBufferedAt = -10;
        this.climbCooldownUntil = this.time + 0.35;
        this.vel.set(launch.x, Math.min(0, launch.y), launch.z);
        if (jumpOff) {
          this.vel.y = MOVE.jumpVelocity * 0.85;
          this.vel.addScaledVector(ctx.forward, 3.2);
          sfx.jump();
        }
        this.releaseGrip();
      } else if (grip.kind === 'ladder') {
        const { line } = grip;
        const len = Math.max(0.1, line.a.distanceTo(line.b));
        grip.t = THREE.MathUtils.clamp(grip.t + (f * MOVE.climbSpeed * dt) / len, 0, 1);
        if (grip.t >= 1) {
          this.releaseGrip();
          this.teleport(line.exit);
          this.vel.y = 1.5;
          this.climbCooldownUntil = this.time + 0.5;
          // must not fall through: the movement code below works off the
          // position read at the top of this step and would undo the teleport
          return events;
        }
        if (grip.t <= 0 && f < 0) {
          // stepped off the bottom rung
          this.releaseGrip();
          this.climbCooldownUntil = this.time + 0.4;
        } else {
          const p = line.a.clone().lerp(line.b, grip.t);
          const face = line.exitDir;
          p.addScaledVector(face, -0.38);
          p.y += 0.7;
          this.setPositionDirect(p);
          this.yaw = Math.atan2(face.x, face.z);
          this.anim = ANIM.climb;
          this.grounded = false;
          return events;
        }
      } else if (grip.rope.kind === 'hang') {
        // Vertical rope: W climbs toward the anchor, A/D pump a swing. The rope is
        // simulated, so your position follows it as it swings under your weight.
        const { rope } = grip;
        grip.s = THREE.MathUtils.clamp(grip.s - (f * MOVE.climbSpeed * dt) / Math.max(0.1, rope.span), 0.02, 1);
        rope.setRider(grip.s);
        if (s !== 0) rope.pump(grip.s, this.tmp2.copy(ctx.right).multiplyScalar(s * 10), dt);
        if (grip.s <= 0.03 && f > 0) {
          const exit = rope.exitPoint(0, new THREE.Vector3());
          this.releaseGrip();
          this.teleport(exit);
          this.vel.y = 1.5;
          this.climbCooldownUntil = this.time + 0.5;
          return events;
        }
        const p = rope.pointAt(grip.s);
        const face = rope.exitDir ?? ctx.forward;
        p.addScaledVector(face, -0.3);
        p.y -= 0.35; // hands on the rope, body below
        this.setPositionDirect(p);
        this.yaw = Math.atan2(face.x, face.z);
        this.anim = ANIM.climb;
        this.grounded = false;
        return events;
      } else {
        // Strung rope: W/S shimmy along it in whichever direction you're looking.
        // Looking across the rope keeps the previous direction instead of flickering.
        const { rope } = grip;
        const dot = ctx.forward.dot(rope.dir);
        if (Math.abs(dot) > 0.25) grip.along = dot >= 0 ? 1 : -1;
        const along = grip.along;
        grip.s = THREE.MathUtils.clamp(grip.s + (f * along * TRAVERSE.shimmySpeed * dt) / Math.max(0.1, rope.span), 0.02, 0.98);
        rope.setRider(grip.s);
        const pushingOut = f * along;
        if ((grip.s <= 0.03 && pushingOut < 0) || (grip.s >= 0.97 && pushingOut > 0)) {
          // reached an end — haul yourself up onto that platform
          const exit = rope.exitPoint(grip.s, new THREE.Vector3());
          this.releaseGrip();
          this.teleport(exit);
          this.vel.y = 1.5;
          this.climbCooldownUntil = this.time + 0.5;
          return events;
        }
        const p = rope.pointAt(grip.s);
        p.y -= TRAVERSE.hangDrop;
        this.setPositionDirect(p);
        this.yaw = Math.atan2(rope.dir.x * along, rope.dir.z * along);
        this.anim = ANIM.climb;
        this.grounded = false;
        return events;
      }
    }

    // ---- catch a rope or ladder (only while Shift is held) ----
    if (!this.grip && holdingGrab && this.time > this.climbCooldownUntil) {
      const hands = new THREE.Vector3(pos.x, pos.y + 0.35, pos.z);
      let bestD = 1.35;
      let bestRope: Rope | null = null;
      let bestS = 0;
      for (const rope of ctx.ropes) {
        const { s: rs, dist } = rope.nearest(hands);
        if (dist < bestD) {
          bestD = dist;
          bestS = rs;
          bestRope = rope;
        }
      }
      let bestLine: Climbable | null = null;
      let bestT = 0;
      let bestLineD = bestD;
      for (const c of ctx.climbables) {
        if (pos.y < c.a.y - 0.6 || pos.y > c.b.y + 0.6) continue;
        const lt = THREE.MathUtils.clamp((pos.y - 0.7 - c.a.y) / Math.max(0.1, c.b.y - c.a.y), 0, 0.97);
        const lp = this.tmp2.copy(c.a).lerp(c.b, lt);
        const d = Math.hypot(pos.x - lp.x, pos.z - lp.z);
        if (d < bestLineD) {
          bestLineD = d;
          bestLine = c;
          bestT = lt;
        }
      }
      if (bestLine) {
        this.grip = { kind: 'ladder', line: bestLine, t: bestT };
        this.vel.set(0, 0, 0);
        this.launch = null;
        this.anim = ANIM.climb;
        events.push({ type: 'ropeGrabbed' });
        return events;
      }
      if (bestRope) {
        // never start right at an end, or you'd be bounced straight off again
        const s0 = bestRope.kind === 'span' ? THREE.MathUtils.clamp(bestS, 0.06, 0.94) : THREE.MathUtils.clamp(bestS, 0.06, 1);
        bestRope.nudge(s0, this.vel, dt); // your momentum sets the rope swinging
        bestRope.setRider(s0);
        const dot = ctx.forward.dot(bestRope.dir);
        this.grip = { kind: 'rope', rope: bestRope, s: s0, along: dot >= 0 ? 1 : -1 };
        this.vel.set(0, 0, 0);
        this.launch = null;
        this.anim = ANIM.climb;
        sfx.grapple();
        events.push({ type: 'ropeGrabbed' });
        return events;
      }
    }

    // ---- catch a ledge you didn't quite clear (co-op) ----
    if (
      ctx.ledgeEnabled && !this.grounded && holdingGrab && !this.requireGrabRelease &&
      this.time > this.climbCooldownUntil && this.vel.y < 2.5
    ) {
      const hv = this.tmp2.set(this.vel.x, 0, this.vel.z);
      const dirs: THREE.Vector3[] = [];
      if (hv.lengthSq() > 0.6) dirs.push(hv.clone().normalize());
      dirs.push(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)));
      for (const d of dirs) {
        const g = this.findLedge(pos, d, ctx);
        if (g) {
          this.grip = g;
          this.vel.set(0, 0, 0);
          this.launch = null;
          this.anim = ANIM.hang;
          events.push({ type: 'ledgeGrabbed' });
          return events;
        }
      }
    }

    // ---- normal movement ----
    const desiredH = this.tmp2
      .set(0, 0, 0)
      .addScaledVector(ctx.forward, f)
      .addScaledVector(ctx.right, s);
    if (desiredH.lengthSq() > 1) desiredH.normalize();
    desiredH.multiplyScalar(MOVE.runSpeed);

    if (this.launch) {
      // Catapulted: steer toward the landing spot instead of taking input, so
      // the arc reliably ends on the ledge despite gravity thinning on the way up.
      const g = MOVE.gravity * ctx.gravityScale;
      const goalY = this.launch.target.y + HALF;
      const disc = this.vel.y * this.vel.y - 2 * g * (goalY - pos.y);
      if (disc >= 0) {
        const tRem = (this.vel.y + Math.sqrt(disc)) / g;
        if (tRem > 0.04) {
          const wantX = (this.launch.target.x - pos.x) / tRem;
          const wantZ = (this.launch.target.z - pos.z) / tRem;
          this.vel.x += (wantX - this.vel.x) * 0.25;
          this.vel.z += (wantZ - this.vel.z) * 0.25;
        }
      }
      if (this.time > this.launch.until) this.launch = null;
    } else if (this.grounded) {
      this.vel.x = desiredH.x;
      this.vel.z = desiredH.z;
    } else {
      const k = Math.min(1, MOVE.airControl * 3 * dt);
      this.vel.x += (desiredH.x - this.vel.x) * k;
      this.vel.z += (desiredH.z - this.vel.z) * k;
    }

    // jumping (with coyote time + buffering + double-jump item)
    const wantsJump = this.time - this.jumpBufferedAt < MOVE.jumpBuffer;
    const canGroundJump = this.grounded || this.time - this.lastGroundedAt < MOVE.coyoteTime;
    let jumped = false;
    if (wantsJump && !this.launch) {
      if (canGroundJump) {
        this.vel.y = MOVE.jumpVelocity;
        this.jumpsUsed = 1;
        this.jumpBufferedAt = -10;
        jumped = true;
        sfx.jump();
      } else if (this.hasDoubleJump && this.jumpsUsed <= 1) {
        this.vel.y = MOVE.jumpVelocity * 0.95;
        this.jumpsUsed = 2;
        this.jumpBufferedAt = -10;
        sfx.jump();
      }
    }
    // leaving a moving platform keeps its momentum, so jumping off a shuttle or
    // spinner carries you along with it instead of it sliding out from under you
    if (jumped && this.platformVel.lengthSq() > 0) {
      this.vel.x += this.platformVel.x;
      this.vel.z += this.platformVel.z;
      this.vel.y += Math.max(0, this.platformVel.y);
      this.platformVel.set(0, 0, 0);
    }
    if (jumped) this.grounded = false;

    // dive! (comedy + commitment) — you launch the way the character is facing,
    // not the way the camera happens to be pointing
    if (input.consumePress('KeyZ')) {
      const face = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const v = this.vel.clone().addScaledVector(face, 6.5);
      v.y = Math.max(v.y, 3.2);
      events.push({ type: 'knockdown', vel: v });
      return events;
    }

    // grab tether spring
    if (ctx.tetherTo) {
      const d = ctx.tetherTo.clone().sub(pos);
      const dist = d.length();
      if (dist > GAME.tetherLength) {
        const pull = Math.min(34, (dist - GAME.tetherLength) * 16);
        this.vel.addScaledVector(d.normalize(), pull * dt);
      }
    }

    // gravity (thinner air higher up — jumps get floatier as you climb)
    this.vel.y = Math.max(-32, this.vel.y - MOVE.gravity * ctx.gravityScale * dt);

    const prevVy = this.vel.y;
    const wasGrounded = this.grounded;
    const move = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    this.controller.computeColliderMovement(this.collider, move, undefined, groups(GROUP_PLAYER, GROUP_LEVEL));
    const m = this.controller.computedMovement();
    const next = { x: pos.x + m.x, y: pos.y + m.y, z: pos.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.grounded = this.controller.computedGrounded();

    // what are we standing on? (riding + seesaw slams key off this)
    this.groundHandle = null;
    if (this.grounded) {
      const hit = this.world.castShape(
        { x: next.x, y: next.y - 0.3, z: next.z }, ROT0, { x: 0, y: -1, z: 0 }, this.probeBall,
        0, 0.6, true, undefined, groups(GROUP_PLAYER, GROUP_LEVEL), this.collider, this.body,
      );
      if (hit) this.groundHandle = hit.collider.handle;
    }

    if (this.grounded) {
      this.lastGroundedAt = this.time;
      this.launch = null;
      if (!wasGrounded) {
        const impact = -prevVy;
        if (impact > GAME.knockdownLandingSpeed) {
          const v = new THREE.Vector3(this.vel.x * 0.6, 2.5, this.vel.z * 0.6);
          events.push({ type: 'knockdown', vel: v });
          return events;
        }
        events.push({ type: 'landed', impact, handle: this.groundHandle });
        if (impact > 6) sfx.land(impact > 11);
      }
      this.vel.y = 0;
      this.jumpsUsed = 0;
    } else if (wasGrounded && !jumped && this.platformVel.lengthSq() > 0) {
      // walked off a moving deck
      this.vel.x += this.platformVel.x;
      this.vel.z += this.platformVel.z;
      this.platformVel.set(0, 0, 0);
    }

    // facing + anim state
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.8) {
      const target = Math.atan2(this.vel.x, this.vel.z);
      let d = target - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, 14 * dt);
    }
    this.anim = !this.grounded ? ANIM.air : hSpeed > 0.6 ? ANIM.run : ANIM.idle;

    return events;
  }
}
