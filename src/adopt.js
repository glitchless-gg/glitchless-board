// `glitchless-board adopt`: tells the board about a Codex thread the owner started, and optionally which item
// that thread made. Send to Codex only ever sends into a thread recorded here.
//
// It writes to the record directly, so it runs only while the board is stopped: a running board keeps the
// record in memory, and there is deliberately no way to register a thread over HTTP, where any local
// program could reach it.

import crypto from 'node:crypto';
import { scanProject } from './project.js';
import { openRecord } from './record.js';
import { Problem } from './util.js';

const THREAD_ID = /^[0-9a-f-]{20,64}$/i;

export function adoptThread(config, { thread, item, name } = {}) {
  if (typeof thread !== 'string' || !THREAD_ID.test(thread)) throw new Problem('adopt needs --thread <id>: the Codex thread id (letters a to f, digits and dashes).');
  const record = openRecord(config.stateDir);
  const itemId = typeof item === 'string' && item ? item : null;
  if (itemId) {
    const known = scanProject(config).has(itemId) || record.events.some((e) => e.type === 'post' && e.item === itemId);
    if (!known) throw new Problem(`No item "${itemId}" on this board. Ids are listed by the board_list tool and shown under each card.`);
  }
  const already = record.events.some((e) => e.type === 'thread' && e.thread === thread);
  if (!already) {
    record.append({ type: 'thread', thread, key: crypto.randomBytes(12).toString('hex'), member: 'codex', ...(typeof name === 'string' && name ? { name: name.slice(0, 80) } : {}), how: 'adopted from the command line', door: 'cli' });
  }
  if (itemId) record.append({ type: 'link', item: itemId, thread, door: 'cli' });
  return { thread, adopted: !already, item: itemId };
}
