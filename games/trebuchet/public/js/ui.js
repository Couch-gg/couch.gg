// ui.js — owns the #ui HTML overlay: menu, lobby, game-over, toasts, banner.
//
//   import { initUI } from '/js/ui.js';
//   initUI(net);
//
// Screens are driven by net events ('joined', 'lobby', 'start', 'error',
// 'close') and a DOM CustomEvent 'ui:gameover' dispatched by the game scene.

import { MIN_PLAYERS, MAX_PLAYERS, TEAM_NAMES, NAME_MAX_LEN } from '/shared/constants.js';
import { SFX } from '/js/sfx.js';
import { startLocalGame } from '/js/local.js';

const NAME_STORE_KEY = 'trebuchet.name';

/** Safe SFX click — never let a missing/broken audio module break the UI. */
function clickSound() {
  try {
    SFX.play('click');
  } catch (err) {
    /* no-op */
  }
}

/** Safe SFX music-scene select — never let audio break the UI. The game scene
 *  owns the 'game' bed; the shell selects 'menu' whenever an overlay screen is
 *  on top. */
function setMusicScene(scene) {
  try {
    if (SFX && typeof SFX.musicScene === 'function') SFX.musicScene(scene);
  } catch (err) {
    /* no-op */
  }
}

/** Trim + uppercase a name candidate for display/transport.
 *  Strips ASCII control characters; the server does final validation. */
function cleanName(raw) {
  return String(raw || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, 12);
}

