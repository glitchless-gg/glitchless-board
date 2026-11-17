// The record: an append-only list of what happened on the board, one JSON line per event in events.jsonl.
//
// Every event has a seq (1, 2, 3...), a time, a type and a door: the way it came in ("page", "mcp", "cli",
// "codex" or "board"). An event without a door is refused, so nothing lands here without saying how it arrived.
//
// Beside it, cursors.json remembers how far each waiting name has been told, and server.json says which
// process is serving this record, so a second one does not write to it.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeFileAtomic } from './util.js';

export const DOORS = ['page', 'mcp', 'cli', 'codex', 'board'];

export function openRecord(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  const cursorFile = path.join(dir, 'cursors.json');
  const events = [];
  let skipped = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        skipped++; // a line cut short by a crash: left in the file, not used
      }
    }
  }
  let seq = events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
  const saved = readJson(cursorFile, {});
  const cursors = { told: Number(saved.told) || 0, names: saved.names && typeof saved.names === 'object' ? saved.names : {} };
  const save = () => writeFileAtomic(cursorFile, `${JSON.stringify(cursors, null, 1)}\n`);

  return {
    dir,
    file,
    events,
    skipped,
    get seq() {
      return seq;
    },

    /** Adds one event. It must say its type and the door it came through. */
    append(event) {
      if (!event || typeof event.type !== 'string' || !event.type) throw new Error('An event needs a type.');
      if (!DOORS.includes(event.door)) throw new Error(`A "${event.type}" event needs the door it came through (${DOORS.join(', ')}).`);
      const e = { seq: ++seq, at: new Date().toISOString(), ...event };
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
      events.push(e);
      return e;
    },

    /** How far a name has been told: { verdicts: seq, messages: seq }, or undefined if it has never waited. */
    cursor(name) {
      return cursors.names[name];
    },
    setCursor(name, value) {
      cursors.names[name] = { verdicts: Number(value.verdicts) || 0, messages: Number(value.messages) || 0 };
      save();
    },
    /** The last verdict any name has been told. A new name starts after it. */
    get told() {
      return cursors.told;
    },
    set told(value) {
      if (value > cursors.told) {
        cursors.told = value;
        save();
      }
    },
  };
}

// ─── Which process is serving a record ───

const serverFile = (dir) => path.join(dir, 'server.json');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** { pid, port } of the board serving this record now, or null. */
export function servingNow(dir) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(serverFile(dir), 'utf8'));
  } catch {
    return null;
  }
  return info && Number.isInteger(info.pid) && info.pid !== process.pid && alive(info.pid) ? info : null;
}

export function markServing(dir, port) {
  writeFileAtomic(serverFile(dir), `${JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() })}\n`);
}

export function unmarkServing(dir) {
  try {
    const info = JSON.parse(fs.readFileSync(serverFile(dir), 'utf8'));
    if (info.pid === process.pid) fs.rmSync(serverFile(dir));
  } catch {}
}
