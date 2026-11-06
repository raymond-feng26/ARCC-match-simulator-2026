// Simplest sentry autonomy: patrol a loop in the own half, shoot whatever enemy it sees (the
// launcher logic in sim.js aims and fires), go home to heal below a set HP or when Weakened,
// and stop when another robot or target is close ahead (then, after a moment, try to go round it).
// Every goal (next patrol point, home, back out) is reached along a path planned on the field
// (planner.js: walls, steps, ramps, Limbo Bars as set, Penalty Zones), so it gets home from
// anywhere, also from the far side of a wall. Points in Red coordinates, mirrored for Blue.
import FIELD from './field_data.js';
import { DRIVE } from './params.js';
import { inRect } from './geom.js';
import { fieldGrid } from './planner.js';

const ZERO = {
  mx: 0, my: 0, rot: 0, action: true, actionEdge: false, liftUp: false, liftDown: false,
  reachOut: false, reachIn: false, boost: false, buy: false, buyEdge: false, spinEdge: false, auto: true,
};
const REPLAN_S = 3, STUCK_S = 2.5;

// Red points -> this robot's alliance (the field is mirrored about x = 6)
const forTeam = (pts, team) => (team === 'blue' ? pts.map(([x, y]) => [FIELD.size[0] - x, y]) : pts);

const nearest = (pts, p) => pts.reduce((best, w, i) =>
  (Math.hypot(w[0] - p.x, w[1] - p.y) < Math.hypot(pts[best][0] - p.x, pts[best][1] - p.y) ? i : best), 0);

const radius = (L, W) => 0.5 * (L / 2 + Math.hypot(L, W) / 2);

// Another robot or target on a collision course: ahead along the travel direction, closer
// sideways than the two bodies plus a margin, and within stopGap of touching.
// Returns the blocking body [x, y, radius] or null. strict (choosing a detour): also bodies
// alongside, with a wider margin.
function obstacleAhead(sim, r, p, dir, A, strict = false) {
  const me = radius(r.cls.chassis[0], r.cls.chassis[1]);
  const others = [];
  for (const o of Object.values(sim.robots)) {
    if (o === r) continue;
    const t = o.body.translation();
    others.push([t.x, t.y, radius(o.cls.chassis[0], o.cls.chassis[1])]);
  }
  for (const t of sim.targets) others.push([t.x, t.y, radius(0.55, 0.55)]);
  return others.find(([x, y, ro]) => {
    const dx = x - p.x, dy = y - p.y;
    const ahead = dx * dir[0] + dy * dir[1], side = Math.abs(dx * dir[1] - dy * dir[0]);
    const margin = strict ? 3 * A.stopSideMargin : A.stopSideMargin;
    return ahead > (strict ? -me : 0) && side < me + ro + margin && ahead - me - ro < A.stopGap;
  }) ?? null;
}

// Robots standing still, as discs for the planner (when the way is blocked by one).
function parkedRobots(sim, r) {
  const out = [];
  for (const o of Object.values(sim.robots)) {
    if (o === r) continue;
    const v = o.body.linvel(), t = o.body.translation();
    if (Math.hypot(v.x, v.y) < 0.2) out.push([t.x, t.y, Math.hypot(o.cls.chassis[0], o.cls.chassis[1]) / 2 + r.cls.chassis[1] / 2 + 0.05]);
  }
  return out;
}

const turn = (d, deg) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [d[0] * c - d[1] * s, d[0] * s + d[1] * c];
};

// Stopped long enough: try headings turned away from the obstacle, then the other way; not into a wall.
function detour(sim, r, p, dir, block, A, grid) {
  const away = (block[0] - p.x) * dir[1] - (block[1] - p.y) * dir[0] > 0 ? 1 : -1;   // obstacle on the left -> turn right
  const open = (d) => [0.3, 0.6].every((s) => grid.free(...grid.cell(p.x + d[0] * s, p.y + d[1] * s), []));
  for (const deg of [35, 70, 105, -35, -70, -105]) {
    const d = turn(dir, away * deg);
    if (!obstacleAhead(sim, r, p, d, A, true) && open(d)) return d;
  }
  return null;
}

