// three.js view of the simulation. z-up, field frame (see geom.js). Robots are built from
// primitives: chassis with skirt and armor, four omni wheels at the corners, gimbal / arm on top.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import FIELD from './field_data.js';
import { ROBOTS, OBJECTIVES } from './params.js';
import { teamName } from './sim.js';
import { yawOf } from './geom.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const COLORS = {
  floor: 0x60646b, wall: 0x2f3237, side_wall: 0x2f3237, central_wall: 0x25282c, chg_top: 0xc6c9ce,
  chg_ramp: 0xe0e2e5, shg_lower: 0xbc8f5b, shg_upper: 0xa77b4b, pole: 0x8f949a, side_limbo: 0xd3aa6c,
  central_limbo: 0xd3aa6c, bumpy: 0x1c1d20, chute: 0xb8bcc1,
};
const TEAM = { red: 0xe0453a, blue: 0x3d7be0 };
const LABEL = { red: '#ffd7d2', blue: '#d2e2ff' };
const HP_COLOR = { red: '#e8574d', blue: '#5b8df0' };
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...extra });

function box(w, d, h, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cyl(r, h, mat, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function labelSprite(text, color = '#fff', scale = 0.32) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(text, 64, 34);
  g.fillStyle = color;
  g.fillText(text, 64, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(scale * 2, scale, 1);
  s.renderOrder = 10;
  return s;
}

class Bar {   // HP bar sprite
  constructor(width = 0.6) {
    this.c = document.createElement('canvas');
    this.c.width = 128; this.c.height = 16;
    this.tex = new THREE.CanvasTexture(this.c);
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false }));
    this.sprite.scale.set(width, width / 8, 1);
    this.sprite.renderOrder = 11;
    this.last = -1;
  }
  set(frac, color) {
    const f = Math.round(frac * 100) / 100;
    if (f === this.last) return;
    this.last = f;
    const g = this.c.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(0, 0, 128, 16);
    g.fillStyle = color; g.fillRect(2, 2, 124 * f, 12);
    this.tex.needsUpdate = true;
  }
}

function omniWheel(mat, rollerMat) {
  const g = new THREE.Group();
  const hub = cyl(0.06, 0.03, mat, 18);
  g.add(hub);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = box(0.018, 0.034, 0.024, rollerMat, 0.058 * Math.cos(a), 0, 0.058 * Math.sin(a));
    r.rotation.y = -a;
    g.add(r);
  }
  return g;   // wheel axis = local y
}

