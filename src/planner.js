// Route planner for the Sentry's autonomy. The field as a 0.1 m height map of what a robot stands on
// (from the field data: floor, steps, ramps, walls), with the cells it cannot be on: next to a step
// higher than it can drive over (anything but a ramp), under a bar lower than the robot (Limbo Bars
// only when that Sentry may pass them), outside the field, or in a Penalty Zone for its alliance;
// all grown by the robot's half size. A* over the free cells, then the path pulled straight.
import FIELD from './field_data.js';

const RES = 0.1;
const MAX_STEP = 0.035;      // m between neighbouring cells: ramps (15 deg: 2.7 cm per cell) yes, steps no
const ROBOT_HEIGHT = 0.57;   // sentry (robot.yaml robot_height)
const CLEARANCE = 0.30;      // m from the centre of the nearest edge cell: half width 0.275 + margin
const PENALTY_MARGIN = 0.4;  // any part of the robot over a Penalty Zone counts: half diagonal 0.39
const [W, H] = FIELD.size;
const NX = Math.round(W / RES), NY = Math.round(H / RES);

function surface(x, y) {   // like Sim.floorZ: parts standing on the floor, and ramps
  let z = 0;
  for (const p of FIELD.parts) {
    if (p.shape === 'box') {
      const [[x0, x1], [y0, y1], [z0, z1]] = p.args;
      if (z0 <= 0.001 && x >= x0 && x <= x1 && y >= y0 && y <= y1) z = Math.max(z, z1);
    } else {
      const [xf, xt, [y0, y1], h] = p.args, s = (x - xf) / (xt - xf);
      if (s >= 0 && s <= 1 && y >= y0 && y <= y1) z = Math.max(z, s * h);
    }
  }
  return z;
}

