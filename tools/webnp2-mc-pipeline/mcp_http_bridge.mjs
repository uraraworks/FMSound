#!/usr/bin/env node
// Persistent HTTP -> WebNP2 MCP stdio bridge.
// Spawns the real WebNP2 mcp/server.mjs (unmodified, from the repo) as a child
// process and exposes a tiny local HTTP control API so that separate,
// synchronous `curl` calls (one per Bash tool invocation) can drive it without
// re-spawning the server (and thus without dropping the browser's WebSocket
// connection) each time.
//
// POST /call  { "name": "<tool name>", "arguments": { ... } }  -> JSON result
// GET  /health -> "ok" once initialize handshake is complete
//
// WEBNP2_SERVER_PATH: WebNP2リポジトリの mcp/server.mjs への絶対パス。
//   未設定時は、WebNP2がこのFMSoundリポジトリの隣(_emulator/PC98/WebNP2)に
//   チェックアウトされている前提のデフォルトを使う。環境が違う場合は指定すること。
//   例: WEBNP2_SERVER_PATH=/path/to/WebNP2/mcp/server.mjs node mcp_http_bridge.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_PATH = path.resolve(__dirname, '../../../PC98/WebNP2/mcp/server.mjs');
const SERVER_PATH = process.env.WEBNP2_SERVER_PATH || DEFAULT_SERVER_PATH;
const HTTP_PORT = Number(process.env.BRIDGE_HTTP_PORT) || 8765;

const srv = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let nextId = 100;
const pending = new Map();
let ready = false;

function send(obj) {
  srv.stdin.write(JSON.stringify(obj) + '\n');
}

srv.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1) {
      // initialize response -> send initialized notification
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      ready = true;
      console.error('[bridge] MCP handshake complete');
      continue;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

srv.stderr.on('data', (d) => process.stderr.write('[server.mjs] ' + d));
srv.on('exit', (code) => {
  console.error(`[bridge] server.mjs exited with code ${code}`);
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http-bridge', version: '0' } },
});

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(ready ? 'ok' : 'not-ready');
    return;
  }
  if (req.method === 'POST' && req.url === '/call') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'bad json: ' + e.message }));
        return;
      }
      const { name, arguments: args } = parsed;
      const id = nextId++;
      const p = new Promise((resolve) => pending.set(id, { resolve }));
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } });
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ timeout: true }), 25000)
      );
      const result = await Promise.race([p, timeout]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.error(`[bridge] HTTP control API listening on 127.0.0.1:${HTTP_PORT}`);
});
