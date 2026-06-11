import type { Cosmetics, GadgetState, ItemType, PlayerInfo, RunRow } from './types';

// ---- client → server ----
export type C2S =
  | { t: 'create'; name: string; cos: Cosmetics }
  | { t: 'join'; code: string; name: string; cos: Cosmetics }
  | { t: 'cos'; cos: Cosmetics }
  | { t: 'ready'; ready: boolean }
  | { t: 'seed'; seed: string } // host only; '' means random
  | { t: 'start' } // host only
  | { t: 'loaded' } // client finished building the level
  | { t: 'state'; p: [number, number, number]; yaw: number; anim: number; vy: number }
  | { t: 'plate'; gadget: number; plate: number; on: boolean }
  | { t: 'checkpoint'; index: number }
  | { t: 'fell' }
  | { t: 'pickup'; item: number }
  | { t: 'give'; to: string }
  | { t: 'grapple'; top: [number, number, number]; length: number }
  | { t: 'grab'; target: string; on: boolean }
  | { t: 'knock'; vel: [number, number, number] }
  | { t: 'ping' }
  | { t: 'flag' }
  | { t: 'again' } // host only: return everyone to the lobby
  | { t: 'leave' };

// ---- server → client ----
export type S2C =
  | { t: 'joined'; code: string; you: string; players: PlayerInfo[]; hostId: string; seed: string }
  | { t: 'lobby'; players: PlayerInfo[]; hostId: string; seed: string }
  | { t: 'error'; msg: string }
  | { t: 'starting'; seed: string; now: number }
  | { t: 'go'; now: number; startAt: number }
  | { t: 'S'; time: number; players: Record<string, [number, number, number, number, number, number]> } // x,y,z,yaw,anim,vy
  | { t: 'gadget'; id: number; state: GadgetState }
  | { t: 'checkpoint'; player: string; index: number }
  | { t: 'fell'; player: string }
  | { t: 'pickup'; player: string; item: number }
  | { t: 'item'; player: string; item: ItemType | null }
  | { t: 'rope'; top: [number, number, number]; length: number; by: string }
  | { t: 'grab'; from: string; target: string; on: boolean }
  | { t: 'knock'; player: string; vel: [number, number, number] }
  | { t: 'ping'; player: string; p: [number, number, number] }
  | { t: 'flag'; player: string; done: string[] }
  | { t: 'finish'; durationMs: number; falls: Record<string, number>; rank: number | null; top: RunRow[] }
  | { t: 'lobbyAgain' };
