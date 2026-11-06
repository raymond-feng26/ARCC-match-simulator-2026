// Connection to one room on the room server: JSON messages; after a drop it reconnects with the
// member token, so the seat is kept (the token is kept per browser tab, so a reload rejoins too).
// same alphabet as net/room_core.js (not deployed with the page)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export class RoomConnection {
  constructor(server, code, { name, create = false }) {
    Object.assign(this, { server, code, name, create });
    this.onmessage = () => {};
    this.onstatus = () => {};    // 'connecting' | 'open' | 'retrying' | 'closed'
    this.closed = false;
    this.tries = 0;
    this.connect();
  }

  get token() { try { return sessionStorage.getItem(`matchSim.room.${this.code}`) ?? ''; } catch { return ''; } }
  set token(t) { try { sessionStorage.setItem(`matchSim.room.${this.code}`, t); } catch { /* no storage: no rejoin */ } }

  connect() {
    const q = new URLSearchParams({ name: this.name, token: this.token, create: this.create ? '1' : '0' });
    this.onstatus(this.tries ? 'retrying' : 'connecting');
    const ws = new WebSocket(`${this.server}/room/${this.code}?${q}`);
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; this.onstatus('open'); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'welcome') { this.token = msg.token; this.you = msg.you; this.create = false; }
      if (msg.t === 'error') this.closed = true;   // refused: do not retry
      this.onmessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.closed || this.tries >= 20) { this.closed = true; this.onstatus('closed'); return; }
      this.tries += 1;
      this.onstatus('retrying');
      setTimeout(() => { if (!this.closed) this.connect(); }, Math.min(5000, 500 * this.tries));
    };
  }

  send(obj) { if (this.ws?.readyState === 1) this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  close() { this.closed = true; this.ws?.close(); }
}
