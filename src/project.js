// What a game already holds, for the board: the files in the folders the config names, grouped into
// sections, and what the game's own logs say about how each was made.
//
// The game folder is only read. Files are found fresh each time (with a short memory, so a burst of calls
// scans once), because agents make new takes while the board runs.

import fs from 'node:fs';
import path from 'node:path';
import { MEDIA, extensionsFor } from './config.js';
import { byName, isInside, realPath, toPosix } from './util.js';

const MAX_DEPTH = 8;
const MAX_ITEMS = 5000; // per section: the page is one document
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const PROMPT_EXT = ['.txt', '.md'];
const FIELD_CHARS = 2000;

// ─── Reading logs ───

/** A small CSV reader: quoted fields, and commas and line breaks inside quotes. Returns { head, rows }. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim());
  return { head, rows: rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) };
}

function readLog(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_LOG_BYTES) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (/\.jsonl$/i.test(file)) {
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o);
      } catch {}
    }
    return { head: rows.length ? Object.keys(rows[0]) : [], rows };
  }
  return parseCsv(text);
}

const ID_COLUMNS = ['file', 'path', 'asset', 'id', 'name'];

// ─── Finding files ───

function walk(dir, exts, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_ITEMS) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => byName(a.name, b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue; // a link could point anywhere: left out
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, depth + 1, out);
    else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase()) && out.length < MAX_ITEMS) out.push(full);
  }
}

function subfolders(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(byName);
  } catch {
    return [];
  }
}

function directFiles(dir, exts) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && exts.includes(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort(byName);
  } catch {
    return [];
  }
}

/**
 * Reads the project. Returns:
 *   roots     the real paths of the configured folders that exist: the only places media is served from
 *   sections  [{ title, kind, folder, items: [{ id, name, file, caption? }] }]
 *   context   (id) => what is known about a file the project holds, or null
 *   stats     counts, with the log rows that matched nothing
 */
