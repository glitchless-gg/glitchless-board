// A stand-in for Codex, so the Send to Codex tests never reach a real one: its daemon (JSON messages over a
// WebSocket on a local socket, as src/codex.js speaks it) and its `codex` command (for `codex queue`).
//
// It keeps threads in memory. A thread can be "held" (as when the Codex app has it open, so a takeover is
// refused) or "busy". A turn that starts here ends at once with one board_read call and a one-line reply.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let n = 0;

export async function fakeCodex(dir) {
  const sock = path.join(os.tmpdir(), `gb-codex-${process.pid}-${n++}.sock`);
  const queueLog = path.join(dir, 'queue.jsonl');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(queueLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('Message queued.');\n`);
  fs.chmodSync(bin, 0o755);

  const fake = {
    sock,
    bin,
    calls: [], // every request the daemon was sent: { method, params }
    threads: new Map(), // id -> { turns: [], held, busy }
    reply: 'I see REDO on that item. I would lighten the helmet.',
    thread(id) {
      if (!this.threads.has(id)) this.threads.set(id, { turns: [], held: false, busy: false });
      return this.threads.get(id);
    },
    /** What `codex queue` was run with, one list of arguments per run. */
    queued: () => (fs.existsSync(queueLog) ? fs.readFileSync(queueLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    /** As if the app that holds the thread ran the message waiting in its queue. */
    runQueued(id) {
      this.thread(id).turns.push(turn(this.reply));
    },
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
  const turn = (reply) => ({
    id: crypto.randomUUID(),
    status: 'completed',
    items: [{ type: 'userMessage' }, { type: 'mcpToolCall', server: 'glitchless_board', tool: 'board_read', status: 'completed' }, { type: 'agentMessage', text: reply }],
  });

  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
      socket.write(Buffer.concat([head, payload]));
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
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
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        buf = buf.subarray(off + 4 + len);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (op === 8) return socket.end();
        if (op === 1) handle(JSON.parse(payload.toString('utf8')), send);
      }
    });
  });

  function handle(msg, send) {
    if (msg.id === undefined) return; // a notification
    fake.calls.push({ method: msg.method, params: msg.params });
    const ok = (result) => send({ id: msg.id, result });
    const no = (message) => send({ id: msg.id, error: { code: -32000, message } });
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize':
        return ok({ userAgent: 'fake-codex' });
      case 'thread/list':
        return ok({ data: [...fake.threads.keys()].map((id) => ({ id })) });
      case 'thread/read': {
        const t = fake.thread(p.threadId);
        return ok({ thread: { id: p.threadId, status: { type: t.busy ? 'active' : 'idle' }, turns: p.includeTurns ? t.turns : undefined } });
      }
      case 'thread/resume':
        return fake.thread(p.threadId).held ? no('thread already has an active writer') : ok({ thread: { id: p.threadId } });
      case 'turn/start': {
        const done = turn(fake.reply);
        fake.thread(p.threadId).turns.push(done);
        ok({ turn: { id: done.id } });
        for (const item of done.items) send({ method: 'item/completed', params: { threadId: p.threadId, item } });
        return send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: done.id, status: 'completed' } } });
      }
      default:
        return no(`unknown method ${msg.method}`);
    }
  }

  await new Promise((resolve) => server.listen(sock, resolve));
  return fake;
}
