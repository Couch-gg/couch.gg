// server/rooms.js — lobby + room lifecycle management.
//
// A Room owns its roster (Map of players in join order), its lobby/game state,
// and one Game engine instance. This module is transport-agnostic: it talks to
// clients only through each player's `socket` (anything with a `.send(json)`),
// so it never depends on the ws library directly.

import { Game } from './game.js';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  NAME_MAX_LEN,
  ROOM_CODE_LEN,
  ROOM_CODE_ALPHABET,
  TEAM_NAMES,
} from '../shared/constants.js';

// --- id / name / code helpers ----------------------------------------------

// 8 hex chars, server-assigned player id.
function genPlayerId() {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

// Sanitize a display name: coerce to string, strip control chars, trim,
// uppercase, cap length, default to 'PLAYER' when empty.
export function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  // Strip ASCII control chars (0x00-0x1F, 0x7F) and C1/separator controls.
  // Built from explicit code points so no literal control char lives in source.
  s = s.replace(/[\x00-\x1F\x7F\u2028\u2029]/g, '');
  s = s.trim();
  if (s.length > NAME_MAX_LEN) s = s.slice(0, NAME_MAX_LEN);
  s = s.toUpperCase();
  if (s.length === 0) s = 'PLAYER';
  return s;
}

function randomCode() {
  let s = '';
  const a = ROOM_CODE_ALPHABET;
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    s += a[Math.floor(Math.random() * a.length)];
  }
  return s;
}

// --- RoomManager ------------------------------------------------------------

export class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }

  // Generate a code not currently in use. Bounded retries then a longer
  // fallback so we never loop forever even in absurd contention.
  uniqueCode() {
    for (let i = 0; i < 1000; i++) {
      const c = randomCode();
      if (!this.rooms.has(c)) return c;
    }
    // Fallback: keep extending until unique.
    let c = randomCode();
    while (this.rooms.has(c)) c += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    return c;
  }

  getRoom(code) {
    if (typeof code !== 'string') return null;
    return this.rooms.get(code.toUpperCase()) || null;
  }

  // Create a new room with `socket` as host. Returns { room, player } or
  // sends an error and returns null (only fails in pathological cases).
  createRoom(socket, rawName) {
    const code = this.uniqueCode();
    const room = new Room(code, this);
    this.rooms.set(code, room);
    const player = room.addPlayer(socket, rawName);
    room.hostId = player.id;
    room.sendJoined(player);
    room.broadcastLobby();
    return { room, player };
  }

  // Join an existing room by code. Validates and sends `error` on failure.
  joinRoom(code, socket, rawName) {
    const room = this.getRoom(code);
    if (!room) {
      safeSend(socket, { t: 'error', msg: 'NO SUCH ROOM' });
      return null;
    }
    if (room.state === 'playing') {
      safeSend(socket, { t: 'error', msg: 'GAME ALREADY STARTED' });
      return null;
    }
    if (room.players.size >= MAX_PLAYERS) {
      safeSend(socket, { t: 'error', msg: 'ROOM FULL' });
      return null;
    }
    const player = room.addPlayer(socket, rawName);
    room.sendJoined(player);
    room.broadcastLobby();
    return { room, player };
  }

  // Remove a room entirely (cleans up its game/timer).
  destroyRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.dispose();
    this.rooms.delete(code);
  }
}

// --- Room -------------------------------------------------------------------

