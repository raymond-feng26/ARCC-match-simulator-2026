// Room logic, shared by the local server (local_server.mjs) and the Cloudflare Worker
// (cloudflare/worker.js): who is in a room, seats, ready / countdown, and relaying game messages
// between the host (the room creator's browser, which runs the simulation) and everyone else.
// No platform APIs here: a connection is anything with send(string) and close().
//
// Client -> room:  hello {name, token, create}   sit {seat}   stand   ready {on}   name {name}
//                  settings {settings}            in {c}       action {what, key}   back
// Host  -> room:   state {...}   over
// Room  -> client: welcome {you, token, code}   room {...}   game {seats, settings, host, gameId}
//                  in {seat, c} (to the host)   action {...} (to the host)   state (to the others)
//                  lobby {reason}   error {message}

export const PLAYER_SEATS = ['red_hero', 'red_engineer', 'red_sentry', 'blue_hero', 'blue_engineer', 'blue_sentry'];
export const SPECTATOR_SEATS = ['spec1', 'spec2', 'spec3', 'spec4'];
export const MAX_MEMBERS = 12;          // 10 seats and a couple still choosing
const COUNTDOWN_MS = 3000;
const KEEP_GONE_MS = 120000;            // a member who dropped keeps the seat this long (reconnect)

const randomToken = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');

export class Room {
  // timers: { now(), later(fn, ms) -> handle, cancel(handle) }
  constructor(code, timers) {
    this.code = code;
    this.timers = timers;
    this.members = new Map();   // id -> { id, token, name, seat, ready, conn, goneAt }
    this.nextId = 1;
    this.hostId = null;
    this.phase = 'lobby';       // lobby | countdown | game
    this.countdownEnd = 0;
    this.countdownTimer = null;
    this.gameId = 0;
    this.settings = {};
    this.created = false;
  }

  empty() { return ![...this.members.values()].some((m) => m.conn); }

  // A new connection. Returns the member, or null (refused; the connection is closed).
  join(conn, { name, token, create }) {
    let m = token ? [...this.members.values()].find((x) => x.token === token) : null;
    if (!m && !this.created && !create) return this.refuse(conn, `no room ${this.code} (the code may be wrong, or the room has closed)`);
    if (!m && [...this.members.values()].filter((x) => x.conn || x.seat).length >= MAX_MEMBERS) return this.refuse(conn, 'the room is full');
    this.created = true;
    if (m) {
      if (m.conn && m.conn !== conn) { try { m.conn.close(); } catch { /* gone already */ } }
      m.conn = conn;
      m.goneAt = 0;
    } else {
      m = { id: this.nextId++, token: randomToken(), name: '', seat: null, ready: false, conn, goneAt: 0 };
      this.members.set(m.id, m);
    }
    m.name = String(name || m.name || `Player ${m.id}`).slice(0, 24);
    if (!this.hostId || !this.members.get(this.hostId)?.conn) this.hostId = m.id;
    this.send(m, { t: 'welcome', you: m.id, token: m.token, code: this.code });
    if (this.phase === 'game' && this.inGame(m)) this.send(m, this.gameMessage());
    this.broadcastRoom();
    return m;
  }

  refuse(conn, message) {
    try { conn.send(JSON.stringify({ t: 'error', message })); conn.close(); } catch { /* gone already */ }
    return null;
  }

  // A connection closed (an old one replaced by a reconnect does not count).
  leave(m, conn) {
    if (!m || !m.conn || m.conn !== conn) return;
    m.conn = null;
    m.goneAt = this.timers.now();
    m.ready = false;
    if (this.phase === 'countdown') this.stopCountdown();
    if (m.id === this.hostId) {
      const next = [...this.members.values()].find((x) => x.conn);
      this.hostId = next ? next.id : null;
      if (this.phase === 'game') this.toLobby('the host left; the simulation ran on their computer');
    }
    if (!m.seat || this.phase !== 'game') this.members.delete(m.id);   // a player in a game keeps the seat for a while
    this.timers.later(() => this.forgetGone(), KEEP_GONE_MS + 1000);
    this.broadcastRoom();
  }

  forgetGone() {
    const now = this.timers.now();
    for (const m of [...this.members.values()]) if (!m.conn && now - m.goneAt > KEEP_GONE_MS) this.members.delete(m.id);
    this.broadcastRoom();
  }

