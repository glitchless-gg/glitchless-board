// `glitchless-board init`: writes glitchless.board.json for the game in this folder, then shows, for Claude
// Code, Codex and Cursor, exactly what would be added to that harness so it can reach the board.
//
// It changes a harness only when asked with that harness's flag. What it prints and what it writes come from
// the same data (harnessPlans), so the two cannot drift apart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, DEFAULT_PORT, SERVER_NAME, extensionsFor, loadConfig } from './config.js';
import { Problem, byName, readJson, titleFrom, toPosix, writeFileAtomic } from './util.js';

// ─── Guessing sections from what the folder holds ───

const SKIP = new Set(['node_modules', 'build', 'builds', 'dist', 'out', 'bin', 'obj', 'target', 'library', 'temp', 'logs', 'intermediate', 'saved', 'binaries', 'deriveddatacache', 'vendor', 'third_party', 'addons', 'packages']);
const CAPTURES = /^(screen ?shots?|captures?|shots|screens)$/i;
const MAX_DEPTH = 6;
const MAX_SECTIONS = 24;

function survey(dir, depth, budget) {
  const node = { dir, pictures: 0, sounds: 0, direct: 0, children: [] };
  if (depth > MAX_DEPTH || budget.left <= 0) return node;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    budget.left--;
    if (e.isDirectory()) {
      if (SKIP.has(e.name.toLowerCase())) continue;
      const child = survey(path.join(dir, e.name), depth + 1, budget);
      if (child.pictures + child.sounds) node.children.push(child);
      node.pictures += child.pictures;
      node.sounds += child.sounds;
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      const kind = extensionsFor('pictures').includes(ext) ? 'pictures' : extensionsFor('sounds').includes(ext) ? 'sounds' : null;
      if (kind) {
        node[kind]++;
        node.direct++;
      }
    }
  }
  return node;
}

/** Sections for the folder: one for each highest folder that holds only pictures or only sounds. */
export function planSections(root) {
  const found = [];
  const add = (node, kind) => {
    const rel = toPosix(path.relative(root, node.dir)) || '.';
    const captures = kind === 'pictures' && rel.split('/').some((part) => CAPTURES.test(part.replace(/[_-]/g, ' ')));
    // A folder with nothing of its own and several folders inside reads better as one section per folder.
    const split = !node.direct && node.children.length > 1;
    found.push({ rel, kind: captures ? 'captures' : kind, count: node[kind], split });
  };
  const plan = (node) => {
    if (!node.pictures && !node.sounds) return;
    const one = !node.pictures || !node.sounds;
    if ((one && node.dir !== root) || node.direct) {
      // docs/ holding only docs/screenshots/ is better named by the folder the files are in.
      while (!node.direct && node.children.length === 1) node = node.children[0];
      if (node.pictures) add(node, 'pictures');
      if (node.sounds) add(node, 'sounds');
      return;
    }
    node.children.forEach(plan);
  };
  plan(survey(root, 0, { left: 50000 }));
  const kept = found.length > MAX_SECTIONS ? [...found].sort((a, b) => b.count - a.count).slice(0, MAX_SECTIONS) : found;
  const names = new Map();
  for (const f of kept) {
    const base = f.rel === '.' ? (f.kind === 'sounds' ? 'Sounds' : 'Pictures') : titleFrom(path.posix.basename(f.rel));
    names.set(base.toLowerCase(), (names.get(base.toLowerCase()) || 0) + 1);
    f.base = base;
  }
  const used = new Set();
  const sections = found
    .filter((f) => kept.includes(f))
    .map((f) => {
      let title = names.get(f.base.toLowerCase()) > 1 && f.rel !== '.' ? titleFrom(f.rel.split('/').join(' ')) : f.base;
      if (used.has(title.toLowerCase())) title = `${title} ${f.kind}`;
      used.add(title.toLowerCase());
      return { title, kind: f.kind, folder: f.rel, ...(f.split ? { split: 'subfolders' } : {}) };
    });
  return { sections, left_out: found.length - kept.length };
}

