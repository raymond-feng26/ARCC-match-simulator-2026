// Online play. The host (the room creator's browser) runs the Sim and sends snapshots; everyone else
// keeps a Sim that is never stepped, only posed from the snapshots (so the views and panels work
// unchanged), and sends their controls to the host.
import { ZERO_CMD } from './sim.js';

const R = (v) => Math.round(v * 1000) / 1000;
const SNAPSHOT_HZ = 20, INPUT_HZ = 20, RENDER_DELAY_S = 0.1, INPUT_TIMEOUT_S = 0.6;

// ---------------------------------------------------------------- snapshots
function robotState(r) {
  const p = r.body.translation(), q = r.body.rotation();
  const zn = {};
  for (const [name, z] of Object.entries(r.zones)) if (z.t > 0) zn[name] = R(z.t);
  return {
    p: [R(p.x), R(p.y), R(p.z)], q: [R(q.x), R(q.y), R(q.z), R(q.w)], hp: Math.round(r.hp), al: r.alive ? 1 : 0,
    ra: R(r.respawnAt), iu: R(r.invincibleUntil), wk: r.weakened ? 1 : 0, ht: R(r.heat), hl: r.heatLocked ? 1 : 0,
    lg: r.lockedForGame ? 1 : 0, am: r.ammo, ty: R(r.turretYaw), vy: R(r.viewYaw), cp: Math.round(r.cap), pw: Math.round(r.powerW),
    co: R(r.chassisOffUntil), bu: R(r.blockedUntil), zn, li: R(r.lift), re: R(r.reach),
    hd: r.held ? [r.held.type, r.held.color ?? ''] : 0, sp: r.spin ? 1 : 0, ao: r.autoOn ? 1 : 0, as: r.auto.state,
    ss: r.auto.stopped ? 1 : 0, fn: r.fireNote, at: r.aimTarget ? 1 : 0, ob: r.onBarrel ? 1 : 0, og: R(r.offGround), rb: R(r.releaseBlockedAt),
  };
}

export function snapshot(sim) {
  return {
    t: 'state', st: R(sim.t), s0: R(sim.startT), ph: sim.phase, res: sim.result, vp: sim.vp, gold: sim.gold,
    es: sim.eventSeq, ev: sim.events.slice(-10),
    tr: sim.tracers.map((x) => ({ f: [R(x.from.x), R(x.from.y), R(x.from.z)], to: [R(x.to.x), R(x.to.y), R(x.to.z)], h: x.hit ? 1 : 0, b: x.big ? 1 : 0, tm: x.team, u: R(x.until - sim.t) })),
    r: Object.fromEntries(sim.keys.map((k) => [k, robotState(sim.robots[k])])),
    o: sim.objectives.map((o) => {
      if (o.turnedIn || !o.body) return { ti: 1 };
      const p = o.body.translation(), q = o.body.rotation();
      return { p: [R(p.x), R(p.y), R(p.z)], q: [R(q.x), R(q.y), R(q.z), R(q.w)], sc: o.scoring ?? 0, hl: o.held ? 1 : 0 };
    }),
  };
}

const lerp = (a, b, s) => a + (b - a) * s;
function nlerpQ(a, b, s) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], k = d < 0 ? -1 : 1;
  const q = [0, 1, 2, 3].map((i) => lerp(a[i], k * b[i], s));
  const n = Math.hypot(...q) || 1;
  return { x: q[0] / n, y: q[1] / n, z: q[2] / n, w: q[3] / n };
}
const lerpAngle = (a, b, s) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * s;

