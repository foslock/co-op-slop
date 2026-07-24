import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ANIM, GAME, MOVE, PLAYER, TRAVERSE } from 'shared';
import { GROUP_LEVEL, GROUP_PLAYER, groups } from './physics';
import type { Bridge, Climbable } from './levelBuilder';
import type { Rope } from './rope';
import type { Input } from '../input';
import { sfx } from '../audio';

export interface StepCtx {
  input: Input;
  forward: THREE.Vector3; // camera-relative horizontal basis
  right: THREE.Vector3;
  bridgeByCollider: Map<number, Bridge>;
  climbables: Climbable[];
  ropes: Rope[];
  tetherTo: THREE.Vector3 | null;
  gravityScale: number; // altitude-based: 1.0 at ground level → 0.55 in space
}

export type PlayerEvent =
  | { type: 'knockdown'; vel: THREE.Vector3 }
  | { type: 'fell' }
  | { type: 'ropeGrabbed' }
  | { type: 'landed'; impact: number };

export class LocalPlayer {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private world: RAPIER.World;

  vel = new THREE.Vector3();
  yaw = 0;
  anim: number = ANIM.idle;
  grounded = false;
  control = false;
  ragdolling = false;
  hasDoubleJump = false;
  checkpoint: { index: number; pos: THREE.Vector3 } = { index: 0, pos: new THREE.Vector3(0, 2, 0) };

  private lastGroundedAt = -10;
  private jumpBufferedAt = -10;
  private jumpsUsed = 0;
  // What you're currently holding on to: a rigid ladder line, or a simulated rope.
  private grip:
    | { kind: 'ladder'; line: Climbable; t: number }
    | { kind: 'rope'; rope: Rope; s: number }
    | null = null;
  private climbCooldownUntil = 0;
  private time = 0;
  private tmp = new THREE.Vector3();

  private R: typeof RAPIER;

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

  isClimbing(): boolean {
    return this.grip !== null;
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
      (this.vel.y < -6 && feetY < this.checkpoint.pos.y - GAME.respawnFallBelow && !this.grip)
    ) {
      this.teleport(this.checkpoint.pos);
      events.push({ type: 'fell' });
      return events;
    }

    if (!this.control) {
      this.anim = ANIM.idle;
      return events;
    }

    const input = ctx.input;
    const f = (input.keys.has('KeyW') ? 1 : 0) - (input.keys.has('KeyS') ? 1 : 0);
    const s = (input.keys.has('KeyD') ? 1 : 0) - (input.keys.has('KeyA') ? 1 : 0);

    if (input.consumePress('Space')) this.jumpBufferedAt = this.time;

    // Ropes and ladders are held, not magnetised to: you only catch one while
    // Shift is down, and letting go of Shift lets go of the rope.
    const holdingGrab = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');

    if (this.grip) {
      const jumpOff = this.time - this.jumpBufferedAt < MOVE.jumpBuffer;
      if (!holdingGrab || jumpOff || input.consumePress('KeyE')) {
        // Let go. Jumping off pushes you away; simply releasing Shift drops you,
        // carrying whatever the rope was swinging you at.
        const launch = new THREE.Vector3();
        if (this.grip.kind === 'rope') this.grip.rope.velocityAt(this.grip.s, dt, launch).multiplyScalar(0.5);
        this.jumpBufferedAt = -10;
        this.climbCooldownUntil = this.time + 0.35;
        this.vel.set(launch.x, Math.min(0, launch.y), launch.z);
        if (jumpOff) {
          this.vel.y = MOVE.jumpVelocity * 0.85;
          this.vel.addScaledVector(ctx.forward, 3.2);
          sfx.jump();
        }
        this.releaseGrip();
      } else if (this.grip.kind === 'ladder') {
        const { line } = this.grip;
        const len = line.b.y - line.a.y;
        this.grip.t = THREE.MathUtils.clamp(this.grip.t + (f * MOVE.climbSpeed * dt) / Math.max(0.1, len), 0, 1);
        if (this.grip.t >= 1) {
          const exit = line.exitDir ?? ctx.forward;
          const target = line.b.clone().addScaledVector(exit, 0.9);
          target.y = line.b.y + 0.4;
          this.releaseGrip();
          this.teleport(target);
          this.vel.y = 2.5;
          this.climbCooldownUntil = this.time + 0.5;
          // must not fall through: the movement code below works off the
          // position read at the top of this step and would undo the teleport
          return events;
        } else {
          const p = line.a.clone().lerp(line.b, this.grip.t);
          const face = line.exitDir ?? ctx.forward;
          p.addScaledVector(face, -0.38);
          p.y += 0.7;
          this.setPositionDirect(p);
          this.yaw = Math.atan2(face.x, face.z);
          this.anim = ANIM.climb;
          this.grounded = false;
          return events;
        }
      } else if (this.grip.rope.kind === 'hang') {
        // Vertical rope: W climbs toward the anchor. The rope is simulated, so
        // your position follows it as it swings under your weight.
        const { rope } = this.grip;
        this.grip.s = THREE.MathUtils.clamp(this.grip.s - (f * MOVE.climbSpeed * dt) / Math.max(0.1, rope.span), 0, 1);
        rope.setRider(this.grip.s);
        if (this.grip.s <= 0.02) {
          const exit = rope.exitDir ?? ctx.forward;
          const target = rope.a.clone().addScaledVector(exit, 0.9);
          target.y = rope.a.y + 0.4;
          this.releaseGrip();
          this.teleport(target);
          this.vel.y = 2.5;
          this.climbCooldownUntil = this.time + 0.5;
          return events;
        } else {
          const p = rope.pointAt(this.grip.s);
          const face = rope.exitDir ?? ctx.forward;
          p.addScaledVector(face, -0.38);
          p.y += 0.7;
          this.setPositionDirect(p);
          this.yaw = Math.atan2(face.x, face.z);
          this.anim = ANIM.climb;
          this.grounded = false;
          return events;
        }
      } else {
        // Strung rope: W/S shimmy along it in whichever direction you're looking.
        const { rope } = this.grip;
        const along = ctx.forward.dot(rope.dir) >= 0 ? 1 : -1;
        this.grip.s = THREE.MathUtils.clamp(
          this.grip.s + (f * along * TRAVERSE.shimmySpeed * dt) / Math.max(0.1, rope.span),
          0,
          1,
        );
        rope.setRider(this.grip.s);
        if (this.grip.s <= 0.02 || this.grip.s >= 0.98) {
          // reached an end — haul yourself up onto that platform
          const exit = rope.exitPoint(this.grip.s);
          this.releaseGrip();
          this.teleport(exit);
          this.vel.y = 2.0;
          this.climbCooldownUntil = this.time + 0.5;
          return events;
        } else {
          const p = rope.pointAt(this.grip.s);
          p.y -= TRAVERSE.hangDrop;
          this.setPositionDirect(p);
          this.yaw = Math.atan2(rope.dir.x * along, rope.dir.z * along);
          this.anim = ANIM.climb;
          this.grounded = false;
          return events;
        }
      }
    }

