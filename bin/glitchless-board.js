#!/usr/bin/env node
// glitchless-board: one small local board per game project, where your coding agents meet.
//
//   glitchless-board init                 # once per game: writes glitchless.board.json, shows each harness's setup
//   glitchless-board serve                # the page, and MCP for agents, on 127.0.0.1
//   glitchless-board wait --as claude     # blocks until a verdict or a message arrives, prints it, exits

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as board from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const HELP = `glitchless-board ${PKG.version}: one board per game, where your coding agents meet.

Set up
  init [--name N] [--port P]     write glitchless.board.json for the game in this folder, then show what
                                 each harness needs to reach the board. Nothing in a harness changes unless
                                 you add its flag:
    --claude                       Claude Code, this project (.mcp.json, .claude/settings.local.json)
    --codex                        Codex, this project (.codex/config.toml)
    --codex-global                 Codex, every project (its own config.toml)
    --cursor                       Cursor's command line, this project (.cursor/mcp.json, .cursor/cli.json)
    --cursor-app                   the Cursor app (its own mcp.json)
    --force                        write a new glitchless.board.json over the one that is there
  sample [folder]                write a small made-up game to try the board on (default: ./sample-game)

Run
  serve [--port P]               the board: its page, and MCP for agents at /mcp. It answers this computer only
    --codex-send                   turn on the Send to Codex button (each press spends one Codex turn)
    --send-via queue               always send through Codex's own queue
  wait [--as NAME]               block until the owner gives a verdict or an agent leaves NAME a message,
                                 print it as JSON, and exit. Run it in the background to be woken
    --timeout S                    give up after S seconds (default 3600)
    --settle S                     seconds of quiet to wait for, so a burst of clicks arrives together (default 2)
    --since SEQ                    hear again everything after record line SEQ
  status                         is the board running, what is waiting, who is waiting

Send to Codex (optional)
  adopt --thread ID [--item ID]  tell the board about a Codex thread you started, and the item it made.
                                 Run it while the board is stopped
  codex probe                    can the board reach Codex's daemon (read-only, spends nothing)

Other
  prompt                         print the set-up prompt to paste into your coding agent
  skill [--install]              print the agent skill, or copy it where Claude Code, Codex and Cursor look
  guide                          the full reference (README)
  --port P                       the board's port, when it is not the one in glitchless.board.json
  --json                         print results as JSON

Run these in the game's folder (where glitchless.board.json is), or anywhere inside it.
Exit codes: 0 done, 3 a wait timed out with nothing, 2 something went wrong (or no board is running).`;

const VALUED = ['name', 'port', 'as', 'timeout', 'settle', 'since', 'thread', 'item', 'send-via', 'record'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq < 0 ? undefined : eq);
      if (eq >= 0) out[key] = a.slice(eq + 1);
      else if (VALUED.includes(key) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
      else out[key] = true;
    } else if (a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const SKILL_HOMES = ['.claude', '.codex', '.cursor'].map((d) => path.join(os.homedir(), d, 'skills'));

function skill(install, log) {
  const text = fs.readFileSync(path.join(HERE, '..', 'SKILL.md'), 'utf8');
  if (!install) return log(text);
  let wrote = 0;
  for (const home of SKILL_HOMES) {
    if (!fs.existsSync(home)) continue;
    fs.mkdirSync(path.join(home, 'glitchless-board'), { recursive: true });
    fs.writeFileSync(path.join(home, 'glitchless-board', 'SKILL.md'), text);
    log(`Skill: ${path.join(home, 'glitchless-board', 'SKILL.md')}`);
    wrote++;
  }
  if (!wrote) log(`No skills folder found (${SKILL_HOMES.join(', ')}). Copy SKILL.md wherever your agent reads skills: glitchless-board skill > SKILL.md`);
}

const number = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value === true || !Number.isFinite(n)) throw new board.Problem(`--${name} needs a number.`);
  return n;
};

