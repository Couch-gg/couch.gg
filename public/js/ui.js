// ui.js — owns the #ui HTML overlay: menu, lobby, game-over, toasts, banner.
//
//   import { initUI } from '/js/ui.js';
//   initUI(net);
//
// Screens are driven by net events ('joined', 'lobby', 'start', 'error',
// 'close') and a DOM CustomEvent 'ui:gameover' dispatched by the game scene.

import { MIN_PLAYERS, MAX_PLAYERS, TEAM_NAMES } from '/shared/constants.js';
import { SFX } from '/js/sfx.js';

const NAME_STORE_KEY = 'trebuchet.name';

/** Safe SFX click — never let a missing/broken audio module break the UI. */
function clickSound() {
  try {
    SFX.play('click');
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
    lobby: $('screen-lobby'),
    gameover: $('screen-gameover'),
  };

  const nameInput = $('menu-name');
  const codeInput = $('menu-code');
  const btnCreate = $('btn-create');
  const btnJoin = $('btn-join');

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

  // ---- Local UI state ------------------------------------------------------
  let inGame = false;          // true once a 'start' has hidden the overlay
  let gameOver = false;        // true while the game-over panel is showing
  let lastLobby = null;        // most recent lobby payload (for re-render)

  // ---- Screen switching ----------------------------------------------------
  function show(which) {
    for (const key of Object.keys(screens)) {
      const el = screens[key];
      if (!el) continue;
      el.hidden = key !== which;
    }
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

    btnRematch.hidden = !d.isHost;

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

  // ---- Net wiring ----------------------------------------------------------
  // On (re)connect, if we were never in a room yet, show the menu.
  net.on('open', () => {
    connBanner.hidden = true;
    if (!inGame && screens.lobby.hidden && screens.gameover.hidden && screens.menu.hidden) {
      show('menu');
    }
  });

  net.on('lobby', (msg) => {
    // Server pushes 'lobby' on every change. Show the lobby screen only when
    // we're neither in a live game nor on the game-over panel — otherwise just
    // cache the payload (host may have changed) without yanking the screen.
    lastLobby = msg;
    if (!inGame && !gameOver) {
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
