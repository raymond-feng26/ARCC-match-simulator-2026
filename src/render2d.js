// Top-down 2D canvas view: the fallback when WebGL is not available (or with ?2d).
// Same interface as View in render.js, with one view only (no split screen).
import FIELD from './field_data.js';
import { OBJECTIVES } from './params.js';
import { rotate, yawOf } from './geom.js';

const COLORS = {
  floor: '#5d6168', wall: '#2c2f34', side_wall: '#2c2f34', central_wall: '#1f2226', chg_top: '#bfc2c7',
  chg_ramp: '#d2d4d8', shg_lower: '#b88a57', shg_upper: '#9c7145', pole: '#d0d4da', side_limbo: '#d3aa6c',
  central_limbo: '#d3aa6c', bumpy: '#232427', chute: '#b8bcc1',
};
const TEAM = { red: '#e0453a', blue: '#3d7be0' };
const LABEL = { red: '#ffd7d2', blue: '#d2e2ff' };
const HP_COLOR = { red: '#e8574d', blue: '#5b8df0' };
const ORDER = ['floor', 'bumpy', 'chg_ramp', 'chg_top', 'shg_lower', 'shg_upper', 'scoring', 'wall', 'side_wall',
  'central_wall', 'chute', 'pole', 'side_limbo', 'central_limbo'];