// ─── What each harness needs ───

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Adds `more` into `base`: objects merge, lists gain the entries they lack, anything else is replaced. */
export function mergeInto(base, more) {
  const out = isObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(more)) {
    if (isObject(v)) out[k] = mergeInto(out[k], v);
    else if (Array.isArray(v)) out[k] = [...(Array.isArray(out[k]) ? out[k] : []), ...v.filter((x) => !(Array.isArray(out[k]) ? out[k] : []).includes(x))];
    else out[k] = v;
  }
  return out;
}

const jsonStep = (file, merge) => ({
  file,
  show: JSON.stringify(merge, null, 2),
  apply() {
    const before = readJson(file, {});
    if (!isObject(before)) throw new Problem(`${file} does not hold a JSON object, so it was left alone.`);
    const after = mergeInto(before, merge);
    if (JSON.stringify(after) === JSON.stringify(before)) return 'already there';
    writeFileAtomic(file, `${JSON.stringify(after, null, 2)}\n`);
    return 'written';
  },
});

/** A TOML table of plain string values, added to a file or brought up to date in it. Nothing else in the file is touched. */
const tomlStep = (file, table, values) => {
  const lines = Object.entries(values).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return {
    file,
    show: `[${table}]\n${lines.join('\n')}`,
    apply() {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const all = text.split('\n');
      const head = all.findIndex((l) => l.trim() === `[${table}]`);
      if (head < 0) {
        writeFileAtomic(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}[${table}]\n${lines.join('\n')}\n`);
        return 'written';
      }
      let end = all.findIndex((l, i) => i > head && /^\s*\[/.test(l));
      if (end < 0) end = all.length;
      let changed = false;
      for (const [k, v] of Object.entries(values)) {
        const want = `${k} = ${JSON.stringify(v)}`;
        const at = all.findIndex((l, i) => i > head && i < end && new RegExp(`^\\s*${k}\\s*=`).test(l));
        if (at < 0) {
          all.splice(head + 1, 0, want);
          end++;
          changed = true;
        } else if (all[at].trim() !== want) {
          all[at] = want;
          changed = true;
        }
      }
      if (!changed) return 'already there';
      writeFileAtomic(file, all.join('\n'));
      return 'written';
    },
  };
};

/**
 * What each harness needs to reach the board at this port: the files, what goes into each, and what the owner
 * still does by hand. `home` and `codexHome` are where the harnesses keep their own settings.
 */
export function harnessPlans({ root, port, home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex') }) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const toml = { url, default_tools_approval_mode: 'approve' };
  return [
    {
      flag: 'claude',
      name: 'Claude Code',
      scope: 'this project only',
      steps: [
        jsonStep(path.join(root, '.mcp.json'), { mcpServers: { [SERVER_NAME]: { type: 'http', url } } }),
        jsonStep(path.join(root, '.claude', 'settings.local.json'), {
          enabledMcpjsonServers: [SERVER_NAME],
          permissions: { allow: [`mcp__${SERVER_NAME}__*`, 'Bash(npx -y glitchless-board wait *)', 'Bash(glitchless-board wait *)'] },
        }),
      ],
      why: ['The first file is the server. The second approves it for this folder, and allows its tools and the wait command without a prompt each time.'],
      then: [],
    },
    {
      flag: 'codex',
      name: 'Codex',
      scope: 'this project only; Codex reads it once it trusts the folder',
      steps: [tomlStep(path.join(root, '.codex', 'config.toml'), `mcp_servers.${SERVER_NAME}`, toml)],
      why: ['"approve" lets a thread use the board\'s tools when nobody is there to approve each call.'],
      then: [],
    },
    {
      flag: 'codex-global',
      name: 'Codex, for every project',
      scope: "Codex's own settings: every Codex session on this computer",
      steps: [tomlStep(path.join(codexHome, 'config.toml'), `mcp_servers.${SERVER_NAME}`, toml)],
      why: ['Use this one if the project file is not picked up. One saved address serves one board, so two games need two ports and an entry each.'],
      then: [`To undo it: codex mcp remove ${SERVER_NAME}`],
    },
    {
      flag: 'cursor',
      name: 'Cursor (command line)',
      scope: 'this project only',
      steps: [jsonStep(path.join(root, '.cursor', 'mcp.json'), { mcpServers: { [SERVER_NAME]: { url } } }), jsonStep(path.join(root, '.cursor', 'cli.json'), { permissions: { allow: [`Mcp(${SERVER_NAME}:*)`], deny: [] } })],
      why: ["The first file is the server. The second allows its tools and nothing else, so a run with nobody watching doesn't reject them."],
      then: [`Then approve the server for this folder yourself: cursor-agent mcp enable ${SERVER_NAME}`],
    },
    {
      flag: 'cursor-app',
      name: 'Cursor (the app)',
      scope: "Cursor's own settings: every Cursor window on this computer",
      steps: [jsonStep(path.join(home, '.cursor', 'mcp.json'), { mcpServers: { [SERVER_NAME]: { url } } })],
      why: ["The app did not read the project's file when this was tried, so it needs the entry in its own settings."],
      then: [],
    },
  ];
}

export const HARNESS_FLAGS = ['claude', 'codex', 'codex-global', 'cursor', 'cursor-app'];

// ─── init ───

/**
 * Writes the config if there is none (or `force`), prints every harness's setup, and applies the ones named in
 * `apply` (a list of flags). Returns { file, wrote, config, applied }.
 */
export function initProject(dir, { name, port, force = false, apply = [], home, codexHome, log = console.log } = {}) {
  const root = path.resolve(dir);
  const file = path.join(root, CONFIG_FILE);
  const unknown = apply.filter((f) => !HARNESS_FLAGS.includes(f));
  if (unknown.length) throw new Problem(`Unknown harness: ${unknown.join(', ')}. The flags are ${HARNESS_FLAGS.map((f) => `--${f}`).join(', ')}.`);
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Problem('--port should be a whole number from 1 to 65535.');

  let wrote = false;
  if (!fs.existsSync(file) || force) {
    const { sections, left_out: leftOut } = planSections(root);
    const body = { name: name || titleFrom(path.basename(root)), port: port || DEFAULT_PORT, sections, logs: [] };
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    wrote = true;
    log(`Wrote ${file}`);
    if (sections.length) {
      for (const s of sections) log(`  ${s.title}: ${s.kind} in ${s.folder}${s.split ? ', one section per folder inside' : ''}`);
      if (leftOut) log(`  ${leftOut} more folders hold pictures or sounds. The largest ${MAX_SECTIONS} were kept; add others by hand.`);
    } else {
      log('  No pictures or sounds were found here, so it has no sections yet. Add them by hand, for example:');
      log('  "sections": [{ "title": "Characters", "kind": "pictures", "folder": "art/characters" }]');
    }
    log('  Kinds are pictures, captures and sounds. "logs" can name a .csv or .jsonl that says how each file was made.');
    log('  Add .glitchless/ to .gitignore: the board keeps its record there.');
  } else {
    log(`${file} is already there: kept as it is. (--force writes a new one.)`);
  }
  const config = loadConfig(file);
  if (port && config.port !== port) log(`  Its port is ${config.port}. To change it, edit "port" in that file; --port only sets it in a new one.`);

  const plans = harnessPlans({ root, port: config.port, home, codexHome });
  const rel = (f) => (f.startsWith(root + path.sep) ? toPosix(path.relative(root, f)) : f);
  const applied = [];
  log('');
  log(`To use the board, a harness needs its address saved once: http://127.0.0.1:${config.port}/mcp`);
  log(apply.length ? 'Applying what you asked for; the rest is only shown.' : 'Nothing below has been changed. To apply one, run init again with its flag.');
  for (const plan of plans) {
    const on = apply.includes(plan.flag);
    log('');
    log(`${plan.name}  (--${plan.flag}: ${plan.scope})`);
    for (const step of plan.steps) {
      let result = null;
      if (on) {
        result = step.apply();
        applied.push({ harness: plan.flag, file: step.file, result });
      }
      log(`  ${rel(step.file)}${result ? `  [${result}]` : ''}`);
      for (const line of step.show.split('\n')) log(`      ${line}`);
    }
    for (const line of [...plan.why, ...plan.then]) log(`  ${line}`);
  }
  log('');
  log('Start the board with: glitchless-board serve');
  log('Then restart the harness, so it reads the new server. A running app does not see a server added after it started.');
  log('Use a local session. A cloud session runs on another machine and cannot reach a board on this computer.');
  return { file, wrote, config, applied };
}
