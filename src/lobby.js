// Online room screen: create or join a room, pick a seat, ready up, shared settings. Once every
// seated player is ready the room counts down 3 s and sends 'game'; main.js then runs the game
// until the room calls everyone back ('lobby'). The connection stays open across both.
import { RoomConnection, newCode } from './net_client.js';
import { roomServer } from './net_config.js';
import { ROBOTS } from './params.js';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined) e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
};
const TEAMS = { red: ['red_hero', 'red_engineer', 'red_sentry'], blue: ['blue_hero', 'blue_engineer', 'blue_sentry'] };
const SPECS = ['spec1', 'spec2', 'spec3', 'spec4'];
const seatLabel = (s) => { const [, role] = s.split('_'); return `${ROBOTS[role].id} ${ROBOTS[role].name}`; };
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* fine */ } } };

export class Lobby {
  // defaults: the settings as a fresh Sim has them (see online.js SETTING_DEFAULTS)
  constructor(root, { defaults, onGame, onLobby, onRoom }) {
    Object.assign(this, { root, defaults, onGame, onLobby, onRoom });
    this.conn = null;
    this.room = null;
    this.gameHandler = null;   // set by main.js while a game runs
    this.countdownEnd = 0;
    setInterval(() => this.tickCountdown(), 100);
    const q = new URLSearchParams(location.search), code = q.get('room');   // ?room=CODE (&create: make it)
    if (code) this.join(code.toUpperCase(), q.has('create')); else this.startScreen();
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  async server() {
    this.serverUrl ??= await roomServer();
    return this.serverUrl;
  }

  startScreen(message = '') {
    this.show();
    const name = el('input', { type: 'text', maxlength: 24, value: store.get('matchSim.name', ''), placeholder: 'your name' });
    const code = el('input', { type: 'text', maxlength: 6, placeholder: 'ABC234', class: 'code' });
    const go = (create) => {
      store.set('matchSim.name', name.value.trim());
      if (create) this.join(newCode(), true);
      else if (code.value.trim().length === 6) this.join(code.value.trim().toUpperCase(), false);
    };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(false); });
    this.root.replaceChildren(el('div', { class: 'panel lobbybox' },
      el('h2', {}, 'ARCC match simulator · online'),
      el('p', { class: 'muted' }, 'Everyone opens this page on their own computer, one person creates a room, the others join it with its code. The room creator\'s computer runs the simulation: keep that window in front during the game.'),
      el('label', {}, 'Name ', name),
      el('div', { class: 'row left' }, el('button', { onclick: () => go(true) }, 'Create a room')),
      el('div', { class: 'row left' }, el('span', {}, 'or join a room: '), code, el('button', { onclick: () => go(false) }, 'Join')),
      el('p', { class: 'bad' }, message),
      el('p', { class: 'muted' }, el('a', { href: location.pathname }, 'Back to playing on this computer only'))));
  }

  async join(code, create) {
    const server = await this.server();
    if (!server) { this.startScreen('No room server is set up yet (src/net_config.js CLOUD_SERVER).'); return; }
    const name = store.get('matchSim.name', '') || '';
    this.conn?.close();
    this.room = null;
    this.code = code;
    const conn = new RoomConnection(server, code, { name, create });
    this.conn = conn;
    this.status = 'connecting';
    this.render();
    conn.onstatus = (st) => { this.status = st; if (st === 'closed' && !this.refused) this.render(); };
    conn.onmessage = (msg) => this.message(msg);
    const q = new URLSearchParams(location.search);
    q.set('room', code);
    q.delete('online');
    history.replaceState(null, '', `?${q}`);
  }

  leave() {
    this.conn?.close();
    this.conn = null;
    this.room = null;
    const q = new URLSearchParams(location.search);
    q.delete('room');
    q.set('online', '');
    history.replaceState(null, '', `?${q}`.replace('online=', 'online'));
    this.startScreen();
  }

  message(msg) {
    if (msg.t === 'error') { this.refused = true; this.leaveWith(msg.message); return; }
    if (msg.t === 'room') {
      this.room = msg;
      if (msg.phase === 'countdown') this.countdownEnd = performance.now() + msg.countdownMs;
      this.onRoom?.(msg);
      if (!this.inGame) this.render();
    }
    if (msg.t === 'game') { this.inGame = true; this.hide(); this.onGame(msg, this.conn, this.me()); }
    if (msg.t === 'lobby') { this.inGame = false; this.onLobby(msg.reason); this.show(); this.notice = msg.reason; this.render(); }
    this.gameHandler?.(msg);
  }

  leaveWith(message) {
    this.conn?.close();
    this.conn = null;
    const q = new URLSearchParams(location.search);
    q.delete('room');
    history.replaceState(null, '', `?${q}`);
    this.startScreen(message);
  }

  me() { return this.room?.members.find((m) => m.id === this.conn?.you) ?? null; }

  tickCountdown() {
    if (!this.countdownEl) return;
    const left = this.room?.phase === 'countdown' ? Math.max(0, this.countdownEnd - performance.now()) : 0;
    this.countdownEl.textContent = left > 0 ? `Starting in ${Math.ceil(left / 1000)}…` : '';
  }

  render() {
    if (this.inGame) return;
    this.show();
    const r = this.room, me = this.me();
    if (!r) {
      this.root.replaceChildren(el('div', { class: 'panel lobbybox' }, el('h2', {}, `Room ${this.code}`),
        el('p', { class: 'muted' }, this.status === 'closed' ? 'Could not reach the room server.' : 'Connecting…'),
        el('button', { onclick: () => this.leave() }, 'Back')));
      return;
    }
    const send = (obj) => this.conn?.send(obj);
    const by = (seat) => r.members.find((m) => m.seat === seat);
    const seatBtn = (seat, label) => {
      const m = by(seat), mine = m && me && m.id === me.id;
      const auto = seat.endsWith('sentry') && r.settings?.autoSentry?.[seat.split('_')[0]] !== false;
      const who = m ? `${m.name}${m.id === r.host ? ' · host' : ''}${m.online ? '' : ' · offline'}` : auto ? 'empty: drives itself' : 'empty';
      const canSit = !m && me && (r.phase !== 'game' ? true : SPECS.includes(seat) && !me.seat);
      return el('button', { class: `seat${mine ? ' mine' : ''}${m ? ' taken' : ''}`, disabled: !canSit && !mine ? '' : false,
        onclick: () => { if (canSit) send({ t: 'sit', seat }); } },
        el('b', {}, label), el('span', {}, who), m && SPECS.includes(seat) === false ? el('span', { class: m.ready ? 'ok' : 'muted' }, m.ready ? 'ready' : 'not ready') : '');
    };
    const team = (t) => el('div', { class: `seatcol ${t}` }, el('h3', {}, t === 'red' ? 'Red' : 'Blue'), ...TEAMS[t].map((s) => seatBtn(s, seatLabel(s))));
    const link = `${location.origin}${location.pathname}?room=${r.code}${new URLSearchParams(location.search).get('server') ? `&server=${encodeURIComponent(new URLSearchParams(location.search).get('server'))}` : ''}`;
    const isPlayer = me && !!me.seat && !SPECS.includes(me.seat);
    this.countdownEl = el('div', { class: 'countdown' });
    const unseated = r.members.filter((m) => !m.seat);
    this.root.replaceChildren(el('div', { class: 'panel lobbybox wide' },
      el('div', { class: 'roomhead' }, el('h2', {}, 'Room ', el('span', { class: 'code' }, r.code)),
        el('button', { onclick: () => navigator.clipboard?.writeText(link) }, 'Copy invite link'), el('span', { class: 'muted' }, link)),
      r.phase === 'game' ? el('p', { class: 'warn' }, 'A game is running. Take a free spectator seat to watch.') : '',
      this.notice ? el('p', { class: 'muted' }, `Back in the room: ${this.notice}`) : '',
      el('div', { class: 'seats' }, team('red'), team('blue')),
      el('div', { class: 'seatcol spec' }, el('h3', {}, 'Spectators (any view)'), el('div', { class: 'specrow' }, ...SPECS.map((s, i) => seatBtn(s, `Seat ${i + 1}`)))),
      unseated.length ? el('p', { class: 'muted' }, `Not seated: ${unseated.map((m) => m.name).join(', ')}`) : '',
      el('div', { class: 'row left' },
        isPlayer ? el('button', { class: me.ready ? 'on' : 'primary', onclick: () => send({ t: 'ready', on: !me.ready }) }, me.ready ? 'Not ready' : 'Ready') : '',
        me?.seat && r.phase !== 'game' ? el('button', { onclick: () => send({ t: 'stand' }) }, 'Stand up') : '',
        el('button', { onclick: () => this.leave() }, 'Leave room'), this.countdownEl),
      el('p', { class: 'muted' }, 'The game starts 3 s after every seated player is ready. Empty Sentry seats drive themselves (unless turned off in Settings); an empty Hero or Engineer seat stays in its Resupply Zone. In the game, a player can watch the whole field or their own robot; spectators any view. Controls: keyboard (WASD or arrows) or a gamepad.'),
      el('p', { class: 'muted' }, `Host (runs the simulation): ${r.members.find((m) => m.id === r.host)?.name ?? '-'}${me?.id === r.host ? ' — that is you: keep this window in front during the game' : ''}`),
      this.settingsForm(r.settings, send)));
    this.tickCountdown();
  }

  settingsForm(current, send) {
    const s = { ...this.defaults, ...current, hp: { ...this.defaults.hp, ...current.hp }, limbo: { ...this.defaults.limbo, ...current.limbo },
      autoSentry: { ...this.defaults.autoSentry, ...current.autoSentry } };
    const locked = this.room?.phase === 'game';
    const num = (label, value, step, set) => {
      const i = el('input', { type: 'number', step, value, disabled: locked ? '' : false });
      i.addEventListener('change', () => send({ t: 'settings', settings: set(+i.value) }));
      return el('label', {}, label, i);
    };
    const check = (label, value, set) => {
      const i = el('input', { type: 'checkbox', disabled: locked ? '' : false });
      i.checked = !!value;
      i.addEventListener('change', () => send({ t: 'settings', settings: set(i.checked) }));
      return el('label', {}, i, label);
    };
    const box = el('details', { class: 'roomsettings', open: this.settingsOpen ? '' : false },
      el('summary', {}, 'Settings (anyone can change them before the game)'));
    box.addEventListener('toggle', () => { this.settingsOpen = box.open; });
    box.append(
      el('div', { class: 'cols2' },
        el('div', {}, el('h4', {}, 'Hit probability %'),
          ...Object.keys(s.hp).map((k) => num(`${k.replace('_', ' ')} `, Math.round(s.hp[k] * 100), 5, (v) => ({ hp: { ...s.hp, [k]: v / 100 } })))),
        el('div', {}, el('h4', {}, 'Aiming'),
          num('players\' auto-aim lock range m ', s.aimLockM, 0.5, (v) => ({ aimLockM: v })),
          num('players\' aim cone ± deg (180: all round) ', s.aimConeDeg, 5, (v) => ({ aimConeDeg: v })),
          num('Sentry Auto lock range m ', s.sentryLockM, 0.5, (v) => ({ sentryLockM: v }))),
        el('div', {}, el('h4', {}, 'Sentries'),
          check(' Red Sentry drives itself when its seat is empty', s.autoSentry.red, (v) => ({ autoSentry: { ...s.autoSentry, red: v } })),
          check(' Blue Sentry drives itself when its seat is empty', s.autoSentry.blue, (v) => ({ autoSentry: { ...s.autoSentry, blue: v } })),
          check(' Red Sentry passes under the Limbo Bars', s.limbo.red, (v) => ({ limbo: { ...s.limbo, red: v } })),
          check(' Blue Sentry passes under the Limbo Bars', s.limbo.blue, (v) => ({ limbo: { ...s.limbo, blue: v } })),
          num('Auto: retreat below HP % ', s.retreatPct, 5, (v) => ({ retreatPct: v })),
          num('Auto: patrol speed m/s ', s.patrolSpeed, 0.1, (v) => ({ patrolSpeed: v })),
          check(' Auto: spin while patrolling', s.spin, (v) => ({ spin: v })))));
    return box;
  }
}
