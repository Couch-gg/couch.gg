// Dev/test helper: headless WebSocket player. Speaks the exact client protocol,
// joins a room, and fires on its turn with simple self-correcting aim.
// Usage: node scripts/headless-player.js <ROOM_CODE> [name] [--passive]
import WebSocket from 'ws';

const code = process.argv[2];
const name = process.argv[3] || 'BOT';
const passive = process.argv.includes('--passive');
if (!code) { console.error('usage: node scripts/headless-player.js <ROOM_CODE> [name] [--passive]'); process.exit(1); }

const ws = new WebSocket('ws://127.0.0.1:3000/ws');
let you = null;
let players = [];
let angle = 135, power = 70;       // initial guess; corrected after each miss
let target = null;
let me = null;
let shotsFired = 0;

const log = (o) => console.log(JSON.stringify(o));
const send = (o) => ws.send(JSON.stringify(o));

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
  const dir = target.x > me.x ? 1 : -1;       // 1 = shoot right, -1 = shoot left
  angle = dir === 1 ? 45 : 135;
  setTimeout(() => {
    shotsFired++;
    log({ bot: 'fire', angle, power, target: { x: target.x, y: target.y } });
    send({ t: 'fire', angle, power });
  }, 2500);
}

function correct(impact) {
  if (!impact || !target || !me) { power = Math.min(100, power + 8); return; }
  const dir = target.x > me.x ? 1 : -1;
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
    for (const h of m.result.hits) {
      const p = players.find(q => q.id === h.id); if (p) p.hp = h.hp;
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
