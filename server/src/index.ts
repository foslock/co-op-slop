import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { C2S } from 'shared';
import { initDb, topRuns } from './db';
import { Room, RoomManager } from './rooms';

const PORT = Number(process.env.PORT ?? 3001);
const STATIC_DIR = process.env.STATIC_DIR ?? path.join(process.cwd(), 'client', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const rooms = new RoomManager();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url.pathname === '/api/leaderboard') {
    try {
      const rows = await topRuns(Math.min(50, Number(url.searchParams.get('limit') ?? 20)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('[]');
    }
    return;
  }
  // static files (production build of the client)
  let filePath = path.join(STATIC_DIR, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); res.end(); return;
  }
  if (url.pathname === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(STATIC_DIR, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Client build not found. Run: npm run build');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

interface Conn {
  id: string;
  room: Room | null;
  alive: boolean;
}

wss.on('connection', (ws: WebSocket) => {
  const conn: Conn = { id: crypto.randomUUID().slice(0, 8), room: null, alive: true };

  ws.on('pong', () => { conn.alive = true; });

  ws.on('message', (raw) => {
    let msg: C2S;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      handleMessage(ws, conn, msg);
    } catch (err) {
      console.error('[ws] error handling message', msg.t, err);
    }
  });

  ws.on('close', () => {
    conn.room?.removePlayer(conn.id);
    conn.room = null;
  });
});

function handleMessage(ws: WebSocket, conn: Conn, msg: C2S) {
  if (msg.t === 'create' || msg.t === 'join') {
    if (conn.room) conn.room.removePlayer(conn.id);
    const room = msg.t === 'create' ? rooms.create() : rooms.get(msg.code);
    if (!room) {
      ws.send(JSON.stringify({ t: 'error', msg: 'Room not found' }));
      return;
    }
    const result = room.addPlayer(ws, conn.id, msg.name, msg.cos);
    if (typeof result === 'string') {
      ws.send(JSON.stringify({ t: 'error', msg: result }));
      return;
    }
    conn.room = room;
    ws.send(JSON.stringify({
      t: 'joined',
      code: room.code,
      you: conn.id,
      players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, cosmetics: p.cosmetics, ready: p.ready })),
      hostId: room.hostId,
      seed: room.customSeed,
    }));
    return;
  }
  if (msg.t === 'leave') {
    conn.room?.removePlayer(conn.id);
    conn.room = null;
    return;
  }
  const player = conn.room?.players.get(conn.id);
  if (conn.room && player) conn.room.handle(player, msg);
}

// Heartbeat keeps proxies from idling out lobby connections.
setInterval(() => {
  for (const ws of wss.clients) {
    ws.ping();
  }
}, 30000);

initDb()
  .catch((err) => console.error('[db] init failed (leaderboard disabled)', err))
  .finally(() => {
    server.listen(PORT, () => console.log(`[only-us] listening on :${PORT}`));
  });