export function scanProject(config) {
  const rootReal = realPath(config.root) || config.root;
  const roots = [];
  const sections = [];
  const missing = [];
  const add = (title, kind, folder, files, base) => {
    const items = files.map((file) => {
      const rel = toPosix(path.relative(base, file));
      return { id: `${title}/${rel}`, name: rel.replace(/\.[^./]+$/, ''), file };
    });
    sections.push({ title, kind, folder, items });
  };
  for (const s of config.sections) {
    const real = realPath(s.folder);
    if (!real || !fs.statSync(real).isDirectory()) {
      missing.push(s.folder);
      sections.push({ title: s.title, kind: s.kind, folder: s.folder, items: [], missing: true });
      continue;
    }
    if (!roots.includes(real)) roots.push(real);
    const exts = extensionsFor(s.kind);
    if (s.split) {
      const here = directFiles(real, exts);
      if (here.length) add(s.title, s.kind, real, here, real);
      for (const sub of subfolders(real)) {
        const found = [];
        walk(path.join(real, sub), exts, 1, found);
        if (found.length) add(`${s.title}: ${sub}`, s.kind, path.join(real, sub), found, path.join(real, sub));
      }
      if (!sections.some((x) => x.title === s.title || x.title.startsWith(`${s.title}: `))) sections.push({ title: s.title, kind: s.kind, folder: real, items: [] });
    } else {
      const found = [];
      walk(real, exts, 0, found);
      add(s.title, s.kind, real, found, real);
    }
  }

  // An id has to name one thing. Two sections that reach the same file under the same id keep the first.
  const byId = new Map();
  const byFile = new Map();
  for (const s of sections) {
    s.items = s.items.filter((it) => {
      if (byId.has(it.id)) return false;
      byId.set(it.id, { ...it, section: s.title, kind: s.kind });
      if (!byFile.has(it.file)) byFile.set(it.file, it.id);
      return true;
    });
  }

  // How each thing was made, from the game's own logs. A row is matched to a file by the value in its id
  // column: a path from the game's root or from the log's own folder, an item id, a file name, or a file
  // name without its extension. A row that matches nothing, or more than one file, is counted, not guessed at.
  const byBase = new Map();
  const byStem = new Map();
  const push = (map, key, id) => map.set(key, [...(map.get(key) || []), id]);
  for (const [id, it] of byId) {
    push(byBase, path.basename(it.file), id);
    push(byStem, path.basename(it.file, path.extname(it.file)), id);
  }
  const made = new Map(); // id -> [{ log, ...row }]
  const logStats = [];
  for (const log of config.logs) {
    const rel = toPosix(path.relative(config.root, log.file));
    const stat = { log: rel, rows: 0, matched: 0, unmatched: 0, ambiguous: 0 };
    logStats.push(stat);
    let parsed = null;
    try {
      parsed = readLog(log.file);
    } catch {}
    if (!parsed) {
      stat.problem = 'not found, not a file, or larger than 5 MB';
      continue;
    }
    const column = log.id || ID_COLUMNS.find((c) => parsed.head.includes(c));
    if (!column || !parsed.head.includes(column)) {
      stat.problem = `no "${log.id || ID_COLUMNS.join('", "')}" column`;
      continue;
    }
    for (const row of parsed.rows) {
      stat.rows++;
      const value = String(row[column] ?? '').trim();
      if (!value) {
        stat.unmatched++;
        continue;
      }
      let id = null;
      for (const candidate of [path.resolve(config.root, value), path.resolve(path.dirname(log.file), value)]) {
        const real = realPath(candidate);
        if (real && byFile.has(real)) id = byFile.get(real);
        if (id) break;
      }
      if (!id && byId.has(value)) id = value;
      if (!id) {
        const hits = byBase.get(value) || byStem.get(value) || [];
        if (hits.length === 1) id = hits[0];
        else if (hits.length > 1) {
          stat.ambiguous++;
          continue;
        }
      }
      if (!id) {
        stat.unmatched++;
        continue;
      }
      stat.matched++;
      const entry = { log: rel };
      for (const [k, v] of Object.entries(row)) {
        if (v == null || v === '') continue;
        entry[k] = typeof v === 'string' ? v.slice(0, FIELD_CHARS) : v;
      }
      // A prompt kept in its own file: read only if it is a small text file inside the game's folder.
      if (log.prompt_file && typeof row[log.prompt_file] === 'string' && row[log.prompt_file].trim()) {
        const text = readPrompt(rootReal, [path.resolve(path.dirname(log.file), row[log.prompt_file]), path.resolve(config.root, row[log.prompt_file])]);
        if (text != null) entry.prompt = text;
      }
      const list = made.get(id) || [];
      // The last row for a thing in one log is the one kept; earlier rows are counted.
      const earlier = list.findIndex((m) => m.log === rel);
      if (earlier >= 0) {
        entry.earlier_rows = (list[earlier].earlier_rows || 0) + 1;
        list.splice(earlier, 1);
      }
      list.push(entry);
      made.set(id, list);
      if (log.caption && typeof row[log.caption] === 'string' && row[log.caption].trim()) {
        const it = byId.get(id);
        it.caption = row[log.caption].trim().slice(0, 200);
        const inSection = sections.find((s) => s.title === it.section)?.items.find((x) => x.id === id);
        if (inSection) inSection.caption = it.caption;
      }
    }
  }

  return {
    name: config.name,
    root: rootReal,
    roots,
    sections,
    missing,
    has: (id) => byId.has(id),
    item: (id) => byId.get(id) || null,
    idOfFile: (file) => byFile.get(file) || null,
    context(id) {
      const it = byId.get(id);
      if (!it) return null;
      const out = { section: it.section, kind: it.kind, file: it.file };
      if (it.caption) out.caption = it.caption;
      if (made.has(id)) out.made = made.get(id);
      return out;
    },
    stats: { sections: sections.length, items: byId.size, logs: logStats },
  };
}

function readPrompt(rootReal, candidates) {
  for (const candidate of candidates) {
    const real = realPath(candidate);
    if (!real || !isInside(rootReal, real) || !PROMPT_EXT.includes(path.extname(real).toLowerCase())) continue;
    try {
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) continue;
      return fs.readFileSync(real, 'utf8').slice(0, FIELD_CHARS);
    } catch {}
  }
  return null;
}

/** A project that is scanned again when asked after `ms`, so new files show without a restart. */
export function liveProject(config, { ms = 1500 } = {}) {
  let last = null;
  let at = 0;
  return {
    get() {
      const now = Date.now();
      if (!last || now - at > ms) {
        last = scanProject(config);
        at = now;
      }
      return last;
    },
    fresh() {
      last = scanProject(config);
      at = Date.now();
      return last;
    },
  };
}

/**
 * The real path of a picture or sound inside one of the project's media folders, or null.
 * This is the only gate media passes: the page's files and the files an agent posts both go through it.
 */
export function allowedMedia(roots, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  const real = realPath(file);
  if (!real || !MEDIA[path.extname(real).toLowerCase()]) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return roots.some((r) => isInside(r, real) && real !== r) ? real : null;
}