// Pose the (never stepped) Sim between snapshots a and b (b newer; s in [0, 1]).
export function applySnapshot(sim, a, b, s) {
  sim.t = lerp(a.st, b.st, s);
  Object.assign(sim, { startT: b.s0, phase: b.ph, result: b.res, vp: b.vp, gold: b.gold, eventSeq: b.es, events: b.ev });
  sim.tracers = b.tr.map((x) => ({ from: { x: x.f[0], y: x.f[1], z: x.f[2] }, to: { x: x.to[0], y: x.to[1], z: x.to[2] }, hit: !!x.h, big: !!x.b, team: x.tm, until: b.st + x.u }));
  for (const key of sim.keys) {
    const r = sim.robots[key], A = a.r[key] ?? b.r[key], B = b.r[key];
    if (!B) continue;
    r.body.setTranslation({ x: lerp(A.p[0], B.p[0], s), y: lerp(A.p[1], B.p[1], s), z: lerp(A.p[2], B.p[2], s) }, false);
    r.body.setRotation(nlerpQ(A.q, B.q, s), false);
    Object.assign(r, {
      hp: B.hp, alive: !!B.al, respawnAt: B.ra, invincibleUntil: B.iu, weakened: !!B.wk, heat: B.ht, heatLocked: !!B.hl,
      lockedForGame: !!B.lg, ammo: B.am, turretYaw: lerpAngle(A.ty, B.ty, s), viewYaw: lerpAngle(A.vy, B.vy, s), cap: B.cp, powerW: B.pw,
      chassisOffUntil: B.co, blockedUntil: B.bu, lift: lerp(A.li, B.li, s), reach: lerp(A.re, B.re, s),
      held: B.hd ? { type: B.hd[0], color: B.hd[1] || undefined } : null, spin: !!B.sp, autoOn: !!B.ao, fireNote: B.fn,
      aimTarget: B.at ? {} : null, onBarrel: B.ob ? {} : null, offGround: B.og, releaseBlockedAt: B.rb,
    });
    r.auto.state = B.as;
    r.auto.stopped = !!B.ss;
    r.zones = Object.fromEntries(Object.entries(B.zn).map(([n, t]) => [n, { t }]));
    r.grab = null;
  }
  sim.objectives.forEach((o, i) => {
    const A = a.o[i] ?? b.o[i], B = b.o[i];
    if (!B) return;
    if (B.ti) {
      if (o.body) { sim.world.removeRigidBody(o.body); o.body = null; }
      o.turnedIn = true;
      return;
    }
    if (!o.body) return;
    const P = A.ti ? B : A;
    o.body.setTranslation({ x: lerp(P.p[0], B.p[0], s), y: lerp(P.p[1], B.p[1], s), z: lerp(P.p[2], B.p[2], s) }, false);
    o.body.setRotation(nlerpQ(P.q, B.q, s), false);
    o.scoring = B.sc || null;
    o.held = !!B.hl;
  });
}

// ---------------------------------------------------------------- settings (chosen in the room)
export const SETTING_DEFAULTS = (sim) => ({
  hp: { ...sim.hitProbability }, aimLockM: sim.aimLockM, aimConeDeg: sim.aimConeDeg, sentryLockM: sim.sentryLockM,
  limbo: { ...sim.sentryLimbo }, retreatPct: Math.round(sim.sentryAuto.retreatHp * 100), patrolSpeed: sim.sentryAuto.speed,
  spin: sim.sentryAuto.spin,
  autoSentry: { red: true, blue: true },   // an empty Sentry seat drives itself (room setting, host only)
});

export function applySettings(sim, s = {}) {
  if (s.hp) for (const [k, v] of Object.entries(s.hp)) if (k in sim.hitProbability) sim.hitProbability[k] = Math.min(1, Math.max(0, +v));
  if (s.aimLockM !== undefined) sim.aimLockM = Math.max(0, +s.aimLockM);
  if (s.aimConeDeg !== undefined) sim.aimConeDeg = Math.min(180, Math.max(0, +s.aimConeDeg));
  if (s.sentryLockM !== undefined) sim.sentryLockM = Math.max(0, +s.sentryLockM);
  if (s.limbo) sim.sentryLimbo = { red: !!s.limbo.red, blue: !!s.limbo.blue };
  if (s.retreatPct !== undefined) sim.sentryAuto.retreatHp = Math.min(1, Math.max(0, s.retreatPct / 100));
  if (s.patrolSpeed !== undefined) sim.sentryAuto.speed = Math.min(3, Math.max(0.2, +s.patrolSpeed));
  if (s.spin !== undefined) sim.sentryAuto.spin = !!s.spin;
}

// ---------------------------------------------------------------- host
// Runs the real Sim: commands for remote seats from their latest input (press counts -> edges),
// empty or offline Sentry seats on Auto, other empty seats idle; snapshots out at 20 Hz.
export class HostSession {
  constructor(sim, conn, game) {
    Object.assign(this, { sim, conn, me: game.mySeat });
    this.seats = { ...game.seats };     // seat -> { id, name, online }
    this.autoSentry = { red: true, blue: true, ...game.settings?.autoSentry };
    this.remote = {};                   // seat -> { c, at, used: {nA, nB, nS} }
    this.lastSnap = 0;
    this.overAt = null;
  }

