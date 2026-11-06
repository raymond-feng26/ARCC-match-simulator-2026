// DOM overlay: score / timer and match controls, one card per robot (control binding, HP, launcher,
// arm, penalties), in split screen a camera choice and a status strip in each view, targets,
// connected gamepads, settings, event log and the help screen.
import { ROBOTS, KEYSETS, RULES, DRIVE } from './params.js';
import { teamName } from './sim.js';
import { BINDINGS } from './input.js';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
};
const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const KEY_NAMES = { Comma: ',', Period: '.', Semicolon: ';', Slash: '/', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', ShiftLeft: 'Shift L', ShiftRight: 'Shift R', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const keyName = (code) => KEY_NAMES[code] ?? code.replace(/^Key/, '');
const robotName = (key) => { const [team, role] = key.split('_'); return `${teamName(team)} ${ROBOTS[role].name}`; };
const viewKey = (mode) => (/^(follow|fpv):/.test(mode) ? mode.slice(mode.indexOf(':') + 1) : null);
const bindingName = (b) => BINDINGS.find(([v]) => v === b)?.[1] ?? b;
// supercapacitor: stored energy and the chassis power drawn now (above the limit = from the capacitor)
const capText = (r) => `capacitor ${Math.round((100 * r.cap) / DRIVE.capJ)}% · ${Math.round(r.powerW)} / ${r.cls.powerW} W`;

// Default controls. 3v3: four players on gamepads, both sentries automatic.
export function defaultBindings(mode) {
  return mode === 'targets'
    ? { red_hero: 'wasd', red_engineer: 'arrows', red_sentry: 'auto' }
    : { red_hero: 'pad0', red_engineer: 'pad1', red_sentry: 'auto', blue_hero: 'pad2', blue_engineer: 'pad3', blue_sentry: 'auto' };
}

// The keys that matter for this robot with this control: [[keys], what they do].
const PAD = { action: 'RT', liftUp: 'D-pad ↑', liftDown: 'D-pad ↓', reachOut: 'RB', reachIn: 'LB', boost: 'LT', buy: 'X', spin: 'Y',
  rotL: 'right stick', rotR: null };
function keyHint(role, binding) {
  if (binding === 'any') binding = 'wasd';   // online: keys (shown) or the first gamepad
  const k = KEYSETS[binding] ?? (/^pad\d$/.test(binding) ? PAD : null);
  if (!k) return [];
  const n = (...codes) => codes.filter(Boolean).map((c) => (k === PAD ? c : keyName(c)));
  const turn = [n(k.rotL, k.rotR), 'turn'];
  if (role === 'engineer') {
    return [[n(k.action), 'grab / let go'], [n(k.liftUp, k.liftDown), 'arm up / down'], [n(k.reachOut, k.reachIn), 'arm out / in'], turn];
  }
  return [[n(k.action), 'fire (hold)'], ...(role === 'hero' ? [[n(k.buy), 'buy ammo']] : []), [n(k.boost), 'boost'],
    [n(k.spin), 'spin'], turn];
}
const hintNodes = (items) => items.flatMap(([keys, what], i) => [
  ...(i ? [' · '] : []), ...keys.flatMap((c) => [el('kbd', {}, c), ' ']), what]);

export class UI {
  // app: sim(), view(), input(), start, togglePause, reset, putBack(key), setCamera(mode, i), setLayout,
  // setMatchMode; online also seatName(key), backToRoom.
  // online: { me: seat key or null, spectator } — one player per computer: own robot only, set views
  constructor(root, app, { flat = false, bindings, online = null } = {}) {
    this.root = root;
    this.app = app;
    this.flat = flat;   // 2D view: one top view, no camera choice
    this.online = online;
    const sim = app.sim();
    if (online) bindings = online.me ? { [online.me]: 'any' } : {};
    this.state = { bindings: { ...(bindings ?? defaultBindings(sim.mode)) }, cameraRelative: true, showZones: false };
    this.lastDraw = 0;
    this.quads = [];
    this.toastsEl = el('div', { class: 'toasts' });
    this.toasts = [];
    this.lastToastSeq = sim.eventSeq;
    root.append(this.top(), this.cards(), this.side(), this.sideShowBtn, this.toastsEl, this.help());
    this.layoutChanged();
    let hidden = false;
    try { hidden = localStorage.getItem('matchSim.sideHidden') === '1'; } catch { /* no storage: shown */ }
    this.toggleSide(!hidden);
    // keys drive the robots: a focused button would take Space / Enter, a select or slider the arrows
    root.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
    window.addEventListener('resize', () => this.placeQuads());
  }

  cameraOptions() {
    const me = this.online?.me;
    if (this.online && !this.online.spectator) {   // a player: the whole field or the own robot
      return [['overview', 'Overview'], ['top', 'Top'], ...(me ? [[`follow:${me}`, `My ${robotName(me)}`], [`fpv:${me}`, `My ${robotName(me)}, first person`]] : [])];
    }
    const keys = this.app.sim().keys;
    return [['overview', 'Overview'], ['top', 'Top'], ...keys.map((k) => [`follow:${k}`, `Follow ${robotName(k)}`]),
      ...(this.flat ? [] : keys.map((k) => [`fpv:${k}`, `First person: ${robotName(k)}`]))];
  }

  top() {
    const t = el('div', { class: 'panel top' });
    this.redVp = el('div', { class: 'vp red' }, '0');
    this.blueVp = el('div', { class: 'vp blue' }, '0');
    this.clock = el('div', { class: 'clock' }, '5:00');
    this.phase = el('div', { class: 'phase' }, 'free driving');
    this.goldEl = el('div', { class: 'gold' }, '');
    this.startBtn = el('button', { onclick: () => this.app.start() }, 'Start battle');
    this.pauseBtn = el('button', { onclick: () => this.app.togglePause() }, 'Pause');
    const sim = this.app.sim();
    const mode = el('select', { title: 'Match (restarts the page)', onchange: (e) => this.app.setMatchMode(e.target.value) },
      el('option', { value: '3v3' }, '3v3'), el('option', { value: 'targets' }, 'Red vs targets'));
    mode.value = sim.mode;
    this.layoutSelect = el('select', { title: 'One view or four', onchange: (e) => { this.app.setLayout(e.target.value); e.target.blur(); } },
      el('option', { value: 'single' }, '1 view'), el('option', { value: 'quad' }, '4 views'));
    this.cameraSelect = el('select', { title: 'Camera (V cycles)', onchange: (e) => { this.app.setCamera(e.target.value, 0); e.target.blur(); } },
      ...this.cameraOptions().map(([v, l]) => el('option', { value: v }, l)));
    if (this.flat) { this.layoutSelect.style.display = 'none'; this.cameraSelect.style.display = 'none'; }
    this.robotsBtn = el('button', { title: 'Show / hide the robot cards', onclick: () => this.toggleCards() }, 'Robots');
    // online: back to the room at any time (e.g. to change settings); during a battle it asks first,
    // because it ends the game for everyone
    this.backBtn = el('button', { class: 'primary hidden', title: 'End this game and take everyone back to the room',
      onclick: () => {
        if (this.app.sim().phase !== 'running' || window.confirm('End this game for everyone and go back to the room?')) this.app.backToRoom();
      } }, 'Back to room');
    this.onlineBtn = el('button', { title: 'One player per computer: rooms with seats', onclick: () => { location.search = '?online'; } }, 'Play online');
    this.hostEl = el('div', { class: 'hostnote hidden' }, 'Hosting: this computer runs the game for everyone. Keep this window in front.');
    if (this.online) this.onlineBtn.style.display = 'none';
    if (this.online) {
      mode.style.display = 'none';
      this.pauseBtn.style.display = 'none';   // would freeze everyone
      if (!this.online.spectator) this.layoutSelect.style.display = 'none';
    }
    t.append(
      el('div', { class: 'score' }, this.redVp, el('div', { class: 'mid' }, this.clock, this.phase), this.blueVp),
      el('div', { class: 'row' }, this.startBtn, this.pauseBtn, el('button', { onclick: () => this.app.reset() }, 'Reset'),
        mode, this.layoutSelect, this.cameraSelect, this.robotsBtn, this.backBtn, this.onlineBtn,
        el('button', { onclick: () => this.helpEl.classList.toggle('hidden') }, 'Help (H)')),
      this.goldEl, this.hostEl);
    return t;
  }

  hostNote(on) { this.hostEl.classList.toggle('hidden', !on); }

  toggleSide(show) {
    this.sideEl.classList.toggle('hidden', !show);
    this.sideShowBtn.classList.toggle('hidden', show);
    try { localStorage.setItem('matchSim.sideHidden', show ? '0' : '1'); } catch { /* remembered only where storage works */ }
  }

  toggleCards(show) {
    this.cardsEl.classList.toggle('hidden', show === undefined ? !this.cardsEl.classList.contains('hidden') : !show);
    this.root.classList.toggle('cards-open', !this.cardsEl.classList.contains('hidden'));
  }

  makeCard(key) {
    const sim = this.app.sim(), r = sim.robots[key], c = r.cls;
    // online: who sits there instead of a control choice; only the own robot can be put back
    const sel = this.online ? el('span', { class: 'muted' }, '') : el('select', { onchange: (e) => { this.state.bindings[key] = e.target.value; e.target.blur(); } },
      ...BINDINGS.filter(([v]) => (v !== 'auto' || r.role === 'sentry') && v !== 'any').map(([v, l]) => el('option', { value: v }, l)));
    if (!this.online) sel.value = this.state.bindings[key] ?? 'none';
    const hp = el('div', { class: 'fill hp' }), hpText = el('span', {}, '');
    const back = !this.online || this.online.me === key ? el('button', { class: 'small', title: 'Put this robot back at its start position, upright',
      onclick: (e) => { this.app.putBack(key); e.target.blur(); } }, '↺') : '';
    const card = el('div', { class: `panel card ${r.team}` },
      el('div', { class: 'head' }, el('b', {}, `${c.id} ${robotName(key)}`), el('span', { class: 'tools' }, sel, back)),
      el('div', { class: 'bar' }, hp, hpText));
    const v = { sel, hp, hpText, chips: el('div', { class: 'chips' }), keys: el('div', { class: 'keys' }), info: el('div', { class: 'line note' }) };
    if (c.launcher) {
      v.heat = el('div', { class: 'fill heat' });
      const p = el('input', { type: 'range', min: 0, max: 100, step: 5 });
      p.value = Math.round(sim.hitProbability[key] * 100);
      v.pLabel = el('span', {}, `${p.value}%`);
      p.addEventListener('input', () => { this.app.sim().hitProbability[key] = p.value / 100; v.pLabel.textContent = `${p.value}%`; });
      p.addEventListener('change', () => p.blur());
      card.append(el('div', { class: 'bar small' }, v.heat, el('span', {}, 'heat')), v.info,
        this.online ? '' : el('div', { class: 'line' }, 'hit probability ', p, v.pLabel));
    } else card.append(v.info);
    v.cap = el('div', { class: 'fill cap' });
    v.power = el('span', {}, '');
    card.append(el('div', { class: 'bar small' }, v.cap, v.power), v.keys, v.chips);
    return [card, v];
  }

  cards() {
    const sim = this.app.sim();
    this.cardsEl = el('div', { class: 'cards' });
    this.card = {};
    for (const team of ['red', 'blue']) {
      const keys = sim.keys.filter((k) => k.startsWith(team));
      if (!keys.length) continue;
      const row = el('div', { class: 'cardrow' });
      for (const key of keys) { const [c, v] = this.makeCard(key); this.card[key] = v; row.append(c); }
      this.cardsEl.append(row);
    }
    return this.cardsEl;
  }

  // Split screen: camera choice and the followed robot's status in each view.
  layoutChanged() {
    for (const q of this.quads) q.el.remove();
    for (const c of this.crosses ?? []) c.remove();
    const view = this.app.view();
    this.layoutSelect.value = view.layout;
    this.cameraSelect.style.display = this.flat || view.layout === 'quad' ? 'none' : '';
    // the strips also in one view online: the player's own status has no card there
    const huds = view.layout === 'quad' || (this.online && !this.flat);
    this.quads = !huds ? [] : view.viewports.map((vp, i) => {
      const sel = el('select', { onchange: (e) => { this.app.setCamera(e.target.value, i); e.target.blur(); } },
        ...this.cameraOptions().map(([v, l]) => el('option', { value: v }, l)));
      sel.value = vp.mode;
      const strip = el('div', { class: 'panel strip' });
      const q = { el: el('div', { class: `quadhud${i % 2 ? ' right' : ''}${view.layout === 'quad' ? '' : ' single'}` }, el('div', { class: 'quadcam' }, sel), strip), sel, strip, key: null };
      this.root.append(q.el);
      return q;
    });
    // first person: a crosshair at the middle of the view (where the barrel points when nothing is locked)
    this.crosses = view.viewports.map(() => { const c = el('div', { class: 'crosshair hidden' }); this.root.append(c); return c; });
    this.root.classList.toggle('quadmode', view.layout === 'quad');
    this.toggleCards(view.layout !== 'quad' && !this.online);
    this.placeQuads();
  }

  placeQuads() {
    const vps = this.app.view().viewports;
    (this.crosses ?? []).forEach((c, i) => {
      const [x, y, w, h] = vps[i].rect;
      Object.assign(c.style, { left: `${x + w / 2}px`, top: `${y + h / 2}px` });
    });
    this.quads.forEach((q, i) => {
      const [x, y, w, h] = vps[i].rect;
      Object.assign(q.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    });
  }

  side() {
    const s = el('div', { class: 'panel side' });
    this.sideEl = s;
    this.targetsEl = el('div', {});
    this.padsEl = el('div', { class: 'pads' });
    this.logEl = el('div', { class: 'log' });
    const sim = this.app.sim(), A = sim.sentryAuto;
    const num = (label, get, set, step) => {
      const i = el('input', { type: 'number', step, value: get() });
      i.addEventListener('change', () => set(+i.value));
      return el('label', {}, label, i);
    };
    const check = (label, get, set) => {
      const i = el('input', { type: 'checkbox' });
      i.checked = get();
      i.addEventListener('change', () => set(i.checked));
      return el('label', {}, i, label);
    };
    s.append(el('div', { class: 'sidehead' },
      el('button', { class: 'small', title: 'Hide this panel', onclick: () => this.toggleSide(false) }, 'Hide ▾')));
    this.sideShowBtn = el('button', { class: 'panel sideshow', title: 'Show the panel', onclick: () => this.toggleSide(true) },
      sim.targets.length ? 'Targets · Gamepads · Settings · Events ▴' : 'Gamepads · Settings · Events ▴');
    if (sim.targets.length) s.append(el('h3', {}, 'Targets (Blue)'), this.targetsEl);
    s.append(
      el('details', { open: '' }, el('summary', {}, 'Gamepads'), this.padsEl),
      el('details', {}, el('summary', {}, 'Settings'),
        check(' drive relative to camera', () => this.state.cameraRelative, (v) => { this.state.cameraRelative = v; }),
        check(' show Penalty Zones', () => this.state.showZones, (v) => { this.state.showZones = v; }),
        num('gamepad turn sensitivity ', () => this.app.input().padTurn, (v) => { this.app.input().padTurn = Math.min(1, Math.max(0.1, v)); }, 0.05),
        ...(this.online ? [el('div', { class: 'sub' }, 'Match settings are chosen in the room.')] : this.matchSettings(sim, A, num, check))),
      el('details', { open: '' }, el('summary', {}, 'Events'), this.logEl));
    return s;
  }

  matchSettings(sim, A, num, check) {
    return [
        num('players\' aim cone ± deg (180: all round) ', () => this.app.sim().aimConeDeg, (v) => { this.app.sim().aimConeDeg = Math.min(180, Math.max(0, v)); }, 5),
        num('players\' auto-aim lock range m ', () => this.app.sim().aimLockM, (v) => { this.app.sim().aimLockM = Math.max(0, v); }, 0.5),
        ...['red', 'blue'].filter((t) => sim.keys.includes(`${t}_sentry`)).map((t) =>
          check(` ${teamName(t)} Sentry passes under the Limbo Bars`, () => this.app.sim().sentryLimbo[t], (v) => { this.app.sim().sentryLimbo[t] = v; })),
        num('Sentry Auto lock range m ', () => this.app.sim().sentryLockM, (v) => { this.app.sim().sentryLockM = Math.max(0, v); }, 0.5),
        num('Hero footprint m (0.825 = 1.5× Sentry; Reset applies) ', () => this.app.sim().heroSize, (v) => { this.app.sim().heroSize = Math.min(1.2, Math.max(0.4, v)); }, 0.025),
        el('div', { class: 'sub' }, 'Sentry auto (both sentries)'),
        num('retreat below HP % ', () => A.retreatHp * 100, (v) => { this.app.sim().sentryAuto.retreatHp = v / 100; }, 5),
        num('patrol speed m/s ', () => A.speed, (v) => { this.app.sim().sentryAuto.speed = v; }, 0.1),
        check(' spin while patrolling', () => A.spin, (v) => { this.app.sim().sentryAuto.spin = v; })];
  }

  help() {
    const rows = (k) => [['move', `${keyName(k.up)} ${keyName(k.left)} ${keyName(k.down)} ${keyName(k.right)}`],
      ['turn', `${keyName(k.rotL)} / ${keyName(k.rotR)}`], ['fire (Engineer: grab / let go)', keyName(k.action)],
      ['arm up / down (Engineer)', `${keyName(k.liftUp)} / ${keyName(k.liftDown)}`],
      ['arm out / in (Engineer)', `${keyName(k.reachOut)} / ${keyName(k.reachIn)}`], ['boost (capacitor)', keyName(k.boost)],
      ['buy 42 mm (Hero, in own Resupply Zone)', keyName(k.buy)], ['spin mode on / off', keyName(k.spin)]];
    const table = (title, r) => el('div', {}, el('h4', {}, title),
      el('table', {}, ...r.map(([a, b]) => el('tr', {}, el('td', {}, a), el('td', {}, el('kbd', {}, b))))));
    const pad = [['move', 'left stick'], ['turn (view and chassis)', 'right stick, left / right'], ['fire / grab, let go', 'RT (or A)'],
      ['arm up / down', 'D-pad up / down'], ['arm out / in', 'RB / LB'], ['boost', 'LT'], ['buy 42 mm', 'X'], ['spin on / off', 'Y']];
    this.helpEl = el('div', { class: 'help hidden', onclick: (e) => { if (e.target === this.helpEl) this.helpEl.classList.add('hidden'); } },
      el('div', { class: 'panel helpbox' },
        el('h2', {}, 'ARCC S2 match simulator'),
        el('p', {}, '3v3: Red and Blue, each a Hero, an Engineer and a Sentry. By default the four Heroes and Engineers are on gamepads 1-4 and both Sentries drive themselves; change any control on the robot cards (Robots). "Red vs targets" is the Red alliance alone against three fixed targets.'),
        el('p', {}, 'While fire is held, auto-aim locks on to the nearest enemy in sight within 3 m and ±60° of where the view faces; farther away you aim by hand with the view (a Sentry on Auto locks on all round within 3 m and fires by itself); the hit probability is set on each card. The view turns with the right stick (or the turn keys) and the chassis follows it; in spin mode the chassis spins under a steady view. The Hero starts with no 42 mm ammo: after "Start battle" each alliance gets Gold, and the Hero buys rounds in its own Resupply Zone (10 Gold each).'),
        el('p', {}, 'Gamepads: connect them, then press any button on each while this page is open (browsers only show a pad after that). The Gamepads list on the right shows each pad, what it is bound to, and the buttons it reports, so you can check them.'),
        el('div', { class: 'cols' }, table(KEYSETS.wasd.label, rows(KEYSETS.wasd)), table(KEYSETS.arrows.label, rows(KEYSETS.arrows)), table('Gamepad (Xbox layout)', pad)),
        el('p', {}, 'Global: V camera (one view), H help, P pause, U hide / show the panels. 4 views: each view has its own camera at its top left; a robot is driven relative to the view that follows it. Mouse: orbit / zoom in Overview and Top. Without WebGL (or with ?2d in the address) the view is top-down 2D.'),
        el('h4', {}, 'Simplifications'),
        el('ul', {}, ...[
          'Engineer: an object within 0.22 m of the green grab point attaches to it (no gripper physics). A pipe is turned in when let go with the grab point at a Pipe Chute.',
          'Shots are not simulated as projectiles: each shot hits with the set probability; objectives do not block shots. Invincible robots are not aimed at. A player\'s auto-aim only locks on within 3 m and ±60° of the view; farther away the barrel points where the view points (faint line, green when on an enemy) and a shot can hit only an enemy the barrel is on. A Sentry on Auto locks on all round, also within 3 m. All of this is in Settings.',
          'Robot sizes, masses and drive numbers are guesses (src/params.js); wheels are frictionless contact spheres, traction comes from the drive model and only from wheels that touch something.',
          'A held objective passes through everything; when let go it is put down just above whatever the grab point is in (no room within 0.3 m: it stays held).',
          'The zig-zag pole is a straight pole until its shape is published. Bumpy Road tiles are visual only.',
        ].map((t) => el('li', {}, t)))));
    return this.helpEl;
  }

  // Status of one robot for its card and the split-screen strip.
  status(sim, r) {
    let info = '';
    if (r.cls.launcher) {
      info = `ammo ${r.ammo}${r.role === 'hero' ? ` (Gold ${sim.gold[r.team]})` : ''}${r.fireNote ? ` · ${r.fireNote}` : ''}`;
      if (r.role === 'hero' && r.ammo <= 0) {
        const b = this.state.bindings[r.key], k = KEYSETS[b], buy = b === 'any' ? 'B (gamepad X)' : k ? keyName(k.buy) : 'X';
        info = sim.phase === 'ready' ? `no ammo: Start battle for Gold, then ${buy} in the Resupply Zone`
          : `no ammo: ${buy} in the own Resupply Zone (${RULES.goldPer42} Gold a round, Gold ${sim.gold[r.team]})`;
      }
      if (r.autoOn) info += ` · auto: ${r.auto.state}${r.auto.stopped ? ' (stopped, robot ahead)' : ''}`;
    } else if (r.role === 'engineer') {
      info = `arm ${r.lift.toFixed(2)} m up, ${r.reach.toFixed(2)} m out${r.held ? ` · holding ${r.held.type === 'pipe' ? `${r.held.color} pipe` : r.held.type}` : ''}`;
    }
    const chips = [];
    if (!r.alive) chips.push(['bad', `DEFEATED · respawn ${Math.max(0, r.respawnAt - sim.t).toFixed(1)} s`]);
    if (r.alive && r.weakened) chips.push(['warn', 'WEAKENED: go to Resupply']);
    if (r.alive && sim.t < r.invincibleUntil) chips.push(['info', 'invincible']);
    if (sim.t < r.chassisOffUntil) chips.push(['bad', `chassis off ${(r.chassisOffUntil - sim.t).toFixed(1)} s`]);
    if (sim.t < r.blockedUntil && !r.autoOn) chips.push(['bad', `controls blocked ${(r.blockedUntil - sim.t).toFixed(1)} s`]);
    if (r.heatLocked) chips.push(['warn', 'launcher cooling']);
    if (r.lockedForGame) chips.push(['bad', 'launcher locked']);
    if (r.spin) chips.push(['info', 'spin']);
    if (r.alive && r.offGround > 0.5) chips.push(['warn', 'wheels off the ground (↺ puts it back)']);
    if (sim.t - r.releaseBlockedAt < 1.5) chips.push(['bad', 'no room to put it down here']);
    for (const [name, z] of Object.entries(r.zones)) if (z.t > 0) chips.push(['warn', `${name} ${z.t.toFixed(1)} s`]);
    return { info, chips: chips.map(([k, t]) => el('span', { class: `chip ${k}` }, t)) };
  }

  stripNodes(sim, r) {
    const st = this.status(sim, r);
    const hp = el('div', { class: 'bar' }, el('div', { class: 'fill hp', style: `width:${(100 * r.hp) / r.cls.maxHp}%` }),
      el('span', {}, `${Math.round(r.hp)} / ${r.cls.maxHp}`));
    const nodes = [el('div', { class: 'head' }, el('b', { class: r.team }, `${r.cls.id} ${robotName(r.key)}`),
      el('span', { class: 'muted' }, this.online ? this.app.seatName(r.key) : bindingName(this.state.bindings[r.key] ?? 'none'))), hp];
    if (r.cls.launcher) nodes.push(el('div', { class: 'bar small' }, el('div', { class: 'fill heat', style: `width:${Math.min(100, (100 * r.heat) / r.cls.heatMax)}%` }), el('span', {}, 'heat')));
    nodes.push(el('div', { class: 'bar small' }, el('div', { class: 'fill cap', style: `width:${(100 * r.cap) / DRIVE.capJ}%` }), el('span', {}, capText(r))));
    nodes.push(el('div', { class: 'line note' }, st.info), el('div', { class: 'chips' }, ...st.chips));
    return nodes;
  }

  pads(sim) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    if (!pads.length) return [el('div', { class: 'muted' }, 'none yet: connect one and press any of its buttons')];
    return pads.map((p, i) => {
      const users = sim.keys.filter((k) => this.state.bindings[k] === `pad${i}`).map(robotName);
      const pressed = p.buttons.map((b, j) => (b.pressed ? j : null)).filter((j) => j !== null);
      const axes = p.axes.slice(0, 4).map((a) => a.toFixed(1)).join(' ');
      return el('div', { class: 'pad' },
        el('b', {}, `Gamepad ${i + 1}`), ` → ${users.join(', ') || 'not used'}`,
        el('div', { class: 'muted' }, `${p.id.slice(0, 48)}${p.mapping === 'standard' ? '' : ' · NOT standard layout: buttons may differ'}`),
        el('div', { class: 'muted' }, `buttons ${pressed.join(' ') || '-'} · sticks ${axes}`));
    });
  }

  update(sim, paused) {
    const now = performance.now();
    if (now - this.lastDraw < 100) return;
    this.lastDraw = now;
    this.redVp.textContent = Math.floor(sim.vp.red);
    this.blueVp.textContent = Math.floor(sim.vp.blue);
    this.clock.textContent = fmt(sim.remaining());
    this.phase.textContent = paused ? 'paused' : sim.phase === 'ready' ? 'free driving' :
      sim.phase === 'running' ? 'battle' : `over: ${sim.result === 'draw' ? 'draw' : `${sim.result} wins`}`;
    this.startBtn.disabled = sim.phase !== 'ready';
    this.backBtn.classList.toggle('hidden', !this.online);
    this.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    this.goldEl.textContent = sim.mode === 'targets' ? `Red Gold ${sim.gold.red}  ·  first to ${RULES.vpToWin} VP`
      : `Gold: Red ${sim.gold.red} · Blue ${sim.gold.blue}  ·  first to ${RULES.vpToWin} VP`;
    if (this.cameraSelect.value !== this.app.view().mode) this.cameraSelect.value = this.app.view().mode;
    for (const key of sim.keys) {
      const r = sim.robots[key], v = this.card[key];
      v.hp.style.width = `${(100 * r.hp) / r.cls.maxHp}%`;
      v.hpText.textContent = `${Math.round(r.hp)} / ${r.cls.maxHp}`;
      if (v.heat) v.heat.style.width = `${Math.min(100, (100 * r.heat) / r.cls.heatMax)}%`;
      const st = this.status(sim, r);
      if (v.info.textContent !== st.info) v.info.textContent = st.info;
      if (v.keysFor !== this.state.bindings[key]) {
        v.keysFor = this.state.bindings[key];
        v.keys.replaceChildren(...hintNodes(keyHint(r.role, v.keysFor)));
      }
      if (this.online) { const n = this.app.seatName(key); if (v.sel.textContent !== n) v.sel.textContent = n; }
      else if (v.sel.value !== this.state.bindings[key]) v.sel.value = this.state.bindings[key];
      v.cap.style.width = `${(100 * r.cap) / DRIVE.capJ}%`;
      v.power.textContent = capText(r);
      v.chips.replaceChildren(...st.chips);
    }
    const vps = this.app.view().viewports;
    this.quads.forEach((q, i) => {
      const mode = vps[i].mode, key = viewKey(mode);
      if (q.sel.value !== mode) q.sel.value = mode;
      q.strip.style.display = key ? '' : 'none';
      if (key) q.strip.replaceChildren(...this.stripNodes(sim, sim.robots[key]));
    });
    (this.crosses ?? []).forEach((c, i) => c.classList.toggle('hidden', !vps[i]?.mode.startsWith('fpv:')));
    this.targetsEl.replaceChildren(...sim.targets.map((t) => el('div', { class: 'line' },
      `${t.name}: ${t.alive ? `${t.hp} / ${t.maxHp}` : `down, back in ${Math.max(0, t.respawnAt - sim.t).toFixed(0)} s`}`)));
    this.padsEl.replaceChildren(...this.pads(sim));
    this.logEl.replaceChildren(...sim.events.slice(-10).reverse().map((e) => el('div', { class: e.kind }, `${fmt(RULES.battleSeconds - e.t)}  ${e.text}`)));
    this.popEvents(sim, now);
  }

  // With the panel hidden, new events show for 3 s next to its button, then fade out.
  popEvents(sim, now) {
    const fresh = sim.events.filter((e) => e.seq > this.lastToastSeq);
    this.lastToastSeq = sim.eventSeq;
    if (!this.sideEl.classList.contains('hidden')) fresh.length = 0;
    for (const e of fresh) {
      const t = el('div', { class: `panel toast ${e.kind}` }, `${fmt(RULES.battleSeconds - e.t)}  ${e.text}`);
      this.toastsEl.append(t);
      this.toasts.push({ el: t, until: now + 3000 });
    }
    while (this.toasts.length > 4) this.toasts.shift().el.remove();
    this.toasts = this.toasts.filter((t) => {
      if (now > t.until) { t.el.remove(); return false; }
      if (now > t.until - 500) t.el.classList.add('fade');
      return true;
    });
  }
}