export function initUI(net) {
  const $ = (id) => document.getElementById(id);

  // ---- Element handles -----------------------------------------------------
  const screens = {
    menu: $('screen-menu'),
    local: $('screen-local'),
    lobby: $('screen-lobby'),
    gameover: $('screen-gameover'),
  };

  const nameInput = $('menu-name');
  const codeInput = $('menu-code');
  const btnCreate = $('btn-create');
  const btnJoin = $('btn-join');
  const btnLocal = $('btn-local');

  // Local hotseat setup controls.
  const localPlayers = $('local-players');
  const btnLocalAdd = $('btn-local-add');
  const btnLocalRemove = $('btn-local-remove');
  const btnLocalStart = $('btn-local-start');
  const btnLocalBack = $('btn-local-back');

  const lobbyCode = $('lobby-code');
  const lobbyLink = $('lobby-link');
  const btnCopy = $('btn-copy');
  const lobbyPlayers = $('lobby-players');
  const lobbyCount = $('lobby-count');
  const btnStart = $('btn-start');
  const lobbyWait = $('lobby-wait');

  const gameoverBanner = $('gameover-banner');
  const btnRematch = $('btn-rematch');
  const btnLeave = $('btn-leave');

  const toastStack = $('toast-stack');
  const connBanner = $('conn-banner');
  const btnMute = $('btn-mute');

  // ---- Local UI state ------------------------------------------------------
  let inGame = false;          // true once a 'start' has hidden the overlay
  let gameOver = false;        // true while the game-over panel is showing
  let lastLobby = null;        // most recent lobby payload (for re-render)
  let localMode = false;       // true while a local hotseat game is active

  // ---- Screen switching ----------------------------------------------------
  function show(which) {
    for (const key of Object.keys(screens)) {
      const el = screens[key];
      if (!el) continue;
      el.hidden = key !== which;
    }
    // Any overlay screen (menu / local / lobby / gameover) plays the calm
    // menu bed. The Game scene switches to the 'game' bed itself when a match
    // starts (and hideAll() leaves it untouched).
    setMusicScene('menu');
  }

  function hideAll() {
    for (const key of Object.keys(screens)) {
      if (screens[key]) screens[key].hidden = true;
    }
  }

  // ---- MENU ----------------------------------------------------------------
  function readName() {
    const n = cleanName(nameInput.value);
    return n || 'PLAYER';
  }

  function persistName() {
    try {
      localStorage.setItem(NAME_STORE_KEY, nameInput.value || '');
    } catch (err) {
      /* storage may be unavailable (private mode) — ignore */
    }
  }

  function doCreate() {
    clickSound();
    persistName();
    net.send({ t: 'create', name: readName() });
  }

  function doJoin() {
    clickSound();
    const code = cleanName(codeInput.value);
    if (!code) {
      toast('ENTER A ROOM CODE', 'error');
      codeInput.focus();
      return;
    }
    persistName();
    net.send({ t: 'join', code, name: readName() });
  }

  btnCreate.addEventListener('click', doCreate);
  btnJoin.addEventListener('click', doJoin);

  // Force uppercase as the player types (visual feedback).
  nameInput.addEventListener('input', () => {
    const pos = nameInput.selectionStart;
    nameInput.value = nameInput.value.toUpperCase();
    try { nameInput.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
  });
  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart;
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    try { codeInput.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
  });

  // Enter-to-submit convenience.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (codeInput.value.trim()) doJoin();
      else doCreate();
    }
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doJoin();
    }
  });

  // Restore last-used name.
  try {
    const saved = localStorage.getItem(NAME_STORE_KEY);
    if (saved) nameInput.value = cleanName(saved);
  } catch (err) {
    /* ignore */
  }

  // ?room= prefill: fill the code, highlight JOIN, focus name.
  const params = new URLSearchParams(window.location.search);
  const prefRoom = cleanName(params.get('room') || '').replace(/[^A-Z0-9]/g, '');
  if (prefRoom) {
    codeInput.value = prefRoom;
    btnJoin.classList.add('btn-highlight');
    // Drop the highlight once the player interacts with the field.
    codeInput.addEventListener('focus', () => btnJoin.classList.remove('btn-highlight'), { once: true });
    btnJoin.addEventListener('click', () => btnJoin.classList.remove('btn-highlight'), { once: true });
  }

  // ---- LOCAL HOTSEAT SETUP -------------------------------------------------
  // Render player-name rows (2-4). Preserves any already-typed values across
  // add/remove so re-rendering doesn't wipe input.
  function renderLocalRows(count, keep) {
    const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, count | 0));
    const prev = keep || [];
    localPlayers.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li');
      li.className = 'local-row';

      const swatch = document.createElement('span');
      swatch.className = `swatch swatch-${i}`;
      swatch.title = TEAM_NAMES[i] || '';

      const input = document.createElement('input');
      input.className = 'text-input local-name';
      input.type = 'text';
      input.maxLength = NAME_MAX_LEN;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'characters');
      input.placeholder = 'PLAYER ' + (i + 1);
      input.value = (prev[i] != null) ? prev[i] : '';
      // Force uppercase as the player types (matches the menu name field).
      input.addEventListener('input', () => {
        const pos = input.selectionStart;
        input.value = input.value.toUpperCase();
        try { input.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
      });

      li.appendChild(swatch);
      li.appendChild(input);
      localPlayers.appendChild(li);
    }
    updateLocalButtons();
  }

  function localRowValues() {
    return Array.from(localPlayers.querySelectorAll('.local-name')).map((el) => el.value);
  }

  function updateLocalButtons() {
    const n = localPlayers.querySelectorAll('.local-row').length;
    btnLocalAdd.disabled = n >= MAX_PLAYERS;
    btnLocalRemove.disabled = n <= MIN_PLAYERS;
  }

  function showLocalSetup() {
    clickSound();
    // Start with 2 rows, defaulting names to the empty placeholders.
    renderLocalRows(MIN_PLAYERS, []);
    show('local');
  }

  function doLocalAdd() {
    clickSound();
    const vals = localRowValues();
    if (vals.length >= MAX_PLAYERS) return;
    renderLocalRows(vals.length + 1, vals);
  }

  function doLocalRemove() {
    clickSound();
    const vals = localRowValues();
    if (vals.length <= MIN_PLAYERS) return;
    renderLocalRows(vals.length - 1, vals.slice(0, vals.length - 1));
  }

  function doLocalStart() {
    clickSound();
    // The driver sanitizes (trim/cap/uppercase) and applies PLAYER N defaults.
    const names = localRowValues();
    localMode = true;
    inGame = true;
    gameOver = false;
    hideAll();
    // Fresh start of the local driver; it emits a server-shaped 'start' which
    // main.js routes into the Game scene.
    startLocalGame(net, names);
  }

  function doLocalBack() {
    clickSound();
    show('menu');
  }

  if (btnLocal) btnLocal.addEventListener('click', showLocalSetup);
  if (btnLocalAdd) btnLocalAdd.addEventListener('click', doLocalAdd);
  if (btnLocalRemove) btnLocalRemove.addEventListener('click', doLocalRemove);
  if (btnLocalStart) btnLocalStart.addEventListener('click', doLocalStart);
  if (btnLocalBack) btnLocalBack.addEventListener('click', doLocalBack);

  // ---- LOBBY ---------------------------------------------------------------
  function renderLobby(msg) {
    lastLobby = msg;
    const code = msg.code || net.code || '----';
    lobbyCode.textContent = code;

    const link = window.location.origin + '/?room=' + code;
    lobbyLink.value = link;

    const players = Array.isArray(msg.players) ? msg.players : [];
    lobbyCount.textContent = `(${players.length}/${MAX_PLAYERS})`;

    // Player rows with team swatch + (HOST)/(YOU) tags.
    lobbyPlayers.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.className = 'player-item';
      const isYou = p.id === net.you;
      if (isYou) li.classList.add('is-you');

      const swatch = document.createElement('span');
      const idx = Number.isInteger(p.colorIdx) ? p.colorIdx : 0;
      swatch.className = `swatch swatch-${idx}`;
      swatch.title = TEAM_NAMES[idx] || '';

      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = p.name || 'PLAYER';

      li.appendChild(swatch);
      li.appendChild(name);

      if (p.id === msg.hostId) {
        const tag = document.createElement('span');
        tag.className = 'player-tag';
        tag.textContent = '(HOST)';
        li.appendChild(tag);
      }
      if (isYou) {
        const youTag = document.createElement('span');
        youTag.className = 'player-tag you-tag';
        youTag.textContent = '(YOU)';
        li.appendChild(youTag);
      }

      lobbyPlayers.appendChild(li);
    }

    // Host vs. non-host controls.
    const amHost = net.you && msg.hostId === net.you;
    if (amHost) {
      btnStart.hidden = false;
      lobbyWait.hidden = true;
      const enough = players.length >= MIN_PLAYERS;
      btnStart.disabled = !enough;
      btnStart.textContent = enough ? 'START GAME' : `NEED ${MIN_PLAYERS}+ PLAYERS`;
    } else {
      btnStart.hidden = true;
      lobbyWait.hidden = false;
    }
  }

  function doStart() {
    if (btnStart.disabled) return;
    clickSound();
    net.send({ t: 'start' });
  }

  async function doCopy() {
    clickSound();
    const text = lobbyLink.value;
    let ok = false;

    // Preferred: async clipboard API (needs a secure context).
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (err) {
        ok = false;
      }
    }

    // Fallback: select the field + execCommand('copy').
    if (!ok) {
      try {
        lobbyLink.removeAttribute('readonly');
        lobbyLink.focus();
        lobbyLink.select();
        lobbyLink.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      } finally {
        lobbyLink.setAttribute('readonly', 'readonly');
        try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
      }
    }

    if (ok) {
      const prev = btnCopy.textContent;
      btnCopy.textContent = 'COPIED!';
      btnCopy.disabled = true;
      window.setTimeout(() => {
        btnCopy.textContent = prev;
        btnCopy.disabled = false;
      }, 1400);
    } else {
      toast('COPY FAILED — SELECT LINK', 'error');
    }
  }

  btnStart.addEventListener('click', doStart);
  btnCopy.addEventListener('click', doCopy);

  // ---- GAME OVER -----------------------------------------------------------
  function showGameOver(detail) {
    const d = detail || {};
    let label;
    let cls = '';
    if (d.draw) {
      label = 'DRAW!';
      cls = 'draw';
    } else if (d.youWin) {
      label = 'YOU WIN!';
      cls = 'win';
    } else {
      const who = (d.winnerName || 'NOBODY').toUpperCase();
      label = `${who} WINS!`;
      cls = 'lose';
    }

    gameoverBanner.textContent = label;
    gameoverBanner.className = 'gameover-banner' + (cls ? ' ' + cls : '');

    // Local hotseat: REMATCH is always available (no host concept). Online:
    // only the host sees REMATCH (detail.isHost from the game scene).
    btnRematch.hidden = localMode ? false : !d.isHost;

    inGame = false;
    gameOver = true;
    show('gameover');
  }

  btnRematch.addEventListener('click', () => {
    clickSound();
    net.send({ t: 'rematch' });
    // Server replies with a fresh 'start' which hides the overlay.
  });
  btnLeave.addEventListener('click', () => {
    clickSound();
    window.location.reload();
  });

  // ---- TOASTS --------------------------------------------------------------
  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'info' ? ' toast-info' : '');
    el.textContent = String(text || '').toUpperCase();
    toastStack.appendChild(el);

    const remove = () => {
      el.classList.add('toast-out');
      window.setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    };
    window.setTimeout(remove, 4000);
  }

  // ---- CONNECTION BANNER ---------------------------------------------------
  function showConnLost() {
    connBanner.hidden = false;
  }

  // ---- SOUND TOGGLE --------------------------------------------------------
  // Persistent mute button, pinned to the stage and visible on every screen
  // (including during gameplay, since it lives outside #ui's screens).
  // Speaker glyph + label reflect the current state; initial state is seeded
  // from SFX.isMuted() (which itself reads the persisted localStorage flag).
  const MUTE_GLYPH = '♪';   // ♪  (sound on)
  const MUTED_GLYPH = '✕';  // ✕  (muted)

  function paintMute(muted) {
    if (!btnMute) return;
    const glyph = btnMute.querySelector('.btn-mute-glyph');
    const label = btnMute.querySelector('.btn-mute-label');
    btnMute.classList.toggle('is-muted', !!muted);
    if (glyph) glyph.textContent = muted ? MUTED_GLYPH : MUTE_GLYPH;
    if (label) label.textContent = muted ? 'MUTE' : 'SND';
    btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btnMute.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    btnMute.title = muted ? 'Unmute sound' : 'Mute sound';
  }

  function seedMuteState() {
    let muted = false;
    try {
      if (SFX && typeof SFX.isMuted === 'function') muted = !!SFX.isMuted();
    } catch (err) {
      /* audio unavailable — treat as unmuted for display */
    }
    paintMute(muted);
  }

  if (btnMute) {
    btnMute.addEventListener('click', () => {
      let muted = false;
      try {
        if (SFX && typeof SFX.toggleMute === 'function') {
          muted = !!SFX.toggleMute();
        }
      } catch (err) {
        /* swallow — never let audio break the button */
      }
      paintMute(muted);
      // Click feedback only makes sense when we just turned sound ON.
      if (!muted) clickSound();
    });
    seedMuteState();
  }

  // ---- Net wiring ----------------------------------------------------------
  // On (re)connect, if we were never in a room yet, show the menu.
  net.on('open', () => {
    connBanner.hidden = true;
    // Don't yank the menu over a local hotseat game/setup on a (re)connect.
    if (localMode || !screens.local.hidden) return;
    if (!inGame && screens.lobby.hidden && screens.gameover.hidden && screens.menu.hidden) {
      show('menu');
    }
  });

  net.on('lobby', (msg) => {
    // Server pushes 'lobby' on every change. Show the lobby screen only when
    // we're neither in a live game nor on the game-over panel — otherwise just
    // cache the payload (host may have changed) without yanking the screen.
    lastLobby = msg;
    if (!inGame && !gameOver && !localMode && screens.local.hidden) {
      renderLobby(msg);
      show('lobby');
    }
  });

  net.on('start', () => {
    // Game scene takes over — hide the whole overlay.
    inGame = true;
    gameOver = false;
    hideAll();
  });

  net.on('error', (msg) => {
    toast(msg && msg.msg ? msg.msg : 'ERROR', 'error');
  });

  net.on('close', () => {
    // A WebSocket drop must NOT interrupt a local hotseat game (it doesn't use
    // the socket). Suppress the banner while local mode is active.
    if (localMode) return;
    showConnLost();
  });

  // Game-over panel is triggered by the game scene via a DOM CustomEvent.
  document.addEventListener('ui:gameover', (ev) => {
    showGameOver(ev && ev.detail);
  });

  // ---- Initial paint -------------------------------------------------------
  show('menu');
  // Defer focus so it doesn't fight the page's initial layout.
  window.setTimeout(() => {
    try {
      if (prefRoom) nameInput.focus();
      else nameInput.focus();
    } catch (e) { /* ignore */ }
  }, 60);
}
