// Movement tunables. The level generator reads these too, so reachability
// guarantees stay in sync with how the character actually moves.
export const MOVE = {
  runSpeed: 6.5,
  airControl: 0.62,
  gravity: 22,
  jumpVelocity: 9.4, // apex ~= 9.4^2 / (2*22) = 2.0m
  climbSpeed: 3.0,
  coyoteTime: 0.12,
  jumpBuffer: 0.12,
  // Generator limits — kept comfortably inside what the numbers above allow.
  maxStepUp: 1.5,
  maxGapShort: 3.4, // edge-to-edge gap with little height change
  maxGapDown: 4.4, // edge-to-edge gap when landing lower
};

export const PLAYER = {
  capsuleRadius: 0.32,
  capsuleHalfHeight: 0.34, // total height ~1.32m
  eyeHeight: 1.05,
};

export const NET = {
  sendHz: 20,
  broadcastHz: 20,
  interpDelayMs: 120,
};

export const GAME = {
  maxPlayers: 4,
  countdownMs: 3000,
  respawnFallBelow: 8, // falling this far below your checkpoint respawns you
  killPlaneY: -25,
  knockdownLandingSpeed: 15, // |vy| at landing that triggers ragdoll
  ragdollTimeMs: 1900,
  grabRange: 2.6,
  tetherLength: 3.0,
  giveRange: 3.2,
  pickupRange: 1.5,
  flagRange: 3.0,
  grappleRange: 55,
};

export const COSMETIC_COLORS = [
  0xff5d5d, 0xffa94d, 0xffe066, 0x69db7c, 0x4dabf7, 0x9775fa, 0xf783ac, 0xe9ecef,
];
export const HATS = ['none', 'cap', 'cone', 'crown', 'chef', 'halo'] as const;
export const EYES = ['round', 'happy', 'sleepy'] as const;

export const ANIM = { idle: 0, run: 1, air: 2, climb: 3, ragdoll: 4 } as const;

// ---- altitude gravity ----
// The air thins as you climb: gravity eases from 100% at ground level to 55%
// in deep space, making jumps higher and floatier. The level generator widens
// gaps using a *damped* version of the gained jump range, so late zones get
// harder but never outrun what the physics allows.
import type { ZoneData } from './types';

/** Gravity multiplier at a (fractional) zone index: zone 0 → 1.0, zone 9+ → 0.55. */
export function gravityScaleAtZone(zone: number): number {
  return Math.max(0.55, 1 - zone * 0.05);
}

/** How much wider jumps/steps may be generated in a zone (damped vs. capability). */
export function gapScaleAtZone(zone: number): number {
  return 1 + (1 / gravityScaleAtZone(zone) - 1) * 0.75;
}

/** Smooth gravity multiplier for a world-space height, from the level's zone table. */
export function gravityScaleAtY(y: number, zones: ZoneData[]): number {
  if (zones.length === 0) return 1;
  let zp = 0;
  for (const z of zones) {
    if (y >= z.yEnd) zp = z.index + 1;
    else if (y > z.yStart) {
      zp = z.index + (y - z.yStart) / Math.max(1, z.yEnd - z.yStart);
      break;
    } else break;
  }
  return gravityScaleAtZone(zp);
}
