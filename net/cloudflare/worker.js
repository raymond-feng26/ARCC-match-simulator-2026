// Room server on Cloudflare: one Durable Object per room code, holding the room in memory while
// anyone is connected (room logic: ../room_core.js). Deploy: npx wrangler deploy (see wrangler.toml).
import { Room, validCode } from '../room_core.js';

export default {
  async fetch(request, env) {
    const [, kind, code] = new URL(request.url).pathname.split('/');
    if (kind === 'room' && validCode(code)) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    return new Response('ARCC match simulator room server\n', { headers: { 'content-type': 'text/plain' } });
  },
};

export class RoomObject {
  constructor() {
    this.room = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.room ??= new Room(url.pathname.split('/')[2], {
      now: () => Date.now(), later: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h),
    });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const conn = { send: (text) => server.send(text), close: () => server.close(1000, 'closed by the room') };
    const q = url.searchParams;
    const member = this.room.join(conn, { name: q.get('name'), token: q.get('token'), create: q.get('create') === '1' });
    if (member) {
      server.addEventListener('message', (e) => { if (typeof e.data === 'string') this.room.message(member, e.data); });
      const gone = () => this.room.leave(member, conn);
      server.addEventListener('close', gone);
      server.addEventListener('error', gone);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}