async function main(argv) {
  const o = parseArgs(argv);
  const [command, ...rest] = o._;
  const json = !!o.json;
  // With --json, progress goes to stderr and the result alone to stdout.
  const log = json ? (m) => process.stderr.write(`${m}\n`) : (m) => console.log(m);
  const show = (result, text) => (json ? console.log(JSON.stringify(result, null, 2)) : text && console.log(text));
  const port = number(o.port, 'port');
  const config = () => board.loadConfig(process.cwd(), { port, record: typeof o.record === 'string' ? o.record : undefined });
  if (o.version || command === 'version') return console.log(`glitchless-board ${PKG.version}`), 0;
  if (!command || o.help || command === 'help') return console.log(HELP), command || o.help ? 0 : 2;

  switch (command) {
    case 'init': {
      const r = board.initProject(process.cwd(), { name: typeof o.name === 'string' ? o.name : undefined, port, force: !!o.force, apply: board.HARNESS_FLAGS.filter((f) => o[f]), log });
      show({ file: r.file, wrote: r.wrote, port: r.config.port, sections: r.config.sections.map((s) => s.title), applied: r.applied });
      return 0;
    }
    case 'sample': {
      const dir = board.writeSample(rest[0] || 'sample-game', { port });
      const rel = path.relative(process.cwd(), dir);
      show({ folder: dir }, `Wrote a sample game to ${dir}\nTry it:\n  cd ${rel && !rel.startsWith('..') ? rel : dir}\n  glitchless-board serve`);
      return 0;
    }
    case 'serve': {
      const via = o['send-via'];
      if (via !== undefined && via !== 'queue' && via !== 'auto') throw new board.Problem('--send-via is "queue" or "auto".');
      const made = await board.startServer({ dir: process.cwd(), port, record: typeof o.record === 'string' ? o.record : undefined, codexOn: o['codex-send'] ? true : undefined, sendVia: via, log });
      const stop = () => made.close().then(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return null;
    }
    case 'wait': {
      const asked = { timeout: number(o.timeout, 'timeout') ?? 3600, settle: number(o.settle, 'settle') ?? 2, since: number(o.since, 'since') };
      const r = await board.waitOnBoard({ port: config().port, as: typeof o.as === 'string' ? o.as : 'agent', ...asked });
      if (r.body) console.log(JSON.stringify(r.body, null, 2));
      else console.error(r.message);
      return r.code;
    }
    case 'status': {
      const c = config();
      const s = await board.boardStatus(c.port);
      if (!s) {
        show({ running: false, port: c.port }, `No board is answering on port ${c.port}. Start it here with: glitchless-board serve`);
        return 2;
      }
      show(
        { running: true, ...s },
        [
          `${s.project}: ${s.url}  (MCP ${s.mcp})`,
          `${s.waiting} waiting for a verdict, ${s.keep} kept, ${s.redo} to redo, in ${s.sections} sections.`,
          s.agents_waiting.length ? `Waiting on the board now: ${s.agents_waiting.join(', ')}` : 'No agent is waiting. Verdicts are held for the next one that asks.',
          ...s.problems,
        ].join('\n'),
      );
      return 0;
    }
    case 'adopt': {
      const c = config();
      const running = board.servingNow(c.stateDir);
      if (running && (await board.isBoard(running.port, running.pid))) throw new board.Problem(`Stop the board first (process ${running.pid}). adopt writes to its record, which a running board holds in memory.`);
      const r = board.adoptThread(c, { thread: typeof o.thread === 'string' ? o.thread : undefined, item: typeof o.item === 'string' ? o.item : undefined, name: typeof o.name === 'string' ? o.name : undefined });
      show(r, `The board now knows that Codex thread${r.item ? `, and that it made ${r.item}` : ''}. Start the board with --codex-send to get the Send to Codex button.`);
      return 0;
    }
    case 'codex': {
      if (rest[0] !== 'probe') throw new board.Problem('The only codex command is: glitchless-board codex probe');
      const { probe } = await import('../src/codex.js');
      const r = await probe();
      show(r, `Reached Codex's daemon. It lists ${r.threads_on_first_page} threads on its first page. Nothing was sent.`);
      return 0;
    }
    case 'prompt':
      console.log(board.setupPrompt());
      return 0;
    case 'skill':
      skill(!!o.install, log);
      return 0;
    case 'guide':
      console.log(fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8'));
      return 0;
    default:
      console.log(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code != null) process.exitCode = code;
  },
  (err) => {
    if (err instanceof board.Problem) console.error(err.message);
    else console.error(`glitchless-board: ${err.stack || err.message}`);
    process.exitCode = 2;
  },
);