function buildRobot(c, role, team) {   // c: the robot's class (sizes; the Hero's can be scaled)
  const teamColor = TEAM[team];
  const [L, W, zb, zt] = c.chassis, [uL, uW, uTop] = c.upper;
  const root = new THREE.Group();
  const dark = std(0x2b2d31), plate = std(0x4d525a), metal = std(0x9aa0a8, { metalness: 0.5, roughness: 0.4 });
  const strip = new THREE.MeshStandardMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 1.2 });
  const parts = { root, strips: [strip] };
  // skirt (chamfered by four corner posts) and top plate
  root.add(box(L - 0.12, W, 0.085, dark, 0, 0, zb + 0.043));
  root.add(box(L, W - 0.12, 0.085, dark, 0, 0, zb + 0.043));
  root.add(box(L - 0.04, W - 0.04, 0.014, plate, 0, 0, zt - 0.007));
  root.add(box(L * 0.6, W * 0.6, zt - zb - 0.1, dark, 0, 0, (zt + zb + 0.1) / 2));
  // omni wheels in the corners, axles towards the centre
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const w = omniWheel(metal, std(0x1a1a1a));
    w.position.set(sx * (L / 2 - 0.07), sy * (W / 2 - 0.07), 0.06);
    w.rotation.z = Math.atan2(sy, sx) - Math.PI / 2;
    root.add(w);
  }
  // armor plates with light strips on the four sides
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2, d = (i % 2 === 0 ? L : W) / 2 + 0.012;
    const g = new THREE.Group();
    g.add(box(0.02, 0.14, 0.125, std(0x3a3d42), 0, 0, 0));
    g.add(box(0.024, 0.012, 0.11, strip, 0, 0.076, 0));
    g.add(box(0.024, 0.012, 0.11, strip, 0, -0.076, 0));
    g.position.set(d * Math.cos(a), d * Math.sin(a), zb + 0.12);
    g.rotation.z = a;
    root.add(g);
  }
  // number
  const label = labelSprite(String(c.id), LABEL[team]);
  label.position.set(0, 0, uTop + 0.22);
  root.add(label);
  const hp = new Bar(0.55);
  hp.sprite.position.set(0, 0, uTop + 0.36);
  root.add(hp.sprite);
  parts.hp = hp;
  parts.label = label;
  if (c.launcher) {
    const turret = new THREE.Group();
    turret.position.set(0, 0, zt);
    const ring = cyl(uL / 2, 0.05, plate, 24);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 0.025;
    turret.add(ring);
    const headZ = uTop - zt - 0.11;
    turret.add(box(0.2, 0.2, 0.13, dark, 0.02, 0, headZ));
    const big = c.launcher === '42';
    const barrel = cyl(big ? 0.028 : 0.013, big ? 0.36 : 0.3, metal, 14);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(0.2, 0, headZ + 0.02);
    turret.add(barrel);
    turret.add(box(0.05, 0.08, 0.04, std(0x111111), 0.11, 0, headZ + 0.085));   // camera
    if (role === 'sentry') {   // MID-360 on the yaw platform, tilted 10 deg towards the barrel
      const lidar = cyl(0.033, 0.065, std(0x15171a), 24);
      lidar.rotation.x = Math.PI / 2;
      lidar.rotation.y = 0.17;
      lidar.position.set(-0.06, -0.13, uTop - zt - 0.035);
      turret.add(lidar);
    }
    root.add(turret);
    parts.turret = turret;
  }
  if (role === 'engineer') {
    root.add(box(uL, uW, uTop - zt, std(0x3b3f46), -0.05, 0, (uTop + zt) / 2));
    for (const sy of [-0.12, 0.12]) root.add(box(0.03, 0.03, 0.85, metal, L / 2 - 0.04, sy, 0.43));
    const carriage = new THREE.Group();
    carriage.add(box(0.06, 0.3, 0.05, plate, L / 2 - 0.02, 0, 0));
    const arm = box(1, 0.05, 0.035, std(0xd0a23c), 0.5, 0, 0);
    const armPivot = new THREE.Group();
    armPivot.position.x = L / 2;
    armPivot.add(arm);
    carriage.add(armPivot);
    const claw = new THREE.Group();
    claw.add(box(0.03, 0.12, 0.03, metal, 0, 0, 0));
    claw.add(box(0.07, 0.015, 0.05, metal, 0.035, 0.055, 0));
    claw.add(box(0.07, 0.015, 0.05, metal, 0.035, -0.055, 0));
    carriage.add(claw);
    root.add(carriage);
    Object.assign(parts, { carriage, armPivot, claw });
  }
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return parts;
}

function buildTarget() {
  const root = new THREE.Group();
  const strip = new THREE.MeshStandardMaterial({ color: TEAM.blue, emissive: TEAM.blue, emissiveIntensity: 1.2 });
  const body = std(0x34373d);
  root.add(box(0.55, 0.55, 0.2, body, 0, 0, 0.115));
  root.add(box(0.3, 0.3, 0.34, body, 0, 0, 0.385));
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const g = new THREE.Group();
    g.add(box(0.02, 0.14, 0.125, std(0x3a3d42)));
    g.add(box(0.024, 0.012, 0.11, strip, 0, 0.076, 0));
    g.add(box(0.024, 0.012, 0.11, strip, 0, -0.076, 0));
    g.position.set(0.287 * Math.cos(a), 0.287 * Math.sin(a), 0.13);
    g.rotation.z = a;
    root.add(g);
  }
  const hp = new Bar(0.55);
  hp.sprite.position.set(0, 0, 0.75);
  root.add(hp.sprite);
  return { root, strip, hp, body };
}

const QUAD_GAP = 3;   // px between split-screen views
const CHASE_FOV = 48, FPV_FOV = 65;   // deg, vertical
// 'follow:KEY' (chase camera) and 'fpv:KEY' (first person) both track robot KEY
export const viewKey = (mode) => (/^(follow|fpv):/.test(mode) ? mode.slice(mode.indexOf(':') + 1) : null);

