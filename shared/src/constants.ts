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