  message(m, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const host = this.members.get(this.hostId);
    switch (msg.t) {
      case 'sit': {
        const seat = String(msg.seat);
        if (![...PLAYER_SEATS, ...SPECTATOR_SEATS].includes(seat)) return;
        if ([...this.members.values()].some((x) => x !== m && x.seat === seat)) return;   // taken
        if (this.phase === 'game' && (!SPECTATOR_SEATS.includes(seat) || m.seat)) return;   // in a game: only an empty spectator seat
        m.seat = seat;
        m.ready = false;
        if (this.phase === 'countdown') this.stopCountdown();
        if (this.phase === 'game') this.send(m, this.gameMessage());
        this.broadcastRoom();
        return;
      }
      case 'stand':
        if (this.phase === 'game') return;
        m.seat = null; m.ready = false;
        if (this.phase === 'countdown') this.stopCountdown();
        this.broadcastRoom();
        return;
      case 'ready':
        if (this.phase === 'game' || !PLAYER_SEATS.includes(m.seat)) return;
        m.ready = !!msg.on;
        if (this.phase === 'countdown' && !m.ready) this.stopCountdown();
        this.maybeCountdown();
        this.broadcastRoom();
        return;
      case 'name':
        m.name = String(msg.name || m.name).slice(0, 24);
        this.broadcastRoom();
        return;
      case 'settings':   // anyone, any time before a game (applied when it starts)
        if (this.phase === 'game' || typeof msg.settings !== 'object') return;
        this.settings = { ...this.settings, ...msg.settings };
        this.broadcastRoom();
        return;
      case 'in':         // a player's controls -> the host
        if (this.phase !== 'game' || !PLAYER_SEATS.includes(m.seat) || !host?.conn || m === host) return;
        this.send(host, { t: 'in', seat: m.seat, c: msg.c });
        return;
      case 'action':     // start / reset / put back, from anyone -> the host
        if (this.phase !== 'game' || !host?.conn) return;
        if (m === host) return;
        this.send(host, { t: 'action', what: msg.what, key: msg.key, from: m.name });
        return;
      case 'state':      // the host's snapshot -> everyone else in the game
        if (m.id !== this.hostId || this.phase !== 'game') return;
        for (const x of this.members.values()) if (x !== m && x.conn && this.inGame(x)) x.conn.send(raw);
        return;
      case 'over':       // host: the battle is over -> back to the room
      case 'back':       // anyone: back to the room
        if (this.phase === 'game') this.toLobby(msg.t === 'over' ? 'battle over' : `${m.name} went back to the room`);
        return;
      default:
    }
  }

  maybeCountdown() {
    if (this.phase !== 'lobby') return;
    const players = [...this.members.values()].filter((x) => PLAYER_SEATS.includes(x.seat));
    if (!players.length || !players.every((x) => x.ready && x.conn)) return;
    this.phase = 'countdown';
    this.countdownEnd = this.timers.now() + COUNTDOWN_MS;
    this.countdownTimer = this.timers.later(() => this.startGame(), COUNTDOWN_MS);
  }

  stopCountdown() {
    if (this.countdownTimer) this.timers.cancel(this.countdownTimer);
    this.countdownTimer = null;
    this.phase = 'lobby';
  }

  startGame() {
    this.countdownTimer = null;
    if (this.phase !== 'countdown') return;
    this.phase = 'game';
    this.gameId += 1;
    for (const x of this.members.values()) x.ready = false;
    const msg = this.gameMessage();
    for (const x of this.members.values()) if (this.inGame(x)) this.send(x, msg);
    this.broadcastRoom();
  }

  // in a game: everyone seated, and the host even without a seat (it runs the simulation)
  inGame(m) { return !!m.seat || m.id === this.hostId; }

  gameMessage() {
    const seats = {};
    for (const x of this.members.values()) if (x.seat) seats[x.seat] = { id: x.id, name: x.name, online: !!x.conn };
    return { t: 'game', gameId: this.gameId, host: this.hostId, seats, settings: this.settings };
  }

  toLobby(reason) {
    this.phase = 'lobby';
    for (const x of this.members.values()) x.ready = false;
    for (const x of this.members.values()) if (x.conn) this.send(x, { t: 'lobby', reason });
    for (const m of [...this.members.values()]) if (!m.conn) this.members.delete(m.id);
    this.broadcastRoom();
  }

  roomMessage() {
    return {
      t: 'room', code: this.code, host: this.hostId, phase: this.phase,
      countdownMs: this.phase === 'countdown' ? Math.max(0, this.countdownEnd - this.timers.now()) : 0,
      settings: this.settings,
      members: [...this.members.values()].map((x) => ({ id: x.id, name: x.name, seat: x.seat, ready: x.ready, online: !!x.conn })),
    };
  }

  broadcastRoom() {
    const msg = JSON.stringify(this.roomMessage());
    for (const x of this.members.values()) if (x.conn) { try { x.conn.send(msg); } catch { /* closing */ } }
  }

  send(m, obj) {
    if (!m?.conn) return;
    try { m.conn.send(JSON.stringify(obj)); } catch { /* closing */ }
  }
}

// Room codes: 6 letters / digits without look-alikes (0 O 1 I L).
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const validCode = (c) => typeof c === 'string' && c.length === 6 && [...c].every((ch) => CODE_CHARS.includes(ch));
