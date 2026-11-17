// The board's door to Codex, for the optional Send to Codex button. Nothing here runs unless that feature is
// turned on and the owner presses the button.
//
// The codex command line keeps a managed daemon (`codex app-server daemon`). This file talks to it: JSON
// messages over a WebSocket on its local socket. A turn started here runs on the daemon. When another client
// (the Codex desktop app) holds the thread, the daemon refuses to take it over, and the message goes into
// Codex's own queue for that thread instead (queueMessage), which the app then runs.
//
// The board never starts a thread. It sends only into a thread the owner adopted (see adopt.js).
//
// GLITCHLESS_BOARD_CODEX names the codex program and GLITCHLESS_BOARD_CODEX_SOCKET the daemon's socket; the
// tests point both at stand-ins, so they never reach a real Codex.

import crypto from 'node:crypto';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { SERVER_NAME } from './config.js';
import { Problem } from './util.js';

const codexBin = () => process.env.GLITCHLESS_BOARD_CODEX || 'codex';

export function socketPath() {
  if (process.env.GLITCHLESS_BOARD_CODEX_SOCKET) return process.env.GLITCHLESS_BOARD_CODEX_SOCKET;
  let v;
  try {
    v = JSON.parse(execFileSync(codexBin(), ['app-server', 'daemon', 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (err) {
    throw new Problem(err.code === 'ENOENT' ? 'The codex command is not installed (or not on the PATH).' : "Codex's daemon did not answer (codex app-server daemon version).");
  }
  if (v.status !== 'running' || !v.socketPath) throw new Problem("Codex's daemon is not running. Start it with: codex app-server daemon start");
  return v.socketPath;
}

// A minimal WebSocket client over a local socket: text frames only, which is all the daemon sends.
function connect(sock) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: sock,
      path: '/',
      headers: { Host: 'localhost', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, socket, head) => {
      let buf = head;
      let parts = [];
      const listeners = new Set();
      const send = (opcode, payload) => {
        const len = payload.length;
        const mask = crypto.randomBytes(4);
        let header;
        if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
        else if (len < 65536) header = Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]);
        else {
          header = Buffer.alloc(10);
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        const body = Buffer.from(payload);
        for (let i = 0; i < len; i++) body[i] ^= mask[i % 4];
        socket.write(Buffer.concat([header, mask, body]));
      };
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = buf[0] & 0x80;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 9) {
            send(10, payload); // ping -> pong
            continue;
          }
          if (op === 8) {
            socket.end();
            return;
          }
          if (op === 1 || op === 0) {
            parts.push(payload);
            if (fin) {
              const text = Buffer.concat(parts).toString('utf8');
              parts = [];
              for (const l of listeners) l(text);
            }
          }
        }
      });
      socket.on('error', () => {});
      resolve({
        send: (text) => send(1, Buffer.from(text, 'utf8')),
        onText: (fn) => listeners.add(fn),
        close: () => {
          try {
            send(8, Buffer.alloc(0));
          } catch {}
          socket.end();
        },
      });
    });
    req.on('response', (res) => reject(new Error(`Codex's daemon answered HTTP ${res.statusCode} instead of opening a WebSocket.`)));
    req.on('error', (err) => reject(new Error(`Could not reach Codex's daemon (${err.code || err.message}).`)));
    req.end();
  });
}

/** One connection to the daemon, after its hello. */
export async function session({ version = '0' } = {}) {
  const ws = await connect(socketPath());
  let id = 0;
  const pending = new Map();
  const s = {
    listeners: new Set(),
    close: () => ws.close(),
    call: (method, params, ms = 15000) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject, method });
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error(`Codex gave no answer to ${method}.`));
          }
        }, ms).unref?.();
      }),
    notify: (method, params) => ws.send(JSON.stringify({ method, params })),
  };
  ws.onText((text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message || JSON.stringify(m.error)}`));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const fn of s.listeners) fn(m.id !== undefined ? { request: m.method, params: m.params } : { note: m.method, params: m.params });
    }
  });
  await s.call('initialize', { clientInfo: { name: 'glitchless-board', title: 'Glitchless Board', version } });
  s.notify('initialized');
  return s;
}

// The board's tools for one load of one thread: Codex's saved servers are untouched. They are marked approved
// because a thread can't use an unknown server's tools when nobody is there to approve them.
export const boardConfig = (url) => ({ mcp_servers: { [SERVER_NAME]: { url, default_tools_approval_mode: 'approve' } } });

/** Loads an idle thread again, read-only, with the board's tools attached, so a new turn can use them. */
export const resumeThread = (s, { threadId, config }) => s.call('thread/resume', { threadId, sandbox: 'read-only', excludeTurns: true, ...(config ? { config } : {}) }, 30000);

/** Starts a turn. `started` settles when Codex has accepted it; `done` when the turn ends or waitS runs out. */
export function runTurn(s, { threadId, text, waitS = 300 }) {
  let reply = '';
  const tools = [];
  const done = new Promise((resolve) => {
    let timer = null;
    const finish = (how) => {
      clearTimeout(timer);
      s.listeners.delete(on);
      resolve({ how, reply, tools });
    };
    const on = (ev) => {
      if (ev.request) return; // an approval request: left unanswered, so nothing is approved from here
      const p = ev.params || {};
      if (p.threadId && p.threadId !== threadId) return;
      const it = p.item;
      if (ev.note === 'item/completed' && it) {
        if (it.type === 'mcpToolCall') tools.push(`${it.server}.${it.tool}:${it.status}`);
        else if (it.type === 'agentMessage') reply = String(it.text);
        else if (it.type !== 'userMessage' && it.type !== 'reasoning') tools.push(it.type);
      } else if (ev.note === 'turn/completed') finish(p.turn?.status || 'completed');
    };
    s.listeners.add(on);
    timer = setTimeout(() => finish('still running when the board stopped listening'), waitS * 1000);
    timer.unref?.();
  });
  const started = s.call('turn/start', { threadId, input: [{ type: 'text', text }] }, 30000);
  return { started, done };
}

/**
 * Puts a message into a thread's queue with Codex's own command, and asks for it to be run. This is the way
 * in when another client holds the thread. If nothing can start it, the message stays queued in that thread.
 */
export const queueMessage = (threadId, text) =>
  new Promise((resolve, reject) => {
    execFile(codexBin(), ['queue', '--thread', threadId, '--message', text, '--resume'], { encoding: 'utf8', timeout: 90000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err && !/queued/i.test(out)) reject(new Error(`codex queue: ${(out || err.message).slice(0, 300)}`));
      else resolve(out);
    });
  });

/** What the thread's latest turn did, read from the daemon without joining the thread. */
export async function lastTurn(s, threadId) {
  const r = await s.call('thread/read', { threadId, includeTurns: true }, 20000);
  const t = r.thread || r;
  const turns = t.turns || [];
  const turn = turns[turns.length - 1];
  if (!turn) return { status: t.status?.type, turns: 0 };
  const items = turn.items || [];
  return {
    status: t.status?.type,
    turns: turns.length,
    turnId: turn.id,
    turnStatus: turn.status,
    tools: items.filter((i) => i.type === 'mcpToolCall').map((i) => `${i.server}.${i.tool}:${i.status}`),
    reply: items.filter((i) => i.type === 'agentMessage').map((i) => i.text).pop() || '',
  };
}

/** Read-only: can the board reach Codex's daemon. Spends nothing. */
export async function probe() {
  const s = await session();
  try {
    const r = await s.call('thread/list', { limit: 5 });
    return { reached: true, threads_on_first_page: (r.data || []).length };
  } finally {
    s.close();
  }
}
