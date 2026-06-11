import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { C2S } from 'shared';
import { initDb, topRuns } from './db';
import { Room, RoomManager } from './rooms';

const PORT = Number(process.env.PORT ?? 3001);

// Locate the client build relative to this bundle (server/dist/index.cjs →
// repo root/client/dist) with a cwd fallback, so deploys don't depend on the
// working directory. __dirname only exists in the CJS production bundle.
const BUNDLE_DIR = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
const STATIC_DIR =
  process.env.STATIC_DIR ??
  [path.join(BUNDLE_DIR, '..', '..', 'client', 'dist'), path.join(process.cwd(), 'client', 'dist')].find((p) =>
    fs.existsSync(path.join(p, 'index.html')),
  ) ??
  path.join(process.cwd(), 'client', 'dist');

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
  const exists = fs.existsSync(filePath);
  if (exists && !fs.statSync(filePath).isDirectory() && url.pathname !== '/') {
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  // a missing file WITH an extension is a real 404 (never serve index.html as JS/CSS)
  if (!exists && path.extname(url.pathname) !== '') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`Not found: ${url.pathname}`);
    return;
  }
  // SPA fallback for / and extensionless routes
  filePath = path.join(STATIC_DIR, 'index.html');
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Client build not found — run `npm run build` (looked in ' + STATIC_DIR + ')');
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

const indexOk = fs.existsSync(path.join(STATIC_DIR, 'index.html'));
console.log(`[static] serving ${STATIC_DIR} (index.html ${indexOk ? 'found' : 'MISSING — did the client build run?'})`);

initDb()
  .catch((err) => console.error('[db] init failed (leaderboard disabled)', err))
  .finally(() => {
    server.listen(PORT, () => console.log(`[only-us] listening on :${PORT}`));
  });