export class View2D {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.layout = 'single';
    this.viewports = [{ mode: 'top', el: container }];
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get mode() { return 'top'; }
  setLayout() {}
  axesFor() { return this.screenAxes(); }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 600;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    // fit the field into the area not covered by the HUD (top bar, cards, side panel)
    const left = 12, right = w > 900 ? 292 : 12, top = 104, bottom = w > 900 ? 200 : 260;
    const aw = Math.max(200, w - left - right), ah = Math.max(150, h - top - bottom);
    this.s = Math.min(aw / 12.6, ah / 8.6);
    this.ox = left + (aw - 12.6 * this.s) / 2 + 0.3 * this.s;
    this.oy = top + (ah - 8.6 * this.s) / 2 + 8.3 * this.s;
  }

  setMode() {}
  screenAxes() { return { f: [0, 1], r: [1, 0] }; }
  attach() {}

  px(x, y) { return [this.ox + x * this.s, this.oy - y * this.s]; }

  rect(x0, x1, y0, y1, fill, stroke) {
    const [a, b] = this.px(x0, y1), g = this.g;
    if (fill) { g.fillStyle = fill; g.fillRect(a, b, (x1 - x0) * this.s, (y1 - y0) * this.s); }
    if (stroke) { g.strokeStyle = stroke; g.strokeRect(a, b, (x1 - x0) * this.s, (y1 - y0) * this.s); }
  }

  obb(x, y, yaw, L, W, fill, stroke, lw = 2) {
    const g = this.g, c = Math.cos(yaw), s = Math.sin(yaw);
    g.beginPath();
    [[L, W], [L, -W], [-L, -W], [-L, W]].forEach(([a, b], i) => {
      const [u, v] = this.px(x + (a / 2) * c - (b / 2) * s, y + (a / 2) * s + (b / 2) * c);
      if (i) g.lineTo(u, v); else g.moveTo(u, v);
    });
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
  }

  line(x0, y0, x1, y1, color, lw) {
    const g = this.g, [a, b] = this.px(x0, y0), [c, d] = this.px(x1, y1);
    g.strokeStyle = color; g.lineWidth = lw;
    g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
  }

  circle(x, y, r, fill, stroke, lw = 2) {
    const g = this.g, [a, b] = this.px(x, y);
    g.beginPath(); g.arc(a, b, Math.max(1.5, r * this.s), 0, Math.PI * 2);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
  }

  text(t, x, y, color = '#fff', size = 12) {
    const g = this.g, [a, b] = this.px(x, y);
    g.font = `600 ${size}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.strokeText(t, a, b);
    g.fillStyle = color; g.fillText(t, a, b);
  }

  bar(x, y, frac, color) {
    const g = this.g, [a, b] = this.px(x, y), w = 0.5 * this.s, h = Math.max(3, 0.05 * this.s);
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(a - w / 2, b, w, h);
    g.fillStyle = color; g.fillRect(a - w / 2, b, w * frac, h);
  }

  drawField(sim, ui) {
    const g = this.g;
    const parts = [...FIELD.parts].sort((p, q) => ORDER.indexOf(p.kind.replace(/^(red|blue)_/, '')) - ORDER.indexOf(q.kind.replace(/^(red|blue)_/, '')));
    for (const p of parts) {
      const team = /^(red|blue)_/.exec(p.kind)?.[1], base = p.kind.replace(/^(red|blue)_/, '');
      const color = base === 'scoring' ? TEAM[team] : COLORS[base] ?? '#888';
      if (p.shape === 'box') {
        const [[x0, x1], [y0, y1]] = p.args;
        if (base === 'floor') { this.rect(-0.3, 12.3, -0.3, 8.3, color); continue; }
        this.rect(x0, x1, y0, y1, color, base === 'shg_upper' || base === 'chg_top' ? 'rgba(0,0,0,0.35)' : null);
      } else {
        const [xf, xt, [y0, y1]] = p.args;
        const [a] = this.px(xf, 0), [b] = this.px(xt, 0);
        const grad = g.createLinearGradient(a, 0, b, 0);
        grad.addColorStop(0, '#7d8188'); grad.addColorStop(1, color);
        this.rect(Math.min(xf, xt), Math.max(xf, xt), y0, y1, grad);
      }
    }
    g.lineWidth = Math.max(1.5, 0.05 * this.s);
    this.rect(...FIELD.zones.red_start.flat(), null, TEAM.red);
    this.rect(...FIELD.zones.blue_start.flat(), null, TEAM.blue);
    this.rect(...FIELD.zones.red_scoring_zone.flat(), null, TEAM.red);
    this.rect(...FIELD.zones.blue_scoring_zone.flat(), null, TEAM.blue);
    g.setLineDash([6, 6]);
    this.line(6, 0, 6, 8, 'rgba(255,255,255,0.35)', 1);
    g.setLineDash([]);
    for (const [name, rect] of [['red Scoring Area', FIELD.zones.red_scoring_zone], ['blue Scoring Area', FIELD.zones.blue_scoring_zone],
      ['blue Resupply Zone', FIELD.zones.blue_start], ['red Resupply Zone', FIELD.zones.red_start]]) {
      const active = sim.keys.some((k) => (sim.robots[k].zones[name]?.t ?? 0) > 0);
      if (active || ui.showZones) this.rect(...rect.flat(), active ? `rgba(255,204,51,${0.25 + 0.15 * Math.sin(sim.t * 10)})` : 'rgba(255,204,51,0.12)');
    }
  }

  update(sim, ui = {}) {
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#15171b';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawField(sim, ui);
    const O = OBJECTIVES;
    for (const o of sim.objectives) {
      if (o.turnedIn || !o.body) continue;
      const p = o.body.translation(), q = o.body.rotation();
      const glow = o.scoring ? TEAM[o.scoring] : null;
      if (o.type === 'cube') this.obb(p.x, p.y, yawOf(q), O.cube.size, O.cube.size, '#f0c53a', glow ?? '#7a5c00', glow ? 3 : 1);
      else if (o.type === 'donut') this.circle(p.x, p.y, 0.0375, null, glow ?? '#f08a3c', Math.max(3, 0.025 * this.s));
      else if (o.type === 'bucket') this.circle(p.x, p.y, O.bucket.radius, 'rgba(140,147,155,0.5)', '#9aa0a8', 2);
      else {
        const a = rotate(q, { x: 0, y: 1, z: 0 }), h = O.pipe.length / 2;
        const col = o.color === 'red' ? '#e2463d' : '#4a7ee8';
        if (Math.abs(a.z) > 0.9) this.circle(p.x, p.y, 0.016, col, '#111', 1);
        else this.line(p.x - a.x * h, p.y - a.y * h, p.x + a.x * h, p.y + a.y * h, col, Math.max(2, 0.027 * this.s));
      }
    }
    for (const t of sim.targets) {
      this.obb(t.x, t.y, t.yawRad, 0.55, 0.55, t.alive ? '#34373d' : '#1c1d20', t.alive ? TEAM.blue : '#333', 3);
      this.text(t.name.replace('Target ', ''), t.x, t.y, '#cfe0ff', 13);
      this.bar(t.x, t.y + 0.42, t.hp / t.maxHp, '#5b8df0');
    }
    for (const key of sim.keys) {
      const r = sim.robots[key], p = r.body.translation(), yaw = yawOf(r.body.rotation());
      const [L, W] = r.cls.chassis;
      const off = !r.alive || sim.t < r.chassisOffUntil;
      this.obb(p.x, p.y, yaw, L, W, r.alive ? '#2b2d31' : '#191a1c', off ? '#4a3a3a' : r.weakened ? '#8a7a80' : TEAM[r.team], 3);
      // front marker
      const fx = Math.cos(yaw), fy = Math.sin(yaw);
      this.line(p.x, p.y, p.x + fx * L * 0.45, p.y + fy * L * 0.45, '#888', 2);
      if (r.cls.launcher) {
        const big = r.cls.launcher === '42';
        this.circle(p.x, p.y, r.cls.upper[0] / 2, '#4d525a', null);
        this.line(p.x, p.y, p.x + Math.cos(r.turretYaw) * 0.38, p.y + Math.sin(r.turretYaw) * 0.38, '#d9dde3', big ? 5 : 3);
        if (r.alive && !r.autoOn && !r.aimTarget) {   // aiming by hand: where the barrel points
          const L = r.cls.rangeM;
          this.line(p.x, p.y, p.x + Math.cos(r.turretYaw) * L, p.y + Math.sin(r.turretYaw) * L, r.onBarrel ? 'rgba(125,255,122,0.8)' : 'rgba(255,255,255,0.25)', 1);
        }
      }
      if (r.role === 'engineer') {
        const gp = r.grab ?? sim.grabPoint(r);
        this.line(p.x + fx * L / 2, p.y + fy * L / 2, gp.x, gp.y, '#d0a23c', 4);
        this.circle(gp.x, gp.y, 0.03, r.held ? '#55aaff' : '#55ff88', '#111', 1);
      }
      this.text(String(r.cls.id), p.x, p.y, LABEL[r.team], 13);
      this.bar(p.x, p.y + 0.45, r.hp / r.cls.maxHp, HP_COLOR[r.team]);
    }
    for (const tr of sim.tracers) {
      this.line(tr.from.x, tr.from.y, tr.to.x, tr.to.y, tr.big ? '#ffffff' : tr.hit ? (tr.team === 'blue' ? '#7fe0ff' : '#c8ff4a') : 'rgba(138,154,90,0.6)', tr.big ? 3 : 1.5);
    }
  }
}
