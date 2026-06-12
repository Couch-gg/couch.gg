// Shared gameplay constants — single source of truth for client AND server.
// Imported by server (Node ESM) and browser (ES module via /shared/constants.js).

export const WORLD_W = 480;            // logical pixels (internal resolution)
export const WORLD_H = 270;

export const TERRAIN_MIN_Y = 60;       // highest allowed terrain surface (y grows downward)
export const TERRAIN_MAX_Y = 250;      // lowest allowed terrain surface
export const TERRAIN_FLOOR_Y = 262;    // craters can never dig below this

export const GRAVITY = 100;            // px/s^2 downward
export const WIND_MAX = 25;            // max |wind| horizontal acceleration px/s^2
export const DT = 1 / 120;             // physics integration timestep (s)
export const TRAJ_SAMPLE_EVERY = 2;    // record every Nth sim step -> 60 samples/s
export const MAX_FLIGHT_T = 20;        // hard cap on projectile flight time (s)

export const ANGLE_MIN = 10;           // degrees; 0 = right, 90 = straight up, 180 = left
export const ANGLE_MAX = 170;
export const POWER_MIN = 10;
export const POWER_MAX = 100;
export const SPEED_MAX = 260;          // launch speed px/s at power 100 (speed = power/100*SPEED_MAX)

export const PROJ_RADIUS = 2;          // projectile collision radius
export const CRATER_R = 16;            // terrain crater radius
export const DMG_MAX = 40;             // damage at epicenter
export const DMG_RADIUS = 26;          // damage falls linearly to 0 at this distance
export const PLAYER_HP = 100;
export const PLAYER_HIT_R = 9;         // player collision circle radius
export const PLAYER_HIT_DY = -6;       // hit circle center offset from base (x, y+PLAYER_HIT_DY)
export const MUZZLE_DY = 14;           // projectile spawns at (x, y - MUZZLE_DY)

export const TURN_MS = 60000;          // turn time limit
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

// Retro team palette (index = colorIdx assigned by join order)
export const TEAM_COLORS = [0xe8554d, 0x4d9be8, 0x5dc961, 0xe8c44d];
export const TEAM_NAMES = ['RED', 'BLUE', 'GREEN', 'GOLD'];

export const NAME_MAX_LEN = 12;
export const ROOM_CODE_LEN = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Deterministic PRNG used everywhere randomness must reproduce.
// mulberry32 — returns function yielding floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
