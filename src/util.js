// Small helpers shared by the rest.

import fs from 'node:fs';
import path from 'node:path';

/** Something the person at the keyboard can act on: printed as it is, without a stack. */
export class Problem extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The one way a name is written on the board: lower case, and only letters, digits, _ . and -.
 * `wait --as Claude` and a message to "claude" have to meet, so every door uses this.
 */
export function cleanName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]/g, '_')
    .slice(0, 40);
}

/** Names an agent may not take for itself: the page would show its words as the owner's or the board's. */
export const RESERVED_NAMES = ['owner', 'board', 'all', 'user', 'human'];

export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Problem(`${file} is not valid JSON: ${err.message}`);
  }
}

/** Writes a file by way of a temporary one, so a crash never leaves half of it. */
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** True when `child` is `parent` or inside it. Both must already be real paths. */
export function isInside(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The real path of something that exists, or null. */
export function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export const toPosix = (p) => p.split(path.sep).join('/');

/** "sound_effects" or "sound-effects" as "Sound effects". */
export function titleFrom(name) {
  const words = String(name).replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Untitled';
}

/** Sorts names the way a person reads them: take_2 before take_10. */
export const byName = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