  onMessage(msg, actions) {
    if (msg.t === 'in' && msg.seat && msg.c) {
      const r = (this.remote[msg.seat] ??= { used: { nA: msg.c.nA ?? 0, nB: msg.c.nB ?? 0, nS: msg.c.nS ?? 0 } });
      r.c = msg.c;
      r.at = performance.now();
    } else if (msg.t === 'action') actions(msg);
    else if (msg.t === 'room') {
      this.seats = {};
      for (const m of msg.members) if (m.seat) this.seats[m.seat] = { id: m.id, name: m.name, online: m.online };
    }
  }

  // Commands for every robot this frame; local: the host's own command (field frame) or null.
  commands(local) {
    const out = {};
    for (const key of this.sim.keys) {
      const role = key.split('_')[1], seat = this.seats[key];
      if (key === this.me && local) { out[key] = local; continue; }
      const r = this.remote[key];
      const live = seat?.online && seat.id !== undefined && r?.c && performance.now() - r.at < INPUT_TIMEOUT_S * 1000;
      if (!live) { out[key] = role === 'sentry' && this.autoSentry[key.split('_')[0]] ? { ...ZERO_CMD, auto: true } : ZERO_CMD; continue; }
      const c = r.c;
      const edge = (n) => { const e = (c[n] ?? 0) > r.used[n]; r.used[n] = c[n] ?? 0; return e; };
      out[key] = { ...ZERO_CMD, mx: +c.mx || 0, my: +c.my || 0, rot: +c.rot || 0, action: !!c.action, liftUp: !!c.liftUp,
        liftDown: !!c.liftDown, reachOut: !!c.reachOut, reachIn: !!c.reachIn, boost: !!c.boost, buy: !!c.buy,
        actionEdge: edge('nA'), buyEdge: edge('nB'), spinEdge: edge('nS') };
    }
    return out;
  }

  afterFrame(now) {
    if (now - this.lastSnap >= 1000 / SNAPSHOT_HZ) {
      this.lastSnap = now;
      this.conn.send(snapshot(this.sim));
    }
    if (this.sim.phase === 'ended') {   // show the result a little, then everyone back to the room
      this.overAt ??= now + 8000;
      if (now > this.overAt) { this.conn.send({ t: 'over' }); this.overAt = Infinity; }
    }
  }
}

// ---------------------------------------------------------------- everyone else
// Buffers snapshots and poses the local Sim RENDER_DELAY_S behind the newest; sends this player's
// controls (field frame, with press counts) at 20 Hz and whenever a button changes.
export class ClientSession {
  constructor(sim, conn, game) {
    Object.assign(this, { sim, conn, me: game.mySeat });
    this.buf = [];
    this.offset = null;   // host sim time - local time (s), from the least delayed snapshots
    this.counts = { nA: 0, nB: 0, nS: 0 };
    this.lastSent = 0;
    this.lastKey = '';
  }

  onMessage(msg) {
    if (msg.t !== 'state') return;
    const last = this.buf[this.buf.length - 1];
    if (last && msg.st < last.st - 0.5) {   // the host reset the match: its clock started again
      this.buf = [];
      this.offset = null;
      this.onReset?.();
    }
    const now = performance.now() / 1000;
    const off = msg.st - now;
    this.offset = this.offset === null ? off : Math.max(off, this.offset - 0.002);   // follow the fastest, drift down slowly
    this.buf.push(msg);
    while (this.buf.length > 30) this.buf.shift();
  }

  pose() {
    if (!this.buf.length) return false;
    const T = performance.now() / 1000 + this.offset - RENDER_DELAY_S;
    let i = this.buf.findIndex((b) => b.st >= T);
    if (i === -1) i = this.buf.length - 1;
    const b = this.buf[i], a = this.buf[Math.max(0, i - 1)];
    const s = b.st > a.st ? Math.min(1, Math.max(0, (T - a.st) / (b.st - a.st))) : 1;
    applySnapshot(this.sim, a, b, s);
    return true;
  }

  sendInput(c, now) {
    if (!this.me || !c) return;
    if (c.actionEdge) this.counts.nA += 1;
    if (c.buyEdge) this.counts.nB += 1;
    if (c.spinEdge) this.counts.nS += 1;
    const msg = { mx: R(c.mx), my: R(c.my), rot: R(c.rot), action: c.action, liftUp: c.liftUp, liftDown: c.liftDown,
      reachOut: c.reachOut, reachIn: c.reachIn, boost: c.boost, buy: c.buy, ...this.counts };
    const key = JSON.stringify(msg);
    if (key === this.lastKey && now - this.lastSent < 1000 / INPUT_HZ) return;   // unchanged: 20 Hz keep-alive
    this.conn.send({ t: 'in', c: msg });
    this.lastSent = now;
    this.lastKey = key;
  }
}