export function autoCommand(sim, r) {
  const A = sim.sentryAuto, a = r.auto, p = r.body.translation(), max = r.cls.maxHp;
  const patrol = forTeam(A.patrol, r.team), base = FIELD.zones[`${r.team}_start`], home = forTeam([A.homeSpot], r.team)[0];
  const grid = fieldGrid(r.team, sim.sentryLimbo[r.team]);
  const cmd = { ...ZERO, spinEdge: r.spin !== A.spin };
  // (re)entering auto mode: start from where the robot is
  if (sim.t - (a.lastT ?? -1) > 0.05) {
    a.state = inRect(p.x, p.y, base) ? 'heal' : 'patrol';
    a.idx = nearest(patrol, p);
    a.path = null;
  }
  a.lastT = sim.t;
  a.stopped = false;
  if (!r.alive) { a.path = null; return cmd; }
  if ((r.hp < A.retreatHp * max || r.weakened) && a.state !== 'home' && a.state !== 'heal') { a.state = 'home'; a.path = null; }
  if (a.state === 'home' && inRect(p.x, p.y, base)) { a.state = 'heal'; a.path = null; }   // occupying it is enough
  if (a.state === 'heal') {
    if (r.hp < A.leaveHealedAt * max || r.weakened) return cmd;
    a.state = 'return';   // back out to the nearest patrol point, then patrol on
    a.idx = nearest(patrol, p);
    a.path = null;
  }
  const goal = a.state === 'home' ? home : patrol[a.idx], goalKey = `${goal[0]},${goal[1]}`;
  // (re)plan: new goal or Limbo setting, every few seconds, or no progress; around robots standing still
  const stuck = a.progress && sim.t - a.progress.t > STUCK_S;
  if (!a.path || a.goal !== goalKey || a.grid !== grid || sim.t > a.replanAt || stuck) {
    a.path = grid.plan(p.x, p.y, goal[0], goal[1], parkedRobots(sim, r)) ?? grid.plan(p.x, p.y, goal[0], goal[1]) ?? [goal];   // else ignore them; no way at all: straight at it
    Object.assign(a, { k: 0, goal: goalKey, grid, replanAt: sim.t + REPLAN_S, progress: null });
  }
  let wp = a.path[a.k], dist = Math.hypot(wp[0] - p.x, wp[1] - p.y);
  while (dist < 0.25 && a.k < a.path.length - 1) { a.k += 1; wp = a.path[a.k]; dist = Math.hypot(wp[0] - p.x, wp[1] - p.y); }
  if (dist < 0.25) {   // at the goal
    if (a.state === 'patrol' || a.state === 'return') { a.state = 'patrol'; a.idx = (a.idx + 1) % patrol.length; }
    a.path = null;
    return cmd;
  }
  if (!a.progress || a.progress.k !== a.k || dist < a.progress.dist - 0.05) a.progress = { k: a.k, dist, t: sim.t };
  let dir = [(wp[0] - p.x) / dist, (wp[1] - p.y) / dist];
  let speed = a.k === a.path.length - 1 ? Math.min(A.speed, (dist / 0.6) * A.speed + 0.2) : A.speed;   // slow down at the goal only
  if (a.detour && sim.t < a.detour.until && !obstacleAhead(sim, r, p, a.detour.dir, A, true)) {
    dir = a.detour.dir;
    speed = A.speed * 0.6;
  } else {
    if (a.detour) a.replanAt = 0;   // detour over: plan again from here
    a.detour = null;
    const block = obstacleAhead(sim, r, p, dir, A);
    if (block) {
      a.stoppedSince ??= sim.t;
      a.stopped = true;
      const d = sim.t - a.stoppedSince > A.detourAfter ? detour(sim, r, p, dir, block, A, grid) : null;
      if (!d) return cmd;
      a.detour = { dir: d, until: sim.t + A.detourFor };
      a.stoppedSince = null;
      dir = d;
      speed = A.speed * 0.6;
    } else a.stoppedSince = null;
  }
  cmd.mx = (dir[0] * speed) / DRIVE.maxSpeed;
  cmd.my = (dir[1] * speed) / DRIVE.maxSpeed;
  return cmd;
}