export class View {
  // noGL: build and update the scene without a renderer (checks without a GPU).
  constructor(container, { noGL = false } = {}) {
    this.container = container;
    this.renderer = noGL ? null : new THREE.WebGLRenderer({ antialias: true });
    if (this.renderer) {
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.shadowMap.autoUpdate = false;   // one shadow pass per frame for all views
      this.renderer.setScissorTest(true);
      container.appendChild(this.renderer.domElement);
    }
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x15171b);
    this.scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x30302c, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, -4, 12);
    sun.target.position.set(6, 4, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
    this.scene.add(sun, sun.target);
    this.buildField();
    this.robots = {};
    this.grabMarkers = {};
    this.objectiveMeshes = new Map();
    this.targetViews = [];
    this.tracerPool = [];
    this.viewports = [];
    this.layout = 'single';
    this.setLayout('single', ['overview']);
    window.addEventListener('resize', () => this.resize());
  }

  // 'single': one view over the whole window; 'quad': four, each with its own camera mode.
  setLayout(layout, modes = []) {
    for (const v of this.viewports) { v.controls.dispose(); v.el.remove(); }
    this.layout = layout;
    const n = layout === 'quad' ? 4 : 1;
    this.viewports = Array.from({ length: n }, (_, i) => {
      const el = document.createElement('div');
      el.className = `view-pane${n > 1 ? ' quad' : ''}`;
      this.container.appendChild(el);
      const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 100);
      camera.up.set(0, 0, 1);
      const controls = new OrbitControls(camera, el);
      controls.enableDamping = true;
      controls.maxPolarAngle = Math.PI * 0.49;
      const v = { el, camera, controls, mode: 'overview', rect: [0, 0, 1, 1] };
      this.setViewMode(v, modes[i] ?? 'overview');
      return v;
    });
    this.resize();
  }

  get mode() { return this.viewports[0].mode; }

  setMode(mode, i = 0) { this.setViewMode(this.viewports[i], mode); }

  setViewMode(v, mode) {
    v.mode = mode;
    const follow = !!viewKey(mode);
    v.controls.enabled = !follow;
    v.el.classList.toggle('follow', follow);
    v.camera.fov = mode.startsWith('fpv:') ? FPV_FOV : CHASE_FOV;
    v.camera.updateProjectionMatrix();
    if (mode === 'overview') { v.camera.position.set(6, -6.2, 8.4); v.controls.target.set(6, 3.7, 0); }
    if (mode === 'top') { v.camera.position.set(6, 3.98, 15.5); v.controls.target.set(6, 4, 0); }
    v.snap = true;   // a follow camera jumps to its robot instead of gliding there
    if (!follow) v.controls.update();
  }

  resize() {
    const W = this.container.clientWidth || 800, H = this.container.clientHeight || 600;
    this.renderer?.setSize(W, H);
    const quad = this.viewports.length === 4, hw = (W - QUAD_GAP) / 2, hh = (H - QUAD_GAP) / 2;
    this.viewports.forEach((v, i) => {
      // rect in CSS px from the top left: x, y, w, h
      v.rect = quad ? [(i % 2) * (hw + QUAD_GAP), Math.floor(i / 2) * (hh + QUAD_GAP), hw, hh] : [0, 0, W, H];
      const [x, y, w, h] = v.rect;
      Object.assign(v.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      v.camera.aspect = w / h;
      v.camera.updateProjectionMatrix();
    });
  }

  // Unit vectors (field frame) of "forward" and "right" on screen in a view, for camera-relative driving.
  screenAxes(i = 0) {
    const v = this.viewports[i] ?? this.viewports[0];
    const d = new THREE.Vector3();
    v.camera.getWorldDirection(d);
    let fx = d.x, fy = d.y;
    if (Math.hypot(fx, fy) < 0.05) { const u = v.camera.up; fx = u.x; fy = u.y; }
    const n = Math.hypot(fx, fy) || 1;
    fx /= n; fy /= n;
    if (v.mode === 'top') { fx = 0; fy = 1; }
    return { f: [fx, fy], r: [fy, -fx] };
  }

  // Axes for driving a robot: those of the view that follows it, else of the first view.
  axesFor(key) {
    const i = this.viewports.findIndex((v) => viewKey(v.mode) === key);
    return this.screenAxes(Math.max(0, i));
  }
  buildField() {
    for (const p of FIELD.parts) {
      const team = /^(red|blue)_/.exec(p.kind)?.[1];
      const base = p.kind.replace(/^(red|blue)_/, '');
      const color = base === 'scoring' ? TEAM[team] : COLORS[base] ?? 0x888888;
      let mesh;
      if (p.shape === 'box') {
        const [[x0, x1], [y0, y1], [z0, z1]] = p.args;
        mesh = box(x1 - x0, y1 - y0, z1 - z0, std(color, base === 'bumpy' ? { roughness: 1 } : {}),
          (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        if (base === 'floor') mesh.castShadow = false;
        if (base === 'bumpy') mesh.position.z += 0.0005;
      } else {
        const [xf, xt, [y0, y1], h] = p.args;
        const A0 = [xf, y0, 0], A1 = [xt, y0, 0], A2 = [xt, y1, 0], A3 = [xf, y1, 0], B1 = [xt, y0, h], B2 = [xt, y1, h];
        const tris = [A0, A1, A2, A0, A2, A3, A0, B1, B2, A0, B2, A3, A1, A2, B2, A1, B2, B1, A0, A1, B1, A3, B2, A2];
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
        g.computeVertexNormals();
        mesh = new THREE.Mesh(g, std(color, { side: THREE.DoubleSide }));
        mesh.castShadow = mesh.receiveShadow = true;
      }
      this.scene.add(mesh);
    }
    // tape: Starting Zones, Scoring Area outlines, central line
    const tape = (rect, color, w = 0.0508) => {
      const [[x0, x1], [y0, y1]] = rect, m = std(color, { emissive: color, emissiveIntensity: 0.25 });
      for (const [cx, cy, sx, sy] of [[(x0 + x1) / 2, y0 + w / 2, x1 - x0, w], [(x0 + x1) / 2, y1 - w / 2, x1 - x0, w],
        [x0 + w / 2, (y0 + y1) / 2, w, y1 - y0], [x1 - w / 2, (y0 + y1) / 2, w, y1 - y0]]) {
        const t = box(sx, sy, 0.002, m, cx, cy, 0.001);
        t.castShadow = false;
        this.scene.add(t);
      }
    };
    tape(FIELD.zones.red_start, TEAM.red);
    tape(FIELD.zones.blue_start, TEAM.blue);
    tape(FIELD.zones.red_scoring_zone, TEAM.red);
    tape(FIELD.zones.blue_scoring_zone, TEAM.blue);
    const dash = std(0xdddddd);
    for (let y = 0.1; y < 8; y += 0.4) {
      const t = box(0.02, 0.2, 0.002, dash, 6, y + 0.1, 0.0012);
      t.castShadow = false;
      this.scene.add(t);
    }
    // Penalty Zone highlights (shown when a robot is over one)
    this.zoneMeshes = {};
    for (const [name, rect, color] of [['red Scoring Area', FIELD.zones.red_scoring_zone, 0xffcc33],
      ['blue Scoring Area', FIELD.zones.blue_scoring_zone, 0xffcc33], ['blue Resupply Zone', FIELD.zones.blue_start, 0xffcc33],
      ['red Resupply Zone', FIELD.zones.red_start, 0xffcc33]]) {
      const [[x0, x1], [y0, y1]] = rect;
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, 0.4),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.2);
      this.scene.add(m);
      this.zoneMeshes[name] = m;
    }
  }

  objectiveMesh(o) {
    const O = OBJECTIVES;
    let mesh;
    if (o.type === 'cube') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(O.cube.size, O.cube.size, O.cube.size), std(0xf0c53a, { emissive: 0x000000 }));
    } else if (o.type === 'donut') {
      const mid = (O.donut.outer + O.donut.inner) / 2;
      mesh = new THREE.Mesh(new THREE.TorusGeometry(mid, (O.donut.outer - O.donut.inner) / 2, 12, 28), std(0xf08a3c, { emissive: 0x000000 }));
    } else if (o.type === 'pipe') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(O.pipe.radius, O.pipe.radius, O.pipe.length, 12), std(o.color === 'red' ? 0xd8423a : 0x3a6fd8));
    } else {
      mesh = new THREE.Group();
      const B = O.bucket;
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(B.radius, B.radius, B.height, 28, 1, true), std(0x8d939b, { side: THREE.DoubleSide }));
      wall.rotation.x = Math.PI / 2;
      wall.position.z = B.height / 2;
      const bottom = new THREE.Mesh(new THREE.CylinderGeometry(B.radius, B.radius, B.wall, 28), std(0x8d939b));
      bottom.rotation.x = Math.PI / 2;
      bottom.position.z = B.wall / 2;
      mesh.add(wall, bottom);
    }
    mesh.traverse((m) => { if (m.isMesh) m.castShadow = m.receiveShadow = true; });
    this.scene.add(mesh);
    return mesh;
  }

  attach(sim) {
    for (const v of Object.values(this.robots)) this.scene.remove(v.root);
    for (const m of Object.values(this.grabMarkers)) this.scene.remove(m);
    for (const m of this.objectiveMeshes.values()) this.scene.remove(m);
    for (const t of this.targetViews) this.scene.remove(t.root);
    for (const l of Object.values(this.aimLines ?? {})) this.scene.remove(l);
    this.robots = {};
    this.grabMarkers = {};
    this.aimLines = {};
    for (const key of sim.keys) {
      const r = sim.robots[key];
      this.robots[key] = buildRobot(r.cls, r.role, r.team);
      this.scene.add(this.robots[key].root);
      if (r.cls.launcher) {   // aiming by hand: where the barrel points
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
        this.scene.add(l);
        this.aimLines[key] = l;
      }
      if (r.role === 'engineer') {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0x55ff88, transparent: true, opacity: 0.8, depthTest: false }));
        m.renderOrder = 12;
        this.scene.add(m);
        this.grabMarkers[key] = m;
      }
    }
    this.objectiveMeshes = new Map(sim.objectives.map((o) => [o, this.objectiveMesh(o)]));
    this.targetViews = sim.targets.map((t) => {
      const v = buildTarget();
      v.root.position.set(t.x, t.y, t.z);
      v.root.rotation.z = t.yawRad;
      const label = labelSprite(t.name.replace('Target ', ''), '#cfe0ff', 0.25);
      label.position.z = 0.62;
      v.root.add(label);
      this.scene.add(v.root);
      return v;
    });
  }

  update(sim, ui = {}) {
    for (const key of sim.keys) {
      const r = sim.robots[key], v = this.robots[key];
      const p = r.body.translation(), q = r.body.rotation();
      v.root.position.set(p.x, p.y, p.z);
      v.root.quaternion.set(q.x, q.y, q.z, q.w);
      const yaw = yawOf(q);
      if (v.turret) v.turret.rotation.z = r.turretYaw - yaw;
      if (v.carriage) {
        v.carriage.position.z = r.lift;
        v.armPivot.scale.x = Math.max(0.02, r.reach);
        v.claw.position.x = r.cls.chassis[0] / 2 + r.reach;
      }
      const off = !r.alive || sim.t < r.chassisOffUntil;
      const blink = off ? (Math.floor(sim.t * 4) % 2 ? 0.1 : 0.6) : r.weakened ? 0.5 : 1.2;
      for (const s of v.strips) s.emissiveIntensity = r.alive ? blink : 0;
      v.hp.set(r.hp / r.cls.maxHp, r.alive ? HP_COLOR[r.team] : '#555');
      const al = this.aimLines[key];
      if (al) {
        al.visible = r.alive && !r.autoOn && !r.aimTarget;
        if (al.visible) {
          const m = sim.muzzle(r), a = al.geometry.attributes.position, L = r.cls.rangeM;
          a.setXYZ(0, m.x, m.y, m.z);
          a.setXYZ(1, m.x + L * Math.cos(r.turretYaw), m.y + L * Math.sin(r.turretYaw), m.z - 0.3);
          a.needsUpdate = true;
          al.geometry.computeBoundingSphere();
          al.material.color.set(r.onBarrel ? 0x7dff7a : 0xffffff);
          al.material.opacity = r.onBarrel ? 0.8 : 0.3;
        }
      }
      const gm = this.grabMarkers[key];
      if (gm) {
        const g = r.grab ?? sim.grabPoint(r);
        gm.position.set(g.x, g.y, g.z);
        gm.material.color.set(r.held ? 0x55aaff : 0x55ff88);
        gm.visible = r.alive;
      }
    }
    for (const [o, m] of this.objectiveMeshes) {
      m.visible = !o.turnedIn;
      if (!o.body) continue;
      const p = o.body.translation(), q = o.body.rotation();
      m.position.set(p.x, p.y, p.z);
      m.quaternion.set(q.x, q.y, q.z, q.w);
      if (m.material?.emissive) m.material.emissive.set(o.scoring ? TEAM[o.scoring] : 0x000000);
    }
    sim.targets.forEach((t, i) => {
      const v = this.targetViews[i];
      v.strip.emissiveIntensity = t.alive ? 1.2 : 0;
      v.body.color.set(t.alive ? 0x34373d : 0x1c1d20);
      v.hp.set(t.hp / t.maxHp, '#5b8df0');
    });
    // Penalty Zone highlight
    for (const [name, m] of Object.entries(this.zoneMeshes)) {
      const active = sim.keys.some((k) => (sim.robots[k].zones[name]?.t ?? 0) > 0);
      m.material.opacity = active ? 0.25 + 0.15 * Math.sin(sim.t * 10) : ui.showZones ? 0.12 : 0;
    }
    // tracers
    while (this.tracerPool.length < sim.tracers.length) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true }));
      this.scene.add(l);
      this.tracerPool.push(l);
    }
    this.tracerPool.forEach((l, i) => {
      const tr = sim.tracers[i];
      l.visible = !!tr;
      if (!tr) return;
      const a = l.geometry.attributes.position;
      a.setXYZ(0, tr.from.x, tr.from.y, tr.from.z);
      a.setXYZ(1, tr.to.x, tr.to.y, tr.to.z);
      a.needsUpdate = true;
      l.geometry.computeBoundingSphere();
      l.material.color.set(tr.big ? 0xffffff : tr.hit ? (tr.team === 'blue' ? 0x7fe0ff : 0xc8ff4a) : 0x8a9a5a);
      l.material.opacity = tr.hit ? 1 : 0.5;
    });
    const H = this.container.clientHeight || 600;
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
    for (const v of this.viewports) {
      this.followCamera(sim, v);
      if (v.controls.enabled) v.controls.update();
      if (!this.renderer) continue;
      const [x, y, w, h] = v.rect;
      this.renderer.setViewport(x, H - y - h, w, h);   // WebGL counts y from the bottom
      this.renderer.setScissor(x, H - y - h, w, h);
      // a chase camera sits right behind its robot's number and HP bar, and robots between it and
      // the camera would fill the view with theirs: hide those in that view
      const hide = [], me = viewKey(v.mode) ? this.robots[viewKey(v.mode)] : null;
      if (me) {   // first person: also robots close by (their labels would fill the view)
        const dMe = v.mode.startsWith('fpv:') ? 2.5 : me.root.position.distanceTo(v.camera.position) + 0.3;
        for (const rv of Object.values(this.robots)) if (rv === me || rv.root.position.distanceTo(v.camera.position) < dMe) hide.push(rv);
      }
      for (const rv of hide) rv.label.visible = rv.hp.sprite.visible = false;
      this.renderer.render(this.scene, v.camera);
      for (const rv of hide) rv.label.visible = rv.hp.sprite.visible = true;
    }
  }

  // Chase camera behind the robot's view (gimbal) heading: steady while the chassis spins.
  // First person: just above the gimbal, looking along the view heading (a shooter's barrel shows
  // below; when auto-aim locks on it turns to the target), or for the Engineer (no gimbal) on the
  // lift carriage, turning with the chassis, 0.25 m above the claw and tilted down so the claw stays
  // in view at any height and reach. Kept level on slopes.
  followCamera(sim, v) {
    const key = viewKey(v.mode), r = key ? sim.robots[key] : null;
    if (!r) return;
    const p = r.body.translation();
    if (v.mode.startsWith('fpv:')) {
      const gimbal = !!r.cls.launcher, yaw = gimbal ? r.viewYaw : yawOf(r.body.rotation());
      const c = Math.cos(yaw), s = Math.sin(yaw), ahead = gimbal ? 0 : r.cls.chassis[0] / 2 - 0.1;
      const z = p.z + (gimbal ? r.cls.upper[2] + 0.03 : r.lift + 0.25), pitch = gimbal ? -0.05 : -0.45;
      const x = p.x + ahead * c, y = p.y + ahead * s;
      v.camera.position.set(x, y, z);
      v.camera.lookAt(x + 5 * Math.cos(pitch) * c, y + 5 * Math.cos(pitch) * s, z + 5 * Math.sin(pitch));
      v.snap = true;   // back to a chase view: jump, do not glide
      return;
    }
    const yaw = r.viewYaw;
    const want = new THREE.Vector3(p.x - 2.4 * Math.cos(yaw), p.y - 2.4 * Math.sin(yaw), p.z + 1.7);
    if (v.snap) v.camera.position.copy(want); else v.camera.position.lerp(want, 0.12);
    v.snap = false;
    v.camera.lookAt(p.x + Math.cos(yaw), p.y + Math.sin(yaw), p.z + 0.2);
  }
}

export const robotLabel = (key) => { const [team, role] = key.split('_'); return `${teamName(team)} ${ROBOTS[role].name}`; };