export class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.hostId = null;
    this.players = new Map(); // id -> { id, name, colorIdx, socket }
    this.state = 'lobby'; // 'lobby' | 'playing' | 'over'
    this.game = new Game(this);
  }

  // Lowest free color index 0..3 (MAX_PLAYERS slots).
  freeColorIdx() {
    const used = new Set();
    for (const p of this.players.values()) used.add(p.colorIdx);
    for (let i = 0; i < TEAM_NAMES.length; i++) {
      if (!used.has(i)) return i;
    }
    return 0; // shouldn't happen (capacity enforced by join), defensive.
  }

  addPlayer(socket, rawName) {
    const id = this.uniquePlayerId();
    const player = {
      id,
      name: sanitizeName(rawName),
      colorIdx: this.freeColorIdx(),
      socket,
    };
    this.players.set(id, player);
    return player;
  }

  uniquePlayerId() {
    let id = genPlayerId();
    while (this.players.has(id)) id = genPlayerId();
    return id;
  }

  sendJoined(player) {
    safeSend(player.socket, { t: 'joined', code: this.code, you: player.id });
  }

  // The lobby roster payload (no sockets).
  lobbyPlayers() {
    const arr = [];
    for (const p of this.players.values()) {
      arr.push({ id: p.id, name: p.name, colorIdx: p.colorIdx });
    }
    return arr;
  }

  broadcastLobby() {
    this.broadcast({
      t: 'lobby',
      code: this.code,
      hostId: this.hostId,
      players: this.lobbyPlayers(),
    });
  }

  // Send a JSON message to every connected player in the room.
  broadcast(msg) {
    for (const p of this.players.values()) {
      safeSend(p.socket, msg);
    }
  }

  // --- commands -------------------------------------------------------------

  // Host starts the game (lobby only, ≥ MIN_PLAYERS).
  startGame(requesterId) {
    if (this.state !== 'lobby') {
      this.sendError(requesterId, 'GAME ALREADY STARTED');
      return;
    }
    if (requesterId !== this.hostId) {
      this.sendError(requesterId, 'ONLY HOST CAN START');
      return;
    }
    if (this.players.size < MIN_PLAYERS) {
      this.sendError(requesterId, 'NEED 2+ PLAYERS');
      return;
    }
    this.game.start();
  }

  // A `fire` from a player. Delegated to the game; all validation lives there.
  fire(requesterId, angle, power) {
    this.game.fire(requesterId, angle, power);
  }

  // Host requests a rematch (state 'over').
  rematch(requesterId) {
    if (this.state !== 'over') {
      this.sendError(requesterId, 'NO GAME TO REMATCH');
      return;
    }
    if (requesterId !== this.hostId) {
      this.sendError(requesterId, 'ONLY HOST CAN REMATCH');
      return;
    }
    if (this.players.size < MIN_PLAYERS) {
      this.sendError(requesterId, 'NEED 2+ PLAYERS FOR REMATCH');
      return;
    }
    this.game.rematch();
  }

  sendError(playerId, msg) {
    const p = this.players.get(playerId);
    if (p) safeSend(p.socket, { t: 'error', msg });
  }

  // --- leave / disconnect ---------------------------------------------------

  // Handle a player leaving (disconnect, or explicit leave). Works in every
  // state. Returns true if the room still exists, false if it was destroyed.
  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return this.players.size > 0;

    const wasHost = playerId === this.hostId;

    if (this.state === 'playing') {
      // Compute the game consequence BEFORE removing from roster so the game
      // can read the leaver's unit / turn ownership.
      const consequence = this.game.handleLeave(playerId);
      this.players.delete(playerId);

      // Host promotion if needed (do before broadcast so clients learn the
      // new host alongside, via the next lobby/over flow — but a `left`
      // doesn't carry hostId, so we send a lobby update too when host changed).
      if (wasHost) this.promoteHost();

      if (this.players.size === 0) {
        this.dispose();
        this.manager.rooms.delete(this.code);
        return false;
      }

      this.broadcast({
        t: 'left',
        id: playerId,
        name: player.name,
        next: consequence.next,
        winner: consequence.winner,
      });

      // If the host changed mid-game, let clients refresh who's host (used by
      // the client to know who can rematch on the game-over screen).
      if (wasHost) this.broadcastLobby();
      return true;
    }

    // Lobby or over: just drop them.
    this.players.delete(playerId);

    if (this.state === 'over') {
      // Keep game state intact for a possible rematch by remaining players;
      // just notify the room the player left.
      this.game.handleLeave(playerId);
    }

    if (this.players.size === 0) {
      this.dispose();
      this.manager.rooms.delete(this.code);
      return false;
    }

    if (wasHost) this.promoteHost();

    if (this.state === 'over') {
      this.broadcast({
        t: 'left',
        id: playerId,
        name: player.name,
        next: null,
        winner: null,
      });
    }

    // Always refresh lobby roster (host tag, player list) for lobby/over.
    this.broadcastLobby();
    return true;
  }

  // Promote the oldest remaining player (first in insertion order) to host.
  promoteHost() {
    const first = this.players.keys().next();
    this.hostId = first.done ? null : first.value;
  }

  // Tear down the room's game/timers. Safe to call multiple times.
  dispose() {
    if (this.game) this.game.destroy();
  }
}

// --- transport-safe send ----------------------------------------------------

// Send JSON to a socket, swallowing any error (closed socket, bad state).
// Accepts the standard ws socket (readyState OPEN === 1).
export function safeSend(socket, msg) {
  if (!socket) return;
  try {
    if (typeof socket.readyState === 'number' && socket.readyState !== 1) return;
    socket.send(JSON.stringify(msg));
  } catch (err) {
    /* ignore: socket may have closed between check and send */
  }
}
