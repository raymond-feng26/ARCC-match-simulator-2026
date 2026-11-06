import RAPIER from '@dimforge/rapier3d-compat';
import { Sim, ZERO_CMD } from './sim.js';
import { PHYSICS } from './params.js';
import { View } from './render.js';
import { View2D } from './render2d.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { runTests } from './tests.js';
import { Lobby } from './lobby.js';
import { HostSession, ClientSession, applySettings, SETTING_DEFAULTS } from './online.js';

// Address options: ?mode=targets (Red vs fixed targets; default 3v3), ?layout=single|quad, ?2d.
// ?online (or ?room=CODE): online, one player per computer (lobby.js, online.js); ?server=wss://...
const params = new URLSearchParams(location.search);
await RAPIER.init();
const input = new Input();
const viewEl = document.getElementById('view'), uiEl = document.getElementById('ui');
// Split screen: one view per player. 3v3: Red on the left, Blue on the right, Heroes on top.
const QUAD_MODES = {
  '3v3': ['follow:red_hero', 'follow:blue_hero', 'follow:red_engineer', 'follow:blue_engineer'],
  targets: ['follow:red_hero', 'follow:red_engineer', 'follow:red_sentry', 'overview'],
};

// 3D needs WebGL; without it (or with ?2d) use the top-down 2D view.
function makeView() {
  const want2d = params.has('2d');
  try {
    if (want2d) throw new Error('2D view requested');
    return new View(viewEl);
  } catch (e) {
    viewEl.replaceChildren();
    if (!want2d) console.warn('WebGL not available, using the 2D view:', e.message);
    return new View2D(viewEl);
  }
}

const noEdges = (cmds) => Object.fromEntries(Object.entries(cmds).map(([k, c]) =>
  [k, { ...c, actionEdge: false, buyEdge: false, spinEdge: false }]));

// One game on this page. Local: every robot is driven here, with the bindings on the cards.
// net (online): { conn, game, role: 'host' | 'client', me: own seat or null, seats() }. The host steps
// the Sim and sends snapshots; a client only poses its Sim from them and sends its own controls.
function runGame(sim, { layout = null, net = null } = {}) {
  const view = makeView();
  const me = net?.me ?? null, spectator = !!net && !me;
  const host = net?.role === 'host' ? new HostSession(sim, net.conn, net.game) : null;
  const client = net?.role === 'client' ? new ClientSession(sim, net.conn, net.game) : null;
  if (net) layout = spectator ? 'quad' : 'single';
  else layout ??= sim.mode === '3v3' ? 'quad' : 'single';
  if (layout === 'quad') view.setLayout('quad', QUAD_MODES[sim.mode]);
  else if (me) view.setMode(`follow:${me}`);
  view.attach(sim);
  let paused = false, stopped = false;
  const CAMERAS = () => (net && !spectator ? ['overview', 'top', `follow:${me}`] : ['overview', 'top', ...sim.keys.map((k) => `follow:${k}`)]);

  const app = {
    sim: () => sim,
    view: () => view,
    input: () => input,
    start: () => (client ? net.conn.send({ t: 'action', what: 'start' }) : sim.start()),
    togglePause: () => { if (!net) paused = !paused; },
    reset: () => {
      if (client) { net.conn.send({ t: 'action', what: 'reset' }); return; }
      sim.reset();
      view.attach(sim);
      paused = false;
    },
    putBack: (key) => (client ? net.conn.send({ t: 'action', what: 'putBack', key }) : sim.putBack(key)),
    setCamera: (m, i = 0) => view.setMode(m, i),
    setLayout: (l) => {
      view.setLayout(l, l === 'quad' ? QUAD_MODES[sim.mode] : [view.mode]);
      ui.layoutChanged();
      if (net) return;
      params.set('layout', l);
      history.replaceState(null, '', `?${params}`);
    },
    setMatchMode: (m) => { params.set('mode', m); params.delete('layout'); location.search = `?${params}`; },
    seatName: (key) => {
      const s = net?.seats()[key];
      const auto = key.endsWith('sentry') && net?.game.settings?.autoSentry?.[key.split('_')[0]] !== false;
      return s ? `${s.name}${s.online ? '' : ' (offline)'}` : auto ? 'Auto' : 'empty';
    },
    backToRoom: () => net?.conn.send({ t: 'back' }),
  };
  const ui = new UI(uiEl, app, { flat: view instanceof View2D, online: net ? { me, spectator } : null });
  if (host) ui.hostNote(true);
  const onKey = (e) => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.code === 'KeyV' && view.layout === 'single') { const c = CAMERAS(); app.setCamera(c[(c.indexOf(view.mode) + 1) % c.length]); }
    if (e.code === 'KeyH') ui.helpEl.classList.toggle('hidden');
    if (e.code === 'KeyP') app.togglePause();
    if (e.code === 'KeyU') uiEl.classList.toggle('hide-panels');
  };
  window.addEventListener('keydown', onKey);

  // Screen-frame command -> field frame: relative to the view that follows the robot (or the first
  // view), or to the robot's own view heading.
  const toField = (key, c) => {
    let f, r;
    if (ui.state.cameraRelative) ({ f, r } = view.axesFor(key));
    else { const y = sim.robots[key].viewYaw; f = [Math.cos(y), Math.sin(y)]; r = [f[1], -f[0]]; }
    return { ...c, mx: c.mx * r[0] + c.my * f[0], my: c.mx * r[1] + c.my * f[1] };
  };
  function localCommands() {
    const out = {};
    for (const key of sim.keys) {
      const b = ui.state.bindings[key];
      if (b === 'auto') { out[key] = { ...ZERO_CMD, auto: true }; continue; }
      const c = input.read(b);
      out[key] = c ? toField(key, c) : ZERO_CMD;
    }
    return out;
  }
  const myCommand = () => { if (!me) return null; const c = input.read('any'); return c ? toField(me, c) : ZERO_CMD; };

  const hostActions = (msg) => {
    if (msg.what === 'start') sim.start();
    else if (msg.what === 'reset') app.reset();
    else if (msg.what === 'putBack' && sim.robots[msg.key]) sim.putBack(msg.key);
  };
  if (client) client.onReset = () => { sim.reset(); view.attach(sim); };

  let last = performance.now(), acc = 0;
  function frame(now) {
    if (stopped) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (client) {
      client.pose();
      client.sendInput(myCommand(), now);
    } else {
      const cmds = host ? host.commands(myCommand()) : localCommands();
      if (!paused) {
        acc += dt;
        let n = 0, c = cmds;
        while (acc >= PHYSICS.dt && n < 12) {
          sim.step(c);
          c = noEdges(cmds);
          acc -= PHYSICS.dt;
          n += 1;
        }
        if (n >= 12) acc = 0;
      }
      host?.afterFrame(now);
    }
    view.update(sim, ui.state);
    ui.update(sim, paused);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    sim, view, ui, app, host, client,
    onNet: (msg) => (host ? host.onMessage(msg, hostActions) : client?.onMessage(msg)),
    stop() {
      stopped = true;
      window.removeEventListener('keydown', onKey);
      viewEl.replaceChildren();
      uiEl.replaceChildren();
      uiEl.className = '';
      sim.world.free();
    },
  };
}

