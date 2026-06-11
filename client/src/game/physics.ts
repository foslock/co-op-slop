import RAPIER from '@dimforge/rapier3d-compat';

let initialized = false;

export async function initPhysics(): Promise<typeof RAPIER> {
  if (!initialized) {
    await RAPIER.init();
    initialized = true;
  }
  return RAPIER;
}

export { RAPIER };

// Collision group encoding: (memberships << 16) | filter
export const GROUP_LEVEL = 0x0001;
export const GROUP_PLAYER = 0x0002;
export const GROUP_RAGDOLL = 0x0004;

export function groups(memberships: number, filter: number): number {
  return (memberships << 16) | filter;
}
