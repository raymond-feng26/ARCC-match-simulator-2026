// Match simulator core: Rapier physics + ARCC S2 rules. Mode '3v3': Red and Blue, Hero + Engineer +
// Sentry each; mode 'targets': the Red alliance against three fixed targets. No rendering here, so
// it also runs headless for tests.
import FIELD from './field_data.js';
import {
  RULES, ROBOTS, DRIVE, SHOOT, TARGETS, TARGET_RESPAWN_S, SENTRY_AUTO, OBJECTIVES, PHYSICS,
} from './params.js';
import { clamp, wrap, quatFromYaw, quatAxisAngle, quatMul, rotate, yawOf, inRect, obbOverlapsRect, inObb } from './geom.js';
import { autoCommand } from './sentry_auto.js';

const G_FIELD = 0x1, G_ROBOT = 0x2, G_OBJ = 0x4, G_TARGET = 0x8, G_LIMBO = 0x10;   // Limbo Bars: field, own group
const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);
const FIELD_GROUPS = groups(G_FIELD, 0xffff);
const LIMBO_GROUPS = groups(G_LIMBO, 0xffff);
const ROBOT_GROUPS = groups(G_ROBOT, G_FIELD | G_LIMBO | G_ROBOT | G_OBJ | G_TARGET);
const UNDER_LIMBO_GROUPS = groups(G_ROBOT, G_FIELD | G_ROBOT | G_OBJ | G_TARGET);   // a sentry allowed under the bars
const OBJ_GROUPS = groups(G_OBJ, G_FIELD | G_LIMBO | G_ROBOT | G_OBJ | G_TARGET);
const HELD_GROUPS = groups(G_OBJ, 0);                // a held objective touches nothing
const GHOST_GROUPS = groups(G_OBJ, G_FIELD | G_LIMBO | G_OBJ | G_TARGET);   // released into a robot: passes robots until clear
const TARGET_GROUPS = groups(G_TARGET, 0xffff);
const SHOT_GROUPS = groups(0xffff, G_FIELD | G_LIMBO | G_ROBOT | G_TARGET);   // shots ignore objectives
const GROUND_GROUPS = groups(0xffff, G_FIELD | G_LIMBO | G_ROBOT | G_OBJ | G_TARGET);   // what a wheel can stand on
const SOLID_QUERY = groups(0xffff, G_FIELD | G_LIMBO | G_OBJ | G_TARGET);
// Limbo Bar footprints (x0, x1, y0, y1), for letting a sentry finish passing before it collides again
const LIMBO_RECTS = FIELD.parts.filter((p) => p.kind.endsWith('limbo')).map((p) => [p.args[0][0], p.args[0][1], p.args[1][0], p.args[1][1]]);
const ROBOT_QUERY = groups(0xffff, G_ROBOT);
const WHEEL_R = 0.04, WHEEL_REACH = 0.02;   // wheel contact spheres; a wheel within 2 cm of a surface is down

// Robots are keyed team_role: red_hero ... blue_sentry.
export const TEAMS = ['red', 'blue'];
export const ROLES = ['hero', 'engineer', 'sentry'];
export const ALL_KEYS = TEAMS.flatMap((t) => ROLES.map((r) => `${t}_${r}`));
export const MODES = { '3v3': ALL_KEYS, targets: ['red_hero', 'red_engineer', 'red_sentry'] };
export const other = (team) => (team === 'red' ? 'blue' : 'red');
export const teamName = (team) => (team === 'red' ? 'Red' : 'Blue');
// The field is mirrored about the central line: Blue positions are Red's with x -> 12 - x.
export const mirrorX = (team, x) => (team === 'blue' ? FIELD.size[0] - x : x);
// Inside the 1.5 x 2 m Red Starting Zone, facing Blue (x, y, yaw deg). The only way out for robots
// this tall is up (+y; the Side Limbo Bar closes the gap to the right), so the sentry starts
// nearest the exit and the other two stand in two columns behind it.
const SPAWN_RED = { hero: [1.1, 0.5, 0], engineer: [0.4, 0.45, 0], sentry: [0.45, 1.6, 0] };
export function spawnOf(key) {
  const [team, role] = key.split('_'), [x, y, yaw] = SPAWN_RED[role];
  return [mirrorX(team, x), y, team === 'blue' ? 180 - yaw : yaw];
}

export const ZERO_CMD = Object.freeze({
  mx: 0, my: 0, rot: 0, action: false, actionEdge: false, liftUp: false, liftDown: false,
  reachOut: false, reachIn: false, boost: false, buy: false, buyEdge: false, spinEdge: false, auto: false,
});


export class Sim {
  constructor(RAPIER, options = {}) {
    this.R = RAPIER;
    this.mode = MODES[options.mode] ? options.mode : '3v3';
    this.keys = MODES[this.mode];
    this.random = options.random ?? Math.random;
    // per robot (UI slider), from the per-class default
    this.hitProbability = Object.fromEntries(this.keys.filter((k) => ROBOTS[k.split('_')[1]].launcher)
      .map((k) => [k, SHOOT.hitProbability[k.split('_')[1]]]));
    this.sentryAuto = { ...SENTRY_AUTO };
    this.aimConeDeg = SHOOT.aimConeDeg;   // UI setting; 180 = all round
    this.aimLockM = SHOOT.aimLockM;       // UI setting: a player's auto-aim locks on only this close
    // UI setting per alliance: that Sentry can pass under the Limbo Bars (option: true = both)
    const sl = options.sentryLimbo;
    this.sentryLimbo = typeof sl === 'object' && sl ? { red: !!sl.red, blue: !!sl.blue } : { red: !!sl, blue: !!sl };
    this.sentryLockM = SHOOT.sentryLockM;   // UI setting: a Sentry on Auto locks on only this close (all round)
    // Hero footprint (m, square; height and mass stay): built into the robot, so it takes effect on reset
    this.heroSize = options.heroSize > 0 ? +options.heroSize : ROBOTS.hero.chassis[0];
    this.reset();
  }

