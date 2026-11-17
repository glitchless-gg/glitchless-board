// The board's server: the page, its small API, the project's pictures and sound, and the MCP endpoint.
//
// It answers this computer only:
//   - it listens on 127.0.0.1;
//   - a request has to name 127.0.0.1 or localhost with the board's own port as its host, so no other site
//     can reach it under a name of its own;
//   - a request a browser makes from another site is turned away (except opening the page itself);
//   - a verdict or a send has to carry the token this run put into its own page.
//
// It never writes to the game's folders. Pictures and sound are served only from the folders the config
// names, checked by real path, and nothing but pictures and sound is served from them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard } from './board.js';
import { MEDIA, SERVER_NAME, loadConfig } from './config.js';
import { createMcp } from './mcp.js';
import { markServing, openRecord, servingNow, unmarkServing } from './record.js';
import { Problem } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'ui');
const ASSETS = { '/favicon.svg': 'image/svg+xml', '/mark-dark.svg': 'image/svg+xml' };
const MAX_BODY = 1e6;

export const packageVersion = () => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(Object.assign(new Error('The request is too large.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch (err) {
    throw err.status ? err : Object.assign(new Error('The request body is not JSON.'), { status: 400 });
  }
}

/**
 * Builds the board for a config without listening. Returns { server, board, record, token, config }.
 * `codex` is the client Send to Codex talks through (the tests pass a stand-in); `codexOn` turns the feature on.
 */
export function createServer({ config, record = openRecord(config.stateDir), codex = null, codexOn, sendVia, limits, log = () => {} } = {}) {
  const version = packageVersion();
  const token = crypto.randomBytes(16).toString('hex');
  let port = config.port;
  const board = createBoard({ config, record, codex, codexOn: codexOn ?? config.codex.send, sendVia: sendVia ?? config.codex.via, port: () => port, limits, log });
  const mcp = createMcp(board, { version });
  const pages = new Set();
  board.on((msg) => {
    for (const res of pages) res.write(`data: ${JSON.stringify(msg)}\n\n`);
  });

  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const localOrigin = (o) => !o || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  const fromThePage = (req) => localOrigin(req.headers.origin) && req.headers['x-board-owner'] === token;

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: 'This board answers this computer only.' });
      const url = new URL(req.url, `http://${host}`);
      const pathname = url.pathname;

      // A browser says where a request came from. Another site may open the page; it may do nothing else.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none' && !(req.method === 'GET' && pathname === '/' && req.headers['sec-fetch-mode'] === 'navigate')) {
        return json(res, 403, { error: 'This board answers its own page only.' });
      }

      if (req.method === 'GET' && pathname === '/') {
        const nonce = crypto.randomBytes(16).toString('base64');
        const boot = JSON.stringify({ token, project: config.name, port, version, server: SERVER_NAME }).replace(/</g, '\\u003c');
        const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8').replace('/*BOOT*/null', boot).replaceAll('__NONCE__', nonce);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          // Nothing loads from anywhere but this board, and only the page's own script runs.
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
        return res.end(html);
      }
      if (req.method === 'GET' && ASSETS[pathname]) {
        res.writeHead(200, { 'content-type': ASSETS[pathname], 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
        return fs.createReadStream(path.join(UI, pathname.slice(1))).pipe(res);
      }
      if (req.method === 'GET' && pathname === '/api/ping') return json(res, 200, { board: 'glitchless-board', version, pid: process.pid, project: config.name });
      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, { version, port, server: SERVER_NAME, ...board.state() });
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'waiters', waiting: board.waitingNames() })}\n\n`);
        pages.add(res);
        const beat = setInterval(() => res.write(': beat\n\n'), 25000);
        req.on('close', () => {
          clearInterval(beat);
          pages.delete(res);
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/media') {
        const real = board.media(url.searchParams.get('p') || '');
        if (!real) return json(res, 404, { error: 'Not a picture or sound of this project.' });
        const size = fs.statSync(real).size;
        const head = { 'content-type': MEDIA[path.extname(real).toLowerCase()], 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' };
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (m && (m[1] || m[2])) {
          const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
          const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            res.writeHead(416, { 'content-range': `bytes */${size}` });
            return res.end();
          }
          res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
          return fs.createReadStream(real, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...head, 'content-length': size });
        return fs.createReadStream(real).pipe(res);
      }
      if (req.method === 'POST' && pathname === '/api/verdict') {
        if (!fromThePage(req)) return json(res, 403, { error: "Verdicts come from the board's page only." });
        const b = await readJsonBody(req);
        return json(res, 200, board.giveVerdict({ item: String(b.item ?? ''), v: b.v, take: b.take, note: b.note }));
      }
      if (req.method === 'POST' && pathname === '/api/send') {
        if (!fromThePage(req)) return json(res, 403, { error: "Sending comes from the board's page only." });
        const b = await readJsonBody(req);
        try {
          return json(res, 200, await board.sendToCodex(String(b.item ?? '')));
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
      }
      if (req.method === 'GET' && pathname === '/api/wait') {
        if (!localOrigin(req.headers.origin)) return json(res, 403, { error: 'This board answers this computer only.' });
        const q = url.searchParams;
        // Headers and a heartbeat go out at once, so a client's idle timeout never ends a long wait.
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        const beat = setInterval(() => res.write(' '), 20000);
        const wait = board.startWait({
          name: q.get('as') || 'agent',
          since: q.has('since') ? Number(q.get('since')) : undefined,
          timeout: Math.max(1, Math.min(86400, Number(q.get('timeout')) || 3600)),
          settle: Math.max(0, Math.min(10, Number(q.get('settle') ?? 2))),
        });
        req.on('close', () => {
          clearInterval(beat);
          wait.cancel();
        });
        const out = await wait.promise;
        clearInterval(beat);
        return res.end(JSON.stringify(out));
      }
      if (pathname === '/mcp') {
        if (!localOrigin(req.headers.origin)) return json(res, 403, { error: 'This board answers this computer only.' });
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          return res.end();
        }
        const body = await readJsonBody(req);
        const ctx = { door: 'mcp', thread: board.threadOfKey(url.searchParams.get('k')) };
        const out = await mcp(body, ctx);
        if (out) return json(res, 200, out);
        res.writeHead(202);
        return res.end();
      }
      json(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 400, { error: String(err.message || err) });
      else res.end();
    }
  });

  return {
    server,
    board,
    record,
    token,
    config,
    /** Listens on 127.0.0.1. Port 0 picks a free one (the tests use that). */
    listen(wantPort = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', (err) => reject(err.code === 'EADDRINUSE' ? new Problem(`Port ${wantPort} is taken. Another board may be running, or set another "port" in glitchless.board.json (or pass --port).`) : err));
        server.listen(wantPort, '127.0.0.1', () => {
          port = server.address().port;
          resolve(port);
        });
      });
    },
    get port() {
      return port;
    },
    close() {
      board.close();
      for (const res of pages) res.end();
      unmarkServing(record.dir);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/** `glitchless-board serve`: loads the project in dir, refuses a second board on the same record, and listens. */
export async function startServer({ dir = process.cwd(), port, record, codexOn, sendVia, log = console.log } = {}) {
  const config = loadConfig(dir, { port, record });
  const other = servingNow(config.stateDir);
  if (other && (await isBoard(other.port, other.pid))) {
    throw new Problem(`A board is already running for this project: http://127.0.0.1:${other.port}/ (process ${other.pid}). Stop it first, or use that one.`);
  }
  const made = createServer({ config, codexOn, sendVia, log });
  const at = await made.listen(config.port);
  markServing(config.stateDir, at);
  const stats = made.board.stats();
  log(`Glitchless Board for ${config.name}: http://127.0.0.1:${at}/`);
  log(`  ${stats.items} ${stats.items === 1 ? 'item' : 'items'} in ${stats.sections} ${stats.sections === 1 ? 'section' : 'sections'}. Agents: MCP at http://127.0.0.1:${at}/mcp`);
  log(`  Record: ${config.stateDir}`);
  for (const l of stats.logs) log(`  Log ${l.log}: ${l.problem || `${l.matched} of ${l.rows} rows matched a file${l.ambiguous ? `, ${l.ambiguous} matched more than one` : ''}`}`);
  if (made.record.skipped) log(`  ${made.record.skipped} unreadable ${made.record.skipped === 1 ? 'line' : 'lines'} in the record were skipped.`);
  if (codexOn ?? config.codex.send) log('  Send to Codex is on: each press on the page spends one Codex turn.');
  return made;
}

/** True when a board with that process id answers on the port. */
export async function isBoard(port, pid) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const body = await r.json();
    return body.board === 'glitchless-board' && (pid == null || body.pid === pid);
  } catch {
    return false;
  }
}