    // ---- catch a rope or ladder (only while Shift is held) ----
    if (!this.grip && holdingGrab && this.time > this.climbCooldownUntil) {
      const hands = new THREE.Vector3(pos.x, pos.y + 0.35, pos.z);
      let bestD = 1.35;
      let bestRope: Rope | null = null;
      let bestS = 0;
      for (const rope of ctx.ropes) {
        const { s, dist } = rope.nearest(hands);
        if (dist < bestD) {
          bestD = dist;
          bestS = s;
          bestRope = rope;
        }
      }
      let bestLine: Climbable | null = null;
      let bestLineD = bestD;
      for (const c of ctx.climbables) {
        if (pos.y < c.a.y - 0.6 || pos.y > c.b.y + 0.6) continue;
        const d = Math.hypot(pos.x - c.a.x, pos.z - c.a.z);
        if (d < bestLineD) {
          bestLineD = d;
          bestLine = c;
        }
      }
      if (bestLine) {
        const len = bestLine.b.y - bestLine.a.y;
        this.grip = { kind: 'ladder', line: bestLine, t: THREE.MathUtils.clamp((pos.y - 0.5 - bestLine.a.y) / len, 0, 0.97) };
        this.vel.set(0, 0, 0);
        this.anim = ANIM.climb;
        events.push({ type: 'ropeGrabbed' });
        return events;
      }
      if (bestRope) {
        bestRope.nudge(bestS, this.vel, dt); // your momentum sets the rope swinging
        bestRope.setRider(bestS);
        this.grip = { kind: 'rope', rope: bestRope, s: bestS };
        this.vel.set(0, 0, 0);
        this.anim = ANIM.climb;
        sfx.grapple();
        events.push({ type: 'ropeGrabbed' });
        return events;
      }
    }

    // ---- normal movement ----
    const desiredH = this.tmp
      .set(0, 0, 0)
      .addScaledVector(ctx.forward, f)
      .addScaledVector(ctx.right, s);
    if (desiredH.lengthSq() > 1) desiredH.normalize();
    desiredH.multiplyScalar(MOVE.runSpeed);

    if (this.grounded) {
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
    if (wantsJump) {
      if (canGroundJump) {
        this.vel.y = MOVE.jumpVelocity;
        this.jumpsUsed = 1;
        this.jumpBufferedAt = -10;
        this.grounded = false;
        sfx.jump();
      } else if (this.hasDoubleJump && this.jumpsUsed <= 1) {
        this.vel.y = MOVE.jumpVelocity * 0.95;
        this.jumpsUsed = 2;
        this.jumpBufferedAt = -10;
        sfx.jump();
      }
    }

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

    // ride moving bridges
    let rideDY = 0;
    const ray = new this.R.Ray({ x: pos.x, y: pos.y - 0.55, z: pos.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 0.5, true, undefined, groups(GROUP_PLAYER, GROUP_LEVEL), undefined, this.body);
    if (hit) {
      const bridge = ctx.bridgeByCollider.get(hit.collider.handle);
      if (bridge) rideDY = bridge.frameDeltaY;
    }

    const prevVy = this.vel.y;
    const wasGrounded = this.grounded;
    const move = { x: this.vel.x * dt, y: this.vel.y * dt + rideDY, z: this.vel.z * dt };
    this.controller.computeColliderMovement(this.collider, move, undefined, groups(GROUP_PLAYER, GROUP_LEVEL));
    const m = this.controller.computedMovement();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
    this.grounded = this.controller.computedGrounded();

    if (this.grounded) {
      this.lastGroundedAt = this.time;
      if (!wasGrounded) {
        const impact = -prevVy;
        if (impact > GAME.knockdownLandingSpeed) {
          const v = new THREE.Vector3(this.vel.x * 0.6, 2.5, this.vel.z * 0.6);
          events.push({ type: 'knockdown', vel: v });
          return events;
        }
        if (impact > 6) {
          events.push({ type: 'landed', impact });
          sfx.land(impact > 11);
        }
      }
      this.vel.y = 0;
      this.jumpsUsed = 0;
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
