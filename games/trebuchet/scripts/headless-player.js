// Dev/test helper: headless WebSocket player. Speaks the exact client protocol,
// joins a room, and fires on its turn with simple self-correcting aim.
// Usage: node scripts/headless-player.js <ROOM_CODE> [name] [--passive]
//
// V2 SIEGE UPDATE: trebuchets only fire within the ELEVATION band (50..85
// degrees above the horizon). The bot aims by ELEVATION and chooses a direction
// toward the target: angle = elev when shooting right, angle = 180 - elev when
// shooting left. Elevation is searched/nudged within 50..85; the impact-feedback
// power correction is preserved.
import WebSocket from 'ws';

const ELEV_MIN = 50;   // mirrors shared/constants.js ELEV_MIN (CONTRACT §7.1)
const ELEV_MAX = 85;   // mirrors shared/constants.js ELEV_MAX

const code = process.argv[2];
const name = process.argv[3] || 'BOT';
const passive = process.argv.includes('--passive');
if (!code) { console.error('usage: node scripts/headless-player.js <ROOM_CODE> [name] [--passive]'); process.exit(1); }

const ws = new WebSocket('ws://127.0.0.1:3000/ws');
let you = null;
let players = [];
let elev = 62, power = 70;          // elevation (50..85) + power; corrected each miss
let dir = 1;                        // 1 = shoot right, -1 = shoot left
let target = null;
let me = null;
let shotsFired = 0;

const log = (o) => console.log(JSON.stringify(o));
const send = (o) => ws.send(JSON.stringify(o));

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Convert the bot's elevation + chosen direction into a launch angle in the
// game's convention (0 = right, 90 = up, 180 = left).
function aimAngle() {
  const e = clamp(elev, ELEV_MIN, ELEV_MAX);
  return dir === 1 ? e : 180 - e;
}

function pickTarget() {
  const alive = players.filter(p => p.id !== you && p.hp > 0);
  if (!alive.length) return null;
  return alive[0];
}

function aimAndFire() {
  if (passive) return;
  target = pickTarget();
  me = players.find(p => p.id === you);
  if (!target || !me) return;
  dir = target.x > me.x ? 1 : -1;             // 1 = shoot right, -1 = shoot left
  const angle = aimAngle();
  setTimeout(() => {
    shotsFired++;
    log({ bot: 'fire', angle, elev, power, dir, target: { x: target.x, y: target.y } });
    send({ t: 'fire', angle, power });
  }, 2500);
}

function correct(impact) {
  if (!impact || !target || !me) { power = Math.min(100, power + 8); return; }
  dir = target.x > me.x ? 1 : -1;
  const err = (impact.x - target.x) * dir;    // >0 overshoot, <0 undershoot
  power = Math.max(15, Math.min(100, power - err * 0.08));
  log({ bot: 'correct', impactX: impact.x, targetX: target.x, err, newPower: power });
}

ws.on('open', () => { log({ bot: 'open' }); send({ t: 'join', code, name }); });
ws.on('close', () => { log({ bot: 'closed' }); process.exit(0); });
ws.on('error', (e) => { log({ bot: 'error', msg: String(e) }); process.exit(1); });

ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf.toString()); } catch { return; }
  log(m);
  if (m.t === 'joined') you = m.you;
  if (m.t === 'start') {
    players = m.players.map(p => ({ ...p }));
    if (m.turn === you) aimAndFire();
  }
  if (m.t === 'shot') {
    // Blast damage (hp after ALL of this shot's damage).
    for (const h of m.result.hits) {
      const p = players.find(q => q.id === h.id); if (p) p.hp = h.hp;
    }
    // Castle damage bleeds the owner — mirror their post-damage hp too (V2).
    if (Array.isArray(m.result.castleHits)) {
      for (const ch of m.result.castleHits) {
        const p = players.find(q => q.id === ch.id); if (p) p.hp = ch.hp;
      }
    }
    for (const s of m.result.settled) {
      const p = players.find(q => q.id === s.id); if (p) p.y = s.y;
    }
    if (m.shooterId === you) correct(m.result.impact);
    if (m.next && m.next.turn === you) aimAndFire();
  }
  if (m.t === 'turn' && m.turn === you) aimAndFire();
  if (m.t === 'left' && m.next && m.next.turn === you) aimAndFire();
});
