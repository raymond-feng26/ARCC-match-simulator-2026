// Room server on one computer, for testing or for play on a network whose devices can reach each
// other (a phone hotspot or your own router; campus Wi-Fi often blocks that). Also serves the
// simulator page itself, so everyone opens http://<this computer>:8787/?online
// No packages: Node's http + a minimal WebSocket (RFC 6455) implementation.
//   node net/local_server.mjs [--port 8787]
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room, validCode } from './room_core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // match_sim/
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8787;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const timers = { now: () => Date.now(), later: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h) };
const rooms = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // the page asks this to know it was served by a local room server (then it uses this server for rooms)
  if (url.pathname === '/room-server-info') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('local'); return; }
  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}net${path.sep}`)) { res.writeHead(404).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// WebSocket at /room/CODE
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const code = url.pathname.split('/')[2];
  const key = req.headers['sec-websocket-key'];
  if (!url.pathname.startsWith('/room/') || !validCode(code) || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const conn = wsConnection(socket);
  if (!rooms.has(code)) rooms.set(code, new Room(code, timers));
  const room = rooms.get(code);
  const q = url.searchParams;
  const member = room.join(conn, { name: q.get('name'), token: q.get('token'), create: q.get('create') === '1' });
  if (!member) return;
  conn.onmessage = (text) => room.message(member, text);
  conn.onclose = () => {
    room.leave(member, conn);
    if (room.empty()) setTimeout(() => { if (room.empty()) rooms.delete(code); }, 130000);
  };
});

function wsConnection(socket) {
  let buf = Buffer.alloc(0), parts = [], closed = false;
  const conn = {
    onmessage: () => {}, onclose: () => {},
    send(text) { if (!closed) socket.write(frame(0x1, Buffer.from(text))); },
    close() { if (!closed) { socket.write(frame(0x8, Buffer.alloc(0))); socket.end(); } },
  };
  const finish = () => { if (!closed) { closed = true; conn.onclose(); } };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 0x8) { socket.end(); finish(); return; }
      if (op === 0x9) { socket.write(frame(0xa, data)); continue; }   // ping -> pong
      if (op === 0x1 || op === 0x0) {
        parts.push(data);
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; conn.onmessage(text); }
      }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return conn;
}

function frame(op, data) {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, data]);
}

server.listen(port, () => {
  console.log(`room server + simulator on port ${port}. Open on each computer:`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) if (n.family === 'IPv4' && !n.internal) console.log(`  http://${n.address}:${port}/?online`);
  }
  console.log(`  (this computer: http://localhost:${port}/?online)`);
});
