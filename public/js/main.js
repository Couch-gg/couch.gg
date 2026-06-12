// main.js — Agent GAME
// Bootstraps the Phaser game, wires net + UI, and (re)starts the Game scene
// whenever the server sends a `start` message (initial game OR rematch).

import { WORLD_W, WORLD_H } from '/shared/constants.js';
import { net } from './net.js';
import { initUI } from './ui.js';
import { Boot } from './scenes/boot.js';
import { Game } from './scenes/game.js';

// --- Phaser game ----------------------------------------------------------
// Phaser is loaded as a global script tag (window.Phaser) — never imported.
const config = {
  type: Phaser.AUTO,
  parent: 'game',
  width: WORLD_W,
  height: WORLD_H,
  pixelArt: true,
  backgroundColor: '#0a0a12',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  scene: [Boot, Game]
};

const game = new Phaser.Game(config);
window.__game = game; // debug handle (console inspection / automated testing)

// --- Networking + HTML overlay UI ----------------------------------------
net.connect();
initUI(net);

// --- Track the latest lobby host across scene restarts --------------------
// The Game scene needs the current hostId for the `ui:gameover` detail, but the
// `lobby` message that precedes `start` arrives before the scene's own listener
// is registered. Stash hostId on the Phaser registry (persists across restarts)
// so the scene can seed it in create().
net.on('lobby', (m) => {
  if (m && m.hostId) game.registry.set('hostId', m.hostId);
});

// --- (Re)start the Game scene on every `start` message --------------------
// The server emits `start` both for the first game and for every rematch.
// We must (re)start the scene with the fresh payload each time. Phaser's
// scene.start() will restart an already-running scene, triggering a clean
// shutdown (which removes the scene's net listeners) before init() runs again.
net.on('start', (payload) => {
  if (game.scene.isActive('Game') || game.scene.isSleeping('Game')) {
    game.scene.stop('Game');
  }
  game.scene.start('Game', payload);
});