  reset() {
    const R = this.R;
    if (this.world) this.world.free();
    this.world = new R.World({ x: 0, y: 0, z: -PHYSICS.gravity });
    this.world.timestep = PHYSICS.dt;
    this.t = 0;
    this.phase = 'ready';          // ready (free driving, no rules) | running | ended
    this.startT = 0;
    this.vp = { red: 0, blue: 0 };
    this.gold = { red: 0, blue: 0 };
    this.goldGiven = new Set();
    this.comeback = { red: { given: new Set(), total: 0 }, blue: { given: new Set(), total: 0 } };
    this.lastWholeSecond = 0;
    this.events = [];
    this.eventSeq ??= 0;   // keeps counting across resets (the UI pops up events newer than it has seen)
    this.tracers = [];
    this.limited = { robot: 0, objective: 0 };   // steps cut by limitVelocities (should stay 0)
    this.result = null;
    this.buildField();
    this.robots = {};
    for (const key of this.keys) this.robots[key] = this.makeRobot(key);
    this.targets = this.mode === 'targets' ? TARGETS.map((t) => this.makeTarget(t)) : [];
    this.objectives = [];
    this.makeObjectives();
  }

  // ---------------------------------------------------------------- construction
  buildField() {
    const R = this.R;
    for (const p of FIELD.parts) {
      if (p.kind.endsWith('bumpy')) continue;   // 2.5 mm tiles: visual only (see the generator)
      let desc;
      if (p.shape === 'box') {
        const [[x0, x1], [y0, y1], [z0, z1]] = p.args;
        desc = R.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2)
          .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      } else {
        const [xf, xt, [y0, y1], h] = p.args;
        desc = R.ColliderDesc.convexHull(new Float32Array([
          xf, y0, 0, xt, y0, 0, xt, y1, 0, xf, y1, 0, xt, y0, h, xt, y1, h]));
      }
      desc.setFriction(0.6).setRestitution(0).setCollisionGroups(p.kind.endsWith('limbo') ? LIMBO_GROUPS : FIELD_GROUPS);
      this.world.createCollider(desc);
    }
  }

  // Height of the surface the field offers at (x, y): parts standing on the floor and ramps.
  // (From the field data: Rapier's scene queries are empty until the first physics step.)
  floorZ(x, y) {
    let z = 0;
    for (const p of FIELD.parts) {
      if (p.shape === 'box') {
        const [[x0, x1], [y0, y1], [z0, z1]] = p.args;
        if (z0 <= 0.001 && x >= x0 && x <= x1 && y >= y0 && y <= y1) z = Math.max(z, z1);
      } else {
        const [xf, xt, [y0, y1], h] = p.args;
        const s = (x - xf) / (xt - xf);
        if (s >= 0 && s <= 1 && y >= y0 && y <= y1) z = Math.max(z, s * h);
      }
    }
    return z;
  }

  makeRobot(key) {
    const [team, role] = key.split('_');
    const R = this.R, c = role === 'hero' ? this.heroClass() : ROBOTS[role];
    const [L, Wd, zb, zt] = c.chassis, [uL, uW, uTop] = c.upper;
    const [x, y, yawDeg] = spawnOf(key), yaw = (yawDeg * Math.PI) / 180;
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, 0.002).setRotation(quatFromYaw(yaw))
      .setAngularDamping(1.5).setCcdEnabled(true).setCanSleep(false));
    // Contacts with the robot are frictionless; the drive model below supplies wheel traction.
    // (Body friction 0.4 was tried: the chassis then grips objectives and climbs onto them.)
    const robotCollider = (d, m) => d.setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitution(0.05).setCollisionGroups(ROBOT_GROUPS).setMass(m);
    this.world.createCollider(robotCollider(
      R.ColliderDesc.cuboid(L / 2, Wd / 2, (zt - zb) / 2).setTranslation(0, 0, (zt + zb) / 2), c.mass * 0.5), body);
    // wheel contact spheres; the chassis (skirt) clears the floor by zb
    const wheels = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sy]) => ({ x: sx * (L / 2 - 0.07), y: sy * (Wd / 2 - 0.07), z: WHEEL_R }));
    for (const w of wheels) {
      this.world.createCollider(robotCollider(R.ColliderDesc.ball(WHEEL_R).setTranslation(w.x, w.y, w.z), c.mass * 0.08), body);
    }
    this.world.createCollider(robotCollider(
      R.ColliderDesc.cuboid(uL / 2, uW / 2, (uTop - zt) / 2).setTranslation(0, 0, (uTop + zt) / 2), c.mass * 0.18), body);
    return {
      key, team, role, cls: c, body, wheels, viewYaw: yaw, grounded: 1, offGround: 0, hp: c.maxHp, alive: true, deaths: 0, respawnAt: 0, invincibleUntil: 0, weakened: false,
      heat: 0, heatLocked: false, lockedForGame: false, ammo: c.ammo ?? 0, lastShot: -1e9, turretYaw: yaw,
      aimTarget: null, cap: DRIVE.capJ, powerW: 0, chassisOffUntil: 0, blockedUntil: 0,
      zones: {}, control: { t: 0, cards: 0, active: false }, reach: 0.15, lift: 0.06, held: null,
      spin: false, lastBuy: -1e9, auto: { state: 'heal', idx: 0, path: null, stopped: false }, autoOn: false,
      grab: null, fireNote: '', releaseBlockedAt: -1e9, underLimbo: false, onBarrel: null,
    };
  }

  // The Hero class at this.heroSize: chassis and upper body scaled in length and width.
  heroClass() {
    const H = ROBOTS.hero, k = this.heroSize / H.chassis[0];
    return { ...H, chassis: [H.chassis[0] * k, H.chassis[1] * k, H.chassis[2], H.chassis[3]], upper: [H.upper[0] * k, H.upper[1] * k, H.upper[2]] };
  }

  makeTarget(t) {
    const R = this.R;
    const z = this.floorZ(t.x, t.y);
    const yaw = (t.yaw * Math.PI) / 180;
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(t.x, t.y, z).setRotation(quatFromYaw(yaw)));
    const d = (desc) => desc.setCollisionGroups(TARGET_GROUPS).setFriction(0.3);
    this.world.createCollider(d(R.ColliderDesc.cuboid(0.275, 0.275, 0.1).setTranslation(0, 0, 0.115)), body);
    this.world.createCollider(d(R.ColliderDesc.cuboid(0.15, 0.15, 0.17).setTranslation(0, 0, 0.385)), body);
    return { ...t, z, yawRad: yaw, body, maxHp: t.hp, hp: t.hp, alive: true, respawnAt: 0, deaths: 0 };
  }

  makeObjectives() {
    const R = this.R, O = OBJECTIVES;
    const objCollider = (desc, m) => desc.setFriction(0.5).setRestitution(0.1).setCollisionGroups(OBJ_GROUPS).setMass(m);
    // body-frame collider shapes, for the overlap test when an objective is put down
    const shapes = (body) => Array.from({ length: body.numColliders() }, (_, i) => {
      const col = body.collider(i), t = body.translation(), q = body.rotation(), ct = col.translation(), cq = col.rotation();
      const iq = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
      return { shape: col.shape, t: rotate(iq, { x: ct.x - t.x, y: ct.y - t.y, z: ct.z - t.z }), q: quatMul(iq, cq) };
    });
    const dyn = (x, y, z, q) => {
      const d = R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setCcdEnabled(true);
      if (q) d.setRotation(q);
      return d;
    };
    // Objective A: cube at the centre of the Central High Ground
    const [cx, cy, cz] = FIELD.cube_start;
    const cube = this.world.createRigidBody(dyn(cx, cy, cz + O.cube.size / 2 + 0.001));
    this.world.createCollider(objCollider(R.ColliderDesc.cuboid(O.cube.size / 2, O.cube.size / 2, O.cube.size / 2), O.cube.mass), cube);
    this.objectives.push({ type: 'cube', body: cube });
    // Objective C: a donut around each zig-zag pole (straight pole until its shape is announced)
    for (const team of ['red', 'blue']) {
      const [px, py, pz] = FIELD.poles[team];
      const body = this.world.createRigidBody(dyn(px, py, pz + O.donut.thick / 2 + 0.001));
      const n = 10, mid = (O.donut.outer + O.donut.inner) / 2, hr = (O.donut.outer - O.donut.inner) / 2;
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        this.world.createCollider(objCollider(
          R.ColliderDesc.cuboid(hr, (Math.PI * mid / n) * 1.1, O.donut.thick / 2)
            .setTranslation(mid * Math.cos(a), mid * Math.sin(a), 0).setRotation(quatFromYaw(a)), O.donut.mass / n), body);
      }
      this.objectives.push({ type: 'donut', body, start: team });
    }
    // Objective B: bucket with 5 red + 5 blue pipes, standing
    const [bx, by] = FIELD.bucket_start, B = O.bucket;
    const bucket = this.world.createRigidBody(dyn(bx, by, 0.001));
    this.world.createCollider(objCollider(R.ColliderDesc.cylinder(B.wall / 2, B.radius)
      .setRotation(quatAxisAngle(1, 0, 0, Math.PI / 2)).setTranslation(0, 0, B.wall / 2), B.mass * 0.3), bucket);
    const nw = 16;
    for (let i = 0; i < nw; i++) {
      const a = (2 * Math.PI * i) / nw, r = B.radius - B.wall / 2;
      this.world.createCollider(objCollider(
        R.ColliderDesc.cuboid(B.wall / 2, (Math.PI * B.radius / nw) * 1.1, B.height / 2)
          .setTranslation(r * Math.cos(a), r * Math.sin(a), B.height / 2).setRotation(quatFromYaw(a)), (B.mass * 0.7) / nw), bucket);
    }
    this.objectives.push({ type: 'bucket', body: bucket });
    const spots = [];
    for (let i = 0; i < 8; i++) spots.push([0.06 * Math.cos((i * Math.PI) / 4), 0.06 * Math.sin((i * Math.PI) / 4)]);
    spots.push([0.02, 0], [-0.02, 0]);
    // The pipes stand in the bucket held by fixed joints (loose, ten thin cylinders in a pushed
    // bucket rattle at many m/s in the solver); they come free when grabbed or when the bucket tips.
    const standing = quatAxisAngle(1, 0, 0, Math.PI / 2), zc = B.wall + O.pipe.length / 2 + 0.002;
    spots.forEach(([dx, dy], i) => {
      const body = this.world.createRigidBody(dyn(bx + dx, by + dy, zc, standing));
      this.world.createCollider(objCollider(R.ColliderDesc.cylinder(O.pipe.length / 2, O.pipe.radius), O.pipe.mass), body);
      const dock = this.world.createImpulseJoint(R.JointData.fixed({ x: dx, y: dy, z: zc }, standing, { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0, w: 1 }), bucket, body, true);
      dock.setContactsEnabled(false);
      this.objectives.push({ type: 'pipe', color: i % 2 ? 'blue' : 'red', body, dock });
    });
    for (const o of this.objectives) Object.assign(o, { held: false, heldBy: null, turnedIn: false, scoring: null, ghost: false, shapes: shapes(o.body) });
  }

  // ---------------------------------------------------------------- queries
  pose(r) {
    const p = r.body.translation(), q = r.body.rotation();
    return { x: p.x, y: p.y, z: p.z, q, yaw: yawOf(q) };
  }

  elapsed() { return this.phase === 'ready' ? 0 : Math.min(this.t - this.startT, RULES.battleSeconds); }

  remaining() { return RULES.battleSeconds - this.elapsed(); }

  running() { return this.phase === 'running'; }

  name(r) { return `${teamName(r.team)} ${r.cls.name}`; }

  log(text, kind = 'info') {
    this.events.push({ t: this.elapsed(), text, kind, seq: ++this.eventSeq });
    if (this.events.length > 60) this.events.shift();
  }

  // Test / setup helper: put a robot at (x, y) on whatever surface is there, at rest.
  place(key, x, y, yawDeg = 0) {
    const b = this.robots[key].body;
    b.setTranslation({ x, y, z: this.floorZ(x, y) + 0.002 }, true);
    b.setRotation(quatFromYaw((yawDeg * Math.PI) / 180), true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.robots[key].turretYaw = this.robots[key].viewYaw = (yawDeg * Math.PI) / 180;
  }

  // UI: a robot that has tipped over or got stuck goes back to its start position, upright.
  putBack(key) {
    const [x, y, yaw] = spawnOf(key);
    this.place(key, x, y, yaw);
    this.log(`${this.name(this.robots[key])} put back at its start position`);
  }

  placeObjective(o, x, y, z, q = { x: 0, y: 0, z: 0, w: 1 }) {
    this.undock(o);
    o.body.setTranslation({ x, y, z }, true);
    o.body.setRotation(q, true);
    o.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    o.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  start() {
    if (this.phase !== 'ready') return;
    this.phase = 'running';
    this.startT = this.t;
    this.lastWholeSecond = 0;
    this.log('Battle started');
  }

  // ---------------------------------------------------------------- step
  step(cmds = {}) {
    const dt = PHYSICS.dt;
    this.t += dt;
    for (const key of this.keys) {
      const r = this.robots[key];
      this.lifecycle(r);
      this.limboCheck(r);
      let cmd = cmds[key] ?? ZERO_CMD;
      r.autoOn = r.role === 'sentry' && !!cmd.auto;
      if (r.autoOn) cmd = autoCommand(this, r);
      else if (this.t < r.blockedUntil || this.phase === 'ended') cmd = ZERO_CMD;   // pilot's interface blocked
      if (cmd.spinEdge) r.spin = !r.spin;
      this.drive(r, cmd, dt);
      if (r.role === 'engineer') this.arm(r, cmd, dt);
      if (r.cls.launcher) this.shoot(r, cmd, dt);
      if (r.role === 'hero') this.buy(r, cmd);
    }
    this.targetLifecycle();
    this.world.step();
    this.limitVelocities();
    this.unghost();
    this.bucketCheck();
    this.followHeld();
    this.rules(dt);
    this.tracers = this.tracers.filter((tr) => tr.until > this.t);
  }

  lifecycle(r) {
    if (!r.alive && this.t >= r.respawnAt) {
      r.alive = true;
      r.hp = Math.round(r.cls.maxHp * RULES.respawnHp);
      r.invincibleUntil = this.t + RULES.invincibleSeconds;
      r.weakened = true;
      r.heat = 0;
      this.log(`${this.name(r)} respawned (weakened until it reaches its Resupply Zone)`);
    }
  }

  defeat(r, why) {
    if (!r.alive) return;
    r.alive = false;
    r.hp = 0;
    r.deaths += 1;
    r.respawnAt = this.t + RULES.respawnFirst + RULES.respawnStep * (r.deaths - 1);
    if (r.held) this.release(r);
    const by = other(r.team);
    if (this.running()) this.vp[by] += RULES.vp.kill;
    this.log(`${this.name(r)} defeated (${why}): +${RULES.vp.kill} ${by}; respawn in ${(r.respawnAt - this.t).toFixed(0)} s`, r.team === 'red' ? 'bad' : 'good');
  }

  damage(r, hp, why) {
    r.hp = Math.max(0, r.hp - Math.round(hp));
    if (r.hp <= 0) this.defeat(r, why);
  }

  // Sentry under the Limbo Bars (setting): switch its collisions only while it is clear of every bar,
  // so turning the setting off never leaves it inside one.
  limboCheck(r) {
    const want = r.role === 'sentry' && this.sentryLimbo[r.team];
    if (want === r.underLimbo) return;
    if (!want) {
      const p = r.body.translation(), m = Math.hypot(r.cls.chassis[0], r.cls.chassis[1]) / 2 + 0.02;
      if (LIMBO_RECTS.some(([x0, x1, y0, y1]) => p.x > x0 - m && p.x < x1 + m && p.y > y0 - m && p.y < y1 + m)) return;
    }
    r.underLimbo = want;
    for (let i = 0; i < r.body.numColliders(); i++) r.body.collider(i).setCollisionGroups(want ? UNDER_LIMBO_GROUPS : ROBOT_GROUPS);
  }

  // Wheels that touch something: rays from the wheel centres along the robot's down axis. Gives the
  // share of wheels down and the mean surface normal under them.
  groundContact(r) {
    const R = this.R, b = r.body, q = b.rotation(), p = b.translation();
    const down = rotate(q, { x: 0, y: 0, z: -1 });
    let k = 0, nx = 0, ny = 0, nz = 0;
    for (const w of r.wheels) {
      const o = rotate(q, w);
      const hit = this.world.castRayAndGetNormal(new R.Ray({ x: p.x + o.x, y: p.y + o.y, z: p.z + o.z }, down),
        WHEEL_R + WHEEL_REACH, true, undefined, GROUND_GROUPS, undefined, b);
      if (!hit) continue;
      k += 1;
      nx += hit.normal.x; ny += hit.normal.y; nz += hit.normal.z;   // zero when the ray starts inside
    }
    const len = Math.hypot(nx, ny, nz);
    return { frac: k / r.wheels.length, n: len > 1e-6 ? { x: nx / len, y: ny / len, z: nz / len } : rotate(q, { x: 0, y: 0, z: 1 }) };
  }

  // Powered chassis: force towards the commanded velocity, limited by wheel traction and power.
  // The wheels push along the surface they stand on (normal n), with traction from the wheels that
  // are down: a robot lifted on an objective or tipped over cannot drive itself up or over it.
  drive(r, cmd, dt) {
    const b = r.body, c = r.cls, m = c.mass, g = PHYSICS.gravity;
    b.resetForces(true);
    b.resetTorques(true);
    const v = b.linvel(), w = b.angvel();
    // the driver turns the view (gimbal) heading; the chassis follows it, or spins under it
    if (r.alive) r.viewYaw = wrap(r.viewYaw + cmd.rot * DRIVE.maxYawRate * dt);
    const contact = this.groundContact(r), n = contact.n;
    r.grounded = contact.frac;
    r.offGround = contact.frac === 0 ? r.offGround + dt : 0;
    r.powerW = 0;
    if (contact.frac === 0) return;   // in the air: wheels push on nothing
    const powered = r.alive && this.t >= r.chassisOffUntil;
    // losses (rolling resistance + motor drag) oppose the motion
    const sp = Math.hypot(v.x, v.y, v.z);
    const loss = sp > 1e-3 ? (DRIVE.rollingN * m * g + DRIVE.dragPerMs * sp) / sp : 0;
    let Fx = -loss * v.x, Fy = -loss * v.y, Fz = -loss * v.z;
    let tz = 0;
    if (powered) {
      let mx = cmd.mx, my = cmd.my;
      const mag = Math.hypot(mx, my);
      if (mag > 1) { mx /= mag; my /= mag; }
      // speed controller (horizontal), projected onto the ground plane
      const cx = m * DRIVE.responseHz * (mx * DRIVE.maxSpeed - v.x);
      const cy = m * DRIVE.responseHz * (my * DRIVE.maxSpeed - v.y);
      const cn = cx * n.x + cy * n.y;
      // plus holding against the part of gravity along the ground (ramps)
      let dx = cx - cn * n.x - m * g * n.z * n.x;
      let dy = cy - cn * n.y - m * g * n.z * n.y;
      let dz = -cn * n.z + m * g * (1 - n.z * n.z);
      const traction = DRIVE.tractionMu * m * g * Math.max(0, n.z) * contact.frac;
      const f = Math.hypot(dx, dy, dz);
      if (f > traction) { dx *= traction / f; dy *= traction / f; dz *= traction / f; }
      // yaw
      const follow = clamp(DRIVE.yawFollowGain * wrap(r.viewYaw - yawOf(b.rotation())), -DRIVE.maxYawRate, DRIVE.maxYawRate);
      const wDes = r.spin ? DRIVE.spinYawRate : follow;
      const [L, Wd] = c.chassis;
      const Iz = (m * (L * L + Wd * Wd)) / 12;
      tz = clamp(Iz * DRIVE.yawResponseHz * (wDes - w.z), -traction * 0.25, traction * 0.25);
      // power: electrical = mechanical (driving only) / efficiency; boost draws the capacitor
      const avail = c.powerW + (cmd.boost && r.cap > 0 ? DRIVE.capBoostW : 0);
      let pRot = Math.max(0, tz * w.z) / DRIVE.efficiency;
      if (pRot > 0.6 * avail) { tz *= (0.6 * avail) / pRot; pRot = 0.6 * avail; }
      let pLin = Math.max(0, dx * v.x + dy * v.y + dz * v.z) / DRIVE.efficiency;
      if (pLin > avail - pRot) { const s = (avail - pRot) / pLin; dx *= s; dy *= s; dz *= s; pLin = avail - pRot; }
      r.powerW = pLin + pRot;
      if (r.powerW > c.powerW) r.cap = Math.max(0, r.cap - (r.powerW - c.powerW) * dt);
      else r.cap = Math.min(DRIVE.capJ, r.cap + (c.powerW - r.powerW) * DRIVE.capChargeEff * dt);
      Fx += dx; Fy += dy; Fz += dz;
    }
    b.addForce({ x: Fx, y: Fy, z: Fz }, true);
    b.addTorque({ x: tz * n.x, y: tz * n.y, z: tz * n.z }, true);
  }

  // ---------------------------------------------------------------- engineer
  grabPoint(r) {
    const p = r.body.translation(), q = r.body.rotation();
    const o = rotate(q, { x: r.cls.chassis[0] / 2 + r.reach, y: 0, z: r.lift });
    return { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z };
  }

  arm(r, cmd, dt) {
    const c = r.cls;
    r.lift = clamp(r.lift + ((cmd.liftUp ? 1 : 0) - (cmd.liftDown ? 1 : 0)) * c.liftRate * dt, c.lift[0], c.lift[1]);
    r.reach = clamp(r.reach + ((cmd.reachOut ? 1 : 0) - (cmd.reachIn ? 1 : 0)) * c.reachRate * dt, c.reach[0], c.reach[1]);
    r.grab = this.grabPoint(r);
    if (!cmd.actionEdge || !r.alive) return;
    if (r.held) this.release(r);
    else this.tryGrab(r);
  }

  objectiveDistance(o, p) {
    const t = o.body.translation();
    if (o.type !== 'pipe') return Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) - (o.type === 'cube' ? OBJECTIVES.cube.size / 2 : 0);
    const a = rotate(o.body.rotation(), { x: 0, y: 1, z: 0 }), h = OBJECTIVES.pipe.length / 2;
    const s = clamp((p.x - t.x) * a.x + (p.y - t.y) * a.y + (p.z - t.z) * a.z, -h, h);
    return Math.hypot(p.x - t.x - s * a.x, p.y - t.y - s * a.y, p.z - t.z - s * a.z);
  }

  tryGrab(r) {
    const p = this.grabPoint(r);
    let best = null, bestD = r.cls.grabRadius;
    for (const o of this.objectives) {
      if (o.type === 'bucket' || o.turnedIn || o.held) continue;
      const d = this.objectiveDistance(o, p);
      if (d < bestD) { best = o; bestD = d; }
    }
    if (!best) return;
    this.undock(best);
    best.held = true;
    best.heldBy = r.key;
    r.held = best;
    best.body.setGravityScale(0, true);
    best.ghost = false;
    this.setGroups(best, HELD_GROUPS);
  }

  undock(o) {
    if (!o.dock) return;
    this.world.removeImpulseJoint(o.dock, true);
    o.dock = null;
  }

  // Pipes still docked fall out once the bucket leans over.
  bucketCheck() {
    const b = this.objectives.find((o) => o.type === 'bucket').body;
    if (rotate(b.rotation(), { x: 0, y: 0, z: 1 }).z > Math.cos((OBJECTIVES.bucketSpillDeg * Math.PI) / 180)) return;
    for (const o of this.objectives) if (o.dock) this.undock(o);
  }

  setGroups(o, g) {
    for (let i = 0; i < o.body.numColliders(); i++) o.body.collider(i).setCollisionGroups(g);
  }

  // Held level, turned with the robot; a pipe (axis = body y) across the front, so all of it is in
  // front of the chassis (held lengthwise, half of it was inside the robot and was thrown out when
  // let go).
  heldRotation(r) {
    return quatFromYaw(yawOf(r.body.rotation()));
  }

  // Would objective o at pose (t, q) overlap anything in the query groups?
  overlaps(o, t, q, query) {
    return o.shapes.some((s) => {
      const d = rotate(q, s.t);
      return !!this.world.intersectionWithShape({ x: t.x + d.x, y: t.y + d.y, z: t.z + d.z }, quatMul(q, s.q), s.shape,
        undefined, query, undefined, o.body);
    });
  }

  // A held objective passes through everything, so where it is let go it may be inside something.
  // The solver would push it out of a deep overlap at many m/s (and the robot with it): put it
  // down just above whatever the grab point is in (up to 0.3 m), keep holding it if there is no
  // room, and let it pass through robots until it is clear of them.
  release(r) {
    const o = r.held;
    if (!o) return;
    const p = this.grabPoint(r);
    if (o.type === 'pipe') {
      for (const team of ['red', 'blue']) {
        const [x, y, z] = FIELD.chutes[team];
        if (Math.hypot(p.x - x, p.y - y, p.z - z) < OBJECTIVES.pipeTurnInRadius) {
          r.held = null;
          o.held = false;
          o.heldBy = null;
          o.turnedIn = true;
          this.world.removeRigidBody(o.body);
          o.body = null;
          if (this.running()) this.vp[o.color] += RULES.vp.pipe;
          this.log(`${o.color} pipe turned in at the ${team} Pipe Chute: +${RULES.vp.pipe} ${o.color}`, 'good');
          return;
        }
      }
    }
    const q = this.heldRotation(r);
    let t = null;
    for (let dz = 0; dz <= 0.3001 && !t; dz += 0.005) {
      const c = { x: p.x, y: p.y, z: p.z + dz };
      if (!this.overlaps(o, c, q, SOLID_QUERY)) t = c;
    }
    if (!t) {
      if (this.t - r.releaseBlockedAt > 1) this.log(`${r.cls.name}: no room to put the ${o.type} down here`, 'bad');
      r.releaseBlockedAt = this.t;
      return;
    }
    r.held = null;
    o.held = false;
    o.heldBy = null;
    o.body.setTranslation(t, true);
    o.body.setRotation(q, true);
    o.body.setGravityScale(1, true);
    o.ghost = this.overlaps(o, t, q, ROBOT_QUERY);
    this.setGroups(o, o.ghost ? GHOST_GROUPS : OBJ_GROUPS);
    const v = r.body.linvel();
    o.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
  }

  // Released objectives that were in a robot collide with robots again once clear of them.
  unghost() {
    for (const o of this.objectives) {
      if (!o.ghost || !o.body) continue;
      if (!this.overlaps(o, o.body.translation(), o.body.rotation(), ROBOT_QUERY)) {
        o.ghost = false;
        this.setGroups(o, OBJ_GROUPS);
      }
    }
  }

  // Safety net against solver blow-ups (a deep overlap, e.g. after tunnelling): nothing comes out
  // of a physics step faster than it can really move.
  limitVelocities() {
    const L = PHYSICS.limits;
    const cap = (b, xy, up, down, w) => {
      const v = b.linvel(), a = b.angvel();
      let { x, y, z } = v, hit = false;
      const h = Math.hypot(x, y);
      if (h > xy) { x *= xy / h; y *= xy / h; hit = true; }
      if (z > up || z < -down) { z = clamp(z, -down, up); hit = true; }
      if (hit) b.setLinvel({ x, y, z }, true);
      const am = Math.hypot(a.x, a.y, a.z);
      if (am > w) { b.setAngvel({ x: (a.x * w) / am, y: (a.y * w) / am, z: (a.z * w) / am }, true); hit = true; }
      return hit;
    };
    for (const key of this.keys) {
      if (cap(this.robots[key].body, L.robotXY, L.robotUp, L.fall, L.robotSpin)) this.limited.robot += 1;
    }
    for (const o of this.objectives) {
      if (o.body && !o.held && cap(o.body, L.objective, L.objective, L.fall, L.objectiveSpin)) this.limited.objective += 1;
    }
  }

  followHeld() {
    for (const key of this.keys) {
      const r = this.robots[key];
      if (!r.held) continue;
      const p = this.grabPoint(r);
      const o = r.held.body;
      o.setTranslation(p, true);
      o.setRotation(this.heldRotation(r), true);
      const v = r.body.linvel();
      o.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      o.setAngvel({ x: 0, y: 0, z: 0 }, true);
      r.grab = p;
    }
  }

  // ---------------------------------------------------------------- shooting
  muzzle(r) {
    const p = r.body.translation();
    return { x: p.x, y: p.y, z: p.z + r.cls.upper[2] - 0.06 };
  }

  // What a launcher can aim at: the other alliance's robots (not while invincible: nothing to gain)
  // and, against targets, the fixed targets. Aim point at armour height.
  enemies(r) {
    const out = [];
    for (const key of this.keys) {
      const e = this.robots[key];
      if (e.team === r.team || !e.alive || this.t < e.invincibleUntil) continue;
      const p = e.body.translation();
      out.push({ ref: e, robot: true, name: this.name(e), x: p.x, y: p.y, z: p.z + e.cls.chassis[2] + 0.12, body: e.body, half: e.cls.chassis[1] / 2 });
    }
    if (r.team === 'red') {
      for (const t of this.targets) if (t.alive) out.push({ ref: t, robot: false, name: t.name, x: t.x, y: t.y, z: t.z + 0.25, body: t.body, half: 0.275 });
    }
    return out;
  }

  lineOfSight(r, aim) {
    const R = this.R, o = this.muzzle(r);
    const d = { x: aim.x - o.x, y: aim.y - o.y, z: aim.z - o.z }, dist = Math.hypot(d.x, d.y, d.z);
    const hit = this.world.castRay(new R.Ray(o, { x: d.x / dist, y: d.y / dist, z: d.z / dist }), dist + 0.5, true,
      undefined, SHOT_GROUPS, undefined, r.body);
    if (!hit) return false;
    const col = hit.collider ?? this.world.getCollider(hit.colliderHandle);
    return col?.parent()?.handle === aim.body.handle;
  }

  shoot(r, cmd, dt) {
    const c = r.cls, is42 = c.launcher === '42';
    const per = is42 ? RULES.heat.per42 : RULES.heat.per17, extra = is42 ? RULES.heat.extra42 : RULES.heat.extra17;
    r.heat = Math.max(0, r.heat - c.coolPerSec * dt);
    if (r.heatLocked && r.heat <= 0) r.heatLocked = false;
    const p = r.body.translation(), yaw = yawOf(r.body.rotation());
    // Aim. Auto-aim locks on to the nearest enemy in sight within lock range: for a player only close
    // by (aimLockM) and in front of the view (so the chase camera shows what is being shot), for a
    // Sentry on Auto close by (sentryLockM) all round. Otherwise the gimbal faces the view heading and
    // a player aims by hand: a shot hits the nearest enemy in sight that the barrel points at.
    const auto = r.autoOn;
    const cone = auto ? Math.PI : (this.aimConeDeg * Math.PI) / 180;
    const lockM = Math.min(c.rangeM, auto ? this.sentryLockM : this.aimLockM);
    const enemies = r.alive ? this.enemies(r) : [];
    const bearing = (e) => Math.atan2(e.y - p.y, e.x - p.x), dist = (e) => Math.hypot(e.x - p.x, e.y - p.y);
    let best = null, bestD = lockM;
    for (const e of enemies) {
      const d = dist(e);
      if (d < bestD && Math.abs(wrap(bearing(e) - r.viewYaw)) <= cone && this.lineOfSight(r, e)) { best = e; bestD = d; }
    }
    r.aimTarget = best;
    const want = best ? bearing(best) : r.viewYaw;
    const err = wrap(want - r.turretYaw);
    const yawStep = (c.gimbalYawRate ?? 12) * dt;
    r.turretYaw = wrap(r.turretYaw + clamp(err, -yawStep, yawStep));
    // A player's view rides on the gimbal: while fire is held and auto-aim has a target, the view (so
    // the cameras and the chassis) turns with the gimbal and stays there afterwards, as on a real
    // robot. Turning the stick wins, and moving the target out of the cone ends the lock.
    if (best && !auto && cmd.action && Math.abs(cmd.rot) < 0.05) r.viewYaw = r.turretYaw;
    let onBarrel = null;
    if (!best && !auto) {   // by hand: the barrel within an enemy's half width of its centre (bigger robot: easier)
      let bd = c.rangeM;
      for (const e of enemies) {
        const d = dist(e);
        if (d < bd && Math.abs(wrap(bearing(e) - r.turretYaw)) <= Math.atan2(e.half, d) && this.lineOfSight(r, e)) { onBarrel = e; bd = d; }
      }
    }
    r.onBarrel = onBarrel;
    // for the card: why it does not fire
    r.fireNote = !r.alive ? '' : r.ammo <= 0 ? 'no ammo' : r.weakened ? 'weakened: no firing until Resupply'
      : r.lockedForGame ? 'launcher locked' : r.heatLocked ? 'cooling'
      : best ? (Math.abs(err) >= 0.08 ? `turning to ${best.name}` : `auto-aim on ${best.name}`)
      : onBarrel ? `on target by hand: ${onBarrel.name} ${dist(onBarrel).toFixed(1)} m`
      : auto ? `no enemy within ${lockM} m in sight` : `aim by hand (auto-aim within ${lockM} m)`;
    const target = best ?? onBarrel;
    const fire = auto ? best && Math.abs(err) < 0.08 : cmd.action && (!best || Math.abs(err) < 0.08);
    if (!fire || !r.alive || r.weakened || r.heatLocked || r.lockedForGame || r.ammo <= 0) return;
    if (this.t - r.lastShot < 1 / c.fireRateHz) return;
    if (SHOOT.guardHeat && r.heat + per > c.heatMax) return;
    r.lastShot = this.t;
    r.ammo -= 1;
    r.heat += per;
    if (r.heat > c.heatMax + extra) { r.lockedForGame = true; this.log(`${this.name(r)} launcher locked for the game (heat)`, 'bad'); }
    else if (r.heat > c.heatMax) r.heatLocked = true;
    const hit = !!target && this.random() < this.hitProbability[r.key];
    const from = this.muzzle(r);
    const to = target ? { x: target.x, y: target.y, z: target.z }   // nothing on the barrel: straight out to full range
      : { x: from.x + c.rangeM * Math.cos(r.turretYaw), y: from.y + c.rangeM * Math.sin(r.turretYaw), z: from.z - 0.3 };
    if (target && !hit) { to.x += (this.random() - 0.5) * 0.8; to.y += (this.random() - 0.5) * 0.8; to.z += this.random() * 0.4; }
    this.tracers.push({ from, to, hit, big: is42, team: r.team, until: this.t + (is42 ? 0.25 : 0.08) });
    if (!hit) return;
    const dmg = SHOOT.damage[c.launcher];
    if (target.robot) { this.damage(target.ref, dmg, `shot by ${this.name(r)}`); return; }
    const t = target.ref;
    t.hp -= dmg;
    if (t.hp <= 0) {
      t.hp = 0;
      t.alive = false;
      t.deaths += 1;
      t.respawnAt = this.t + TARGET_RESPAWN_S;
      if (this.running()) this.vp.red += RULES.vp.kill;
      this.log(`${this.name(r)} defeated ${t.name}: +${RULES.vp.kill} red`, 'good');
    }
  }

  targetLifecycle() {
    for (const t of this.targets) {
      if (!t.alive && this.t >= t.respawnAt) { t.alive = true; t.hp = t.maxHp; }
    }
  }

  buy(r, cmd) {
    if (!r.alive || !this.inZone(r, FIELD.zones[`${r.team}_start`])) return;
    const repeat = cmd.buy && this.t - r.lastBuy > 0.15;
    if ((cmd.buyEdge || repeat) && this.gold[r.team] >= RULES.goldPer42) {
      this.gold[r.team] -= RULES.goldPer42;
      r.ammo += 1;
      r.lastBuy = this.t;
    }
  }

  // ---------------------------------------------------------------- rules
  inZone(r, rect) {   // occupation: centre inside (RFID cards in the zone)
    const p = r.body.translation();
    return inRect(p.x, p.y, rect);
  }

  overZone(r, rect) {  // Penalty Zone: any part on or directly above it
    const p = this.pose(r), [L, Wd] = r.cls.chassis;
    if (obbOverlapsRect(p.x, p.y, p.yaw, L / 2, Wd / 2, rect)) return true;
    if (r.role === 'engineer') {
      const g = r.grab ?? this.grabPoint(r);
      if (inRect(g.x, g.y, rect)) return true;
    }
    return false;
  }

  yellowCard(offender, why) {
    const Y = RULES.yellow;
    this.log(`Yellow Card: ${this.name(offender)} (${why})`, offender.team === 'red' ? 'bad' : 'good');
    for (const key of this.keys) {   // the offender's alliance
      const r = this.robots[key];
      if (!r.alive || r.team !== offender.team) continue;
      const mine = r === offender;
      this.damage(r, r.cls.maxHp * (mine ? Y.offenderHp : Y.othersHp), 'Yellow Card');
      if (offender.role === 'sentry') {
        if (mine) r.chassisOffUntil = Math.max(r.chassisOffUntil, this.t + Y.sentryChassisOff);
        else r.blockedUntil = Math.max(r.blockedUntil, this.t + Y.othersBlock);
      } else {
        r.blockedUntil = Math.max(r.blockedUntil, this.t + (mine ? Y.offenderBlock : Y.othersBlock));
      }
    }
  }

  scoringState(o) {
    if (o.held || o.turnedIn || !o.body) return null;
    const t = o.body.translation(), v = o.body.linvel();
    if (Math.hypot(v.x, v.y, v.z) > 0.1) return null;
    const q = o.body.rotation();
    for (const team of ['red', 'blue']) {
      const [[x0, x1], [y0, y1], top] = FIELD.scoring_platform[team];
      if (t.x < x0 || t.x > x1 || t.y < y0 || t.y > y1) continue;
      if (o.type === 'cube') {
        const flat = ['x', 'y', 'z'].some((k) => Math.abs(rotate(q, { x: +(k === 'x'), y: +(k === 'y'), z: +(k === 'z') }).z) > 0.985);
        if (flat && Math.abs(t.z - (top + OBJECTIVES.cube.size / 2)) < 0.012) return team;
      } else if (o.type === 'donut') {
        const flat = Math.abs(rotate(q, { x: 0, y: 0, z: 1 }).z) > 0.985;
        if (flat && Math.abs(t.z - (top + OBJECTIVES.donut.thick / 2)) < 0.01) return team;
      }
    }
    return null;
  }

  rules(dt) {
    const Z = FIELD.zones;
    // occupation of the own Resupply Zone: heal, end Weakened / Invincible
    for (const key of this.keys) {
      const r = this.robots[key];
      if (r.alive && this.inZone(r, Z[`${r.team}_start`])) {
        r.hp = Math.min(r.cls.maxHp, r.hp + r.cls.maxHp * RULES.healPerSec * dt);
        if (r.weakened) { r.weakened = false; r.invincibleUntil = 0; }
      }
    }
    for (const o of this.objectives) if (o.type === 'cube' || o.type === 'donut') o.scoring = this.scoringState(o);
    if (!this.running()) return;
    // Penalty Zones (R48): both Scoring Areas and the opponent's Resupply Zone
    for (const key of this.keys) {
      const r = this.robots[key];
      const foe = other(r.team);
      for (const [name, rect] of [['red Scoring Area', Z.red_scoring_zone], ['blue Scoring Area', Z.blue_scoring_zone],
        [`${foe} Resupply Zone`, Z[`${foe}_start`]]]) {
        const z = (r.zones[name] ??= { t: 0, cards: 0 });
        if (r.alive && this.overZone(r, rect)) {
          z.t += dt;
          if (z.t > RULES.penaltyZoneSeconds + z.cards * RULES.penaltyRepeatSeconds) {
            z.cards += 1;
            this.yellowCard(r, `${z.t.toFixed(1)} s in the ${name}`);
          }
        } else { z.t = 0; z.cards = 0; }
      }
      // R51: only Engineers may Control Objectives ("directly above" part; pipes may be driven over)
      if (r.role !== 'engineer') {
        const p = this.pose(r), [L, Wd, , top] = r.cls.chassis;
        const above = r.alive && this.objectives.some((o) => o.body && !o.held && (o.type === 'cube' || o.type === 'donut') && (() => {
          const t = o.body.translation();
          return t.z < p.z + top && inObb(t.x, t.y, p.x, p.y, p.yaw, L / 2, Wd / 2);
        })());
        const c = r.control;
        if (above) {
          if (!c.active) { c.active = true; c.t = 0; c.cards = 0; }
          c.t += dt;
          if (c.t >= c.cards * RULES.penaltyRepeatSeconds) { c.cards += 1; this.yellowCard(r, 'controlling an Objective (R51)'); }
        } else c.active = false;
      }
    }
    // per-second Victory Points and Gold
    const el = this.elapsed();
    while (this.lastWholeSecond + 1 <= el) {
      this.lastWholeSecond += 1;
      for (const o of this.objectives) {
        if (!o.scoring) continue;
        this.vp[o.scoring] += o.type === 'cube' ? RULES.vp.cubePerSec : RULES.vp.donutPerSec;
      }
    }
    const rem = this.remaining();
    for (const [at, coins] of RULES.gold) {
      if (rem <= at && !this.goldGiven.has(at)) {
        this.goldGiven.add(at);
        this.gold.red += coins;
        this.gold.blue += coins;
      }
    }
    for (const team of TEAMS) {   // the alliance behind gets Gold
      const diff = this.vp[other(team)] - this.vp[team], cb = this.comeback[team];
      for (const d of [100, 200]) {
        if (diff >= d && !cb.given.has(d) && cb.total < 160) {
          cb.given.add(d);
          cb.total += 80;
          this.gold[team] += 80;
          this.log(`${teamName(team)} is behind: +80 Gold`);
        }
      }
    }
    if (this.vp.red >= RULES.vpToWin || this.vp.blue >= RULES.vpToWin || rem <= 0) {
      this.phase = 'ended';
      this.result = this.vp.red === this.vp.blue ? 'draw' : this.vp.red > this.vp.blue ? 'red' : 'blue';
      this.log(`Battle over: red ${this.vp.red} : ${this.vp.blue} blue`, 'good');
    }
  }
}