// Online: the room screen, then games started by the room.
function startOnline() {
  const lobbyEl = document.getElementById('lobby');
  let game = null, seats = {};
  const probe = new Sim(RAPIER, { mode: '3v3' });
  const defaults = SETTING_DEFAULTS(probe);
  probe.world.free();
  const lobby = new Lobby(lobbyEl, {
    defaults,
    onRoom: (room) => {
      seats = {};
      for (const m of room.members) if (m.seat) seats[m.seat] = { id: m.id, name: m.name, online: m.online };
    },
    onGame: (msg, conn) => {
      game?.stop();
      const sim = new Sim(RAPIER, { mode: '3v3' });
      applySettings(sim, msg.settings);
      const mine = Object.entries(msg.seats).find(([, s]) => s.id === conn.you)?.[0] ?? null;
      const me = mine && !mine.startsWith('spec') ? mine : null;
      game = runGame(sim, { net: { conn, game: { ...msg, mySeat: me }, role: msg.host === conn.you ? 'host' : 'client', me, seats: () => seats } });
      lobby.gameHandler = (m) => game?.onNet(m);
      window.matchSim.game = game;
    },
    onLobby: () => { game?.stop(); game = null; lobby.gameHandler = null; window.matchSim.game = null; },
  });
  window.matchSim = { lobby, RAPIER, runTests: () => runTests(RAPIER) };
}

if (params.has('online') || params.has('room')) startOnline();
else {
  const game = runGame(new Sim(RAPIER, { mode: params.get('mode') ?? '3v3' }), { layout: params.get('layout') });
  // For the console / automated checks: matchSim.runTests() runs headless scenarios.
  window.matchSim = { sim: game.sim, view: game.view, ui: game.ui, app: game.app, RAPIER, runTests: () => runTests(RAPIER) };
}
document.getElementById('loading')?.remove();
if (params.has('test')) {
  runTests(RAPIER).then((r) => { window.matchSim.testResults = r; console.log(JSON.stringify(r, null, 1)); });
}
