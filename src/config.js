// glitchless.board.json: which folders of a game hold the things to judge, and how to group them.
//
//   {
//     "name": "Sample Game",
//     "port": 8792,
//     "sections": [
//       { "title": "Screens",       "kind": "captures", "folder": "captures" },
//       { "title": "Characters",    "kind": "pictures", "folder": "art/characters" },
//       { "title": "Sound effects", "kind": "sounds",   "folder": "audio/sfx" }
//     ],
//     "logs": [ { "file": "art/log.csv", "id": "file", "prompt_file": "prompt_file" } ],
//     "codex": { "send": false }
//   }
//
// The file sits in the game's root. The board's own record goes in .glitchless/board/ beside it.

import fs from 'node:fs';
import path from 'node:path';
import { Problem, readJson, titleFrom } from './util.js';

export const CONFIG_FILE = 'glitchless.board.json';
export const DEFAULT_PORT = 8792;
/** The name the board is saved under in a harness. An underscore, not a dash: the form Claude Code's rules and Codex's documented examples use. */
export const SERVER_NAME = 'glitchless_board';
export const KINDS = ['pictures', 'captures', 'sounds'];

const PICTURES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const SOUNDS = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
/** Every kind of file the board will serve or accept, with the type it is served as. Nothing else leaves the disk. */
export const MEDIA = { ...PICTURES, ...SOUNDS };
export const isSound = (file) => path.extname(file).toLowerCase() in SOUNDS;
export const extensionsFor = (kind) => Object.keys(kind === 'sounds' ? SOUNDS : PICTURES);

/** Section titles the board keeps for itself. */
export const POSTED = 'New from agents';
const RESERVED_TITLES = [POSTED.toLowerCase(), 'posted'];

/** The config file in dir or the nearest folder above it, or null. */
export function findConfig(dir = process.cwd()) {
  let at = path.resolve(dir);
  for (;;) {
    const file = path.join(at, CONFIG_FILE);
    if (fs.existsSync(file)) return file;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

function fail(file, message) {
  throw new Problem(`${file}: ${message}`);
}

/**
 * Reads and checks a config. Returns it with every path made absolute:
 * { file, root, name, port, sections: [{ title, kind, folder, split }], logs: [{ file, id, prompt_file, caption }],
 *   codex: { send, via }, stateDir }
 */
export function loadConfig(dirOrFile = process.cwd(), { port, record } = {}) {
  const given = path.resolve(dirOrFile);
  const file = given.endsWith('.json') ? given : findConfig(given);
  if (!file || !fs.existsSync(file)) {
    throw new Problem(`No ${CONFIG_FILE} in ${given} or above it. In the game's root folder, run: glitchless-board init`);
  }
  const raw = readJson(file, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(file, 'it should hold one JSON object.');
  const root = path.resolve(path.dirname(file), typeof raw.root === 'string' ? raw.root : '.');
  if (!fs.existsSync(root)) fail(file, `"root" points at ${root}, which is not there.`);

  const wantPort = port ?? raw.port ?? DEFAULT_PORT;
  if (!Number.isInteger(wantPort) || wantPort < 1 || wantPort > 65535) fail(file, `"port" should be a whole number from 1 to 65535, not ${JSON.stringify(wantPort)}.`);

  if (raw.sections != null && !Array.isArray(raw.sections)) fail(file, '"sections" should be a list.');
  const seen = new Set();
  const sections = (raw.sections || []).map((s, i) => {
    const where = `section ${i + 1}`;
    if (!s || typeof s !== 'object') fail(file, `${where} should be an object with "folder" and "kind".`);
    if (typeof s.folder !== 'string' || !s.folder.trim()) fail(file, `${where} needs "folder": the folder that holds its files, relative to this file.`);
    if (!KINDS.includes(s.kind)) fail(file, `${where} needs "kind": one of ${KINDS.join(', ')}.`);
    const title = String(s.title ?? titleFrom(path.basename(s.folder))).trim();
    if (!title || title.includes('/')) fail(file, `${where} has the title ${JSON.stringify(title)}. A title is a few words without "/".`);
    if (RESERVED_TITLES.includes(title.toLowerCase())) fail(file, `${where} is titled ${JSON.stringify(title)}, which the board keeps for takes posted by agents.`);
    if (seen.has(title.toLowerCase())) fail(file, `two sections are titled ${JSON.stringify(title)}. Titles are part of each item's id, so give each its own.`);
    seen.add(title.toLowerCase());
    if (s.split != null && s.split !== 'subfolders') fail(file, `${where} has "split": ${JSON.stringify(s.split)}. The only value is "subfolders" (one section per folder inside).`);
    return { title, kind: s.kind, folder: path.resolve(root, s.folder), split: s.split === 'subfolders' };
  });

  if (raw.logs != null && !Array.isArray(raw.logs)) fail(file, '"logs" should be a list.');
  const logs = (raw.logs || []).map((l, i) => {
    const where = `log ${i + 1}`;
    if (!l || typeof l !== 'object' || typeof l.file !== 'string') fail(file, `${where} needs "file": a .csv or .jsonl file, relative to this file.`);
    if (!/\.(csv|jsonl)$/i.test(l.file)) fail(file, `${where} is ${l.file}. A log is a .csv or a .jsonl file.`);
    for (const key of ['id', 'prompt_file', 'caption']) {
      if (l[key] != null && typeof l[key] !== 'string') fail(file, `${where}: "${key}" should be the name of a column.`);
    }
    return { file: path.resolve(root, l.file), id: l.id || null, prompt_file: l.prompt_file || null, caption: l.caption || null };
  });

  const codex = raw.codex && typeof raw.codex === 'object' ? raw.codex : {};
  if (codex.via != null && !['auto', 'queue'].includes(codex.via)) fail(file, '"codex.via" is "auto" or "queue".');

  return {
    file,
    root,
    name: String(raw.name || titleFrom(path.basename(root))).slice(0, 80),
    port: wantPort,
    sections,
    logs,
    codex: { send: codex.send === true, via: codex.via || 'auto' },
    stateDir: path.resolve(record || process.env.GLITCHLESS_BOARD_RECORD || path.join(root, '.glitchless', 'board')),
  };
}