export class FieldGrid {
  // team: whose Penalty Zones to keep out of; passLimbo: the Limbo Bars do not block
  constructor({ team = 'red', passLimbo = false } = {}) {
    const idx = (i, j) => j * NX + i, cx = (i) => (i + 0.5) * RES;
    const h = new Float32Array(NX * NY), edge = new Uint8Array(NX * NY);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) h[idx(i, j)] = surface(cx(i), cx(j));
    // bars and other parts in the air, lower than the robot above the surface there
    for (const p of FIELD.parts) {
      if (p.shape !== 'box' || (passLimbo && p.kind.endsWith('limbo'))) continue;
      const [[x0, x1], [y0, y1], [z0]] = p.args;
      if (z0 <= 0.001) continue;
      for (let j = Math.max(0, Math.floor(y0 / RES)); j <= Math.min(NY - 1, Math.floor(y1 / RES)); j++) {
        for (let i = Math.max(0, Math.floor(x0 / RES)); i <= Math.min(NX - 1, Math.floor(x1 / RES)); i++) {
          if (z0 < h[idx(i, j)] + ROBOT_HEIGHT) edge[idx(i, j)] = 1;
        }
      }
    }
    // steps: cells on both sides of a height jump; the field boundary
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        if (i === 0 || j === 0 || i === NX - 1 || j === NY - 1) { edge[idx(i, j)] = 1; continue; }
        const z = h[idx(i, j)];
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => Math.abs(h[idx(i + di, j + dj)] - z) > MAX_STEP)) edge[idx(i, j)] = 1;
      }
    }
    // grow: no robot centre within CLEARANCE of an edge cell
    const blocked = new Uint8Array(NX * NY), r = Math.ceil(CLEARANCE / RES);
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        if (!edge[idx(i, j)]) continue;
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            const a = i + di, b = j + dj;
            if (a >= 0 && b >= 0 && a < NX && b < NY && Math.hypot(di, dj) * RES <= CLEARANCE) blocked[idx(a, b)] = 1;
          }
        }
      }
    }
    // Penalty Zones for this alliance: both Scoring Areas and the opponent's Resupply Zone
    const foe = team === 'red' ? 'blue' : 'red', Z = FIELD.zones;
    for (const [[x0, x1], [y0, y1]] of [Z.red_scoring_zone, Z.blue_scoring_zone, Z[`${foe}_start`]]) {
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const x = cx(i), y = cx(j);
          if (x > x0 - PENALTY_MARGIN && x < x1 + PENALTY_MARGIN && y > y0 - PENALTY_MARGIN && y < y1 + PENALTY_MARGIN) blocked[idx(i, j)] = 1;
        }
      }
    }
    Object.assign(this, { h, blocked, idx, cx });
  }

  cell(x, y) { return [Math.min(NX - 1, Math.max(0, Math.floor(x / RES))), Math.min(NY - 1, Math.max(0, Math.floor(y / RES)))]; }

  free(i, j, extra) {
    if (i < 0 || j < 0 || i >= NX || j >= NY || this.blocked[this.idx(i, j)]) return false;
    if (!extra.length) return true;
    const x = this.cx(i), y = this.cx(j);
    return !extra.some(([ox, oy, or]) => Math.hypot(x - ox, y - oy) < or);
  }

  nearestFree(i0, j0, extra) {
    if (this.free(i0, j0, extra)) return [i0, j0];
    for (let r = 1; r < 30; r++) {
      let best = null, bd = Infinity;
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || !this.free(i, j, extra)) continue;
          const d = Math.hypot(i - i0, j - j0);
          if (d < bd) { bd = d; best = [i, j]; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // Straight-line check on free cells (every half cell).
  clear(a, b, extra) {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (RES / 2));
    for (let k = 0; k <= n; k++) {
      const [i, j] = this.cell(a[0] + ((b[0] - a[0]) * k) / Math.max(1, n), a[1] + ((b[1] - a[1]) * k) / Math.max(1, n));
      if (!this.free(i, j, extra)) return false;
    }
    return true;
  }

  // Waypoints [x, y] from (fx, fy) to (tx, ty); extra: discs [x, y, r] to keep out of (parked robots).
  // A start or goal in a blocked cell (pressed against a wall, say) moves to the nearest free cell.
  // Returns null when there is no way.
  plan(fx, fy, tx, ty, extra = []) {
    const s = this.nearestFree(...this.cell(fx, fy), extra), g = this.nearestFree(...this.cell(tx, ty), extra);
    if (!s || !g) return null;
    const N = NX * NY, idx = this.idx, gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1);
    const open = [[0, idx(...s)]];   // [f, cell]; small binary heap
    const push = (f, c) => { open.push([f, c]); let k = open.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (open[p][0] <= open[k][0]) break; [open[p], open[k]] = [open[k], open[p]]; k = p; } };
    const pop = () => { const top = open[0], last = open.pop(); if (open.length) { open[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === k) break; [open[m], open[k]] = [open[k], open[m]]; k = m; } } return top; };
    const goal = idx(...g), hgt = (i, j) => Math.hypot(i - g[0], j - g[1]);
    gs[idx(...s)] = 0;
    const closed = new Uint8Array(N);
    while (open.length) {
      const [, c] = pop();
      if (closed[c]) continue;
      closed[c] = 1;
      if (c === goal) break;
      const i = c % NX, j = Math.floor(c / NX);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((!di && !dj) || !this.free(i + di, j + dj, extra)) continue;
          if (di && dj && (!this.free(i + di, j, extra) || !this.free(i, j + dj, extra))) continue;   // no corner cutting
          const n = idx(i + di, j + dj), gn = gs[c] + Math.hypot(di, dj);
          if (gn < gs[n]) { gs[n] = gn; from[n] = c; push(gn + hgt(i + di, j + dj), n); }
        }
      }
    }
    if (!closed[goal]) return null;
    const cells = [];
    for (let c = goal; c !== -1; c = from[c]) cells.push([this.cx(c % NX), this.cx(Math.floor(c / NX))]);
    cells.reverse();
    // pull the path straight: from each kept point, jump to the farthest point still in plain sight
    const out = [];
    let k = 0;
    while (k < cells.length - 1) {
      let m = cells.length - 1;
      while (m > k + 1 && !this.clear(cells[k], cells[m], extra)) m -= 1;
      out.push(cells[m]);
      k = m;
    }
    return out.length ? out : [cells[cells.length - 1]];
  }
}

const cache = new Map();
// One grid per alliance and Limbo setting (the field does not change).
export function fieldGrid(team, passLimbo) {
  const key = `${team}:${passLimbo ? 1 : 0}`;
  if (!cache.has(key)) cache.set(key, new FieldGrid({ team, passLimbo }));
  return cache.get(key);
}
