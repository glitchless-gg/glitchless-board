// The glitchless-board command, run as a separate process the way an agent or a person runs it.
// Home folders are scratch folders, and the Codex hooks point nowhere real.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, cleanUp, scratch } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'glitchless-board.js');
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
const home = scratch('home');
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), GLITCHLESS_BOARD_CODEX: path.join(home, 'no-codex-here'), GLITCHLESS_BOARD_CODEX_SOCKET: '', GLITCHLESS_BOARD_RECORD: '' };
const children = [];

after(() => {
  for (const c of children) c.kill();
  cleanUp();
});

const cli = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
const cliAsync = (cwd, ...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Starts `serve` in dir and resolves with the child once it says it is up. */
function startBoard(dir, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'serve', ...args], { cwd: dir, env });
    children.push(child);
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      if (/Record: /.test(out)) resolve({ child, out: () => out });
    });
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => reject(new Error(`serve ended with ${code}: ${out}`)));
  });
}

test('version, help and exit codes', () => {
  const dir = scratch('cli');
  assert.equal(cli(dir, '--version').stdout.trim(), `glitchless-board ${PKG.version}`);
  const none = cli(dir);
  assert.equal(none.status, 2);
  assert.match(none.stdout, /wait \[--as NAME\]/);
  assert.equal(cli(dir, 'help').status, 0);
  assert.equal(cli(dir, 'nonsense').status, 2);
  assert.match(cli(dir, 'skill').stdout, /^---\nname: glitchless-board\n/);
  assert.match(cli(dir, 'guide').stdout, /^# glitchless-board/);
  const noConfig = cli(dir, 'status');
  assert.equal(noConfig.status, 2);
  assert.match(noConfig.stderr, /No glitchless\.board\.json/);
  assert.match(cli(dir, 'wait', '--timeout', 'soon').stderr, /--timeout needs a number/);
});

test('sample writes a game, and refuses a folder that already holds something', () => {
  const dir = scratch('cli');
  const made = cli(dir, 'sample', 'my-game', '--port', '4760');
  assert.equal(made.status, 0);
  assert.match(made.stdout, /cd my-game/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'my-game', 'glitchless.board.json'), 'utf8')).port, 4760);
  assert.ok(fs.statSync(path.join(dir, 'my-game', 'audio', 'sfx', 'jump.wav')).size > 1000);
  const again = cli(dir, 'sample', 'my-game');
  assert.equal(again.status, 2);
  assert.match(again.stderr, /is not empty/);
});

test('init from the command line shows every harness and changes none without a flag', () => {
  const dir = scratch('cli');
  cli(dir, 'sample', 'game');
  const game = path.join(dir, 'game');
  fs.rmSync(path.join(game, 'glitchless.board.json'));
  const shown = cli(game, 'init', '--name', 'CLI Game', '--port', '4760');
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /Nothing below has been changed/);
  assert.match(shown.stdout, /http:\/\/127\.0\.0\.1:4760\/mcp/);
  assert.match(shown.stdout, /restart the harness[\s\S]*local session/);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(fs.existsSync(path.join(game, '.mcp.json')), false);
  // With flags, as JSON: only those harnesses, and the global one lands in the pretend home.
  const applied = cli(game, 'init', '--cursor', '--codex-global', '--json');
  assert.equal(applied.status, 0);
  const result = JSON.parse(applied.stdout);
  assert.deepEqual(result.applied.map((a) => [a.harness, a.result]), [['codex-global', 'written'], ['cursor', 'written'], ['cursor', 'written']]);
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.glitchless_board\]\nurl = "http:\/\/127\.0\.0\.1:4760\/mcp"/);
  assert.equal(fs.existsSync(path.join(game, '.cursor', 'cli.json')), true);
  assert.equal(fs.existsSync(path.join(game, '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.cursor')), false);
});

test('serve, status and wait: the wait command ends when a verdict arrives', async () => {
  const dir = scratch('cli');
  const port = await freePort();
  cli(dir, 'sample', 'game', '--port', String(port));
  const game = path.join(dir, 'game');

  // No board yet.
  const down = cli(game, 'wait', '--as', 'claude', '--timeout', '1');
  assert.equal(down.status, 2);
  assert.match(down.stderr, new RegExp(`No board is answering on port ${port}`));
  assert.equal(cli(game, 'status').status, 2);

  const board = await startBoard(game);
  assert.match(board.out(), new RegExp(`Glitchless Board for Sample Game: http://127\\.0\\.0\\.1:${port}/`));
  assert.match(board.out(), /15 items in 5 sections/);
  assert.match(board.out(), /Log art\/log\.csv: 7 of 7 rows matched a file/);
  assert.equal(fs.existsSync(path.join(game, '.glitchless', 'board', 'server.json')), true);

  // From a folder inside the game, too.
  const status = JSON.parse(cli(path.join(game, 'art', 'tiles'), 'status', '--json').stdout);
  assert.deepEqual([status.running, status.project, status.waiting, status.keep, status.redo, status.send_to_codex], [true, 'Sample Game', 15, 0, 0, false]);

  // Nothing to tell: exit 3.
  const quiet = cli(game, 'wait', '--as', 'claude', '--timeout', '1', '--settle', '0');
  assert.equal(quiet.status, 3);
  assert.equal(JSON.parse(quiet.stdout).timed_out, true);

  // A click on the page ends a wait that is already running: exit 0, with the verdict as JSON.
  const waiting = cliAsync(game, 'wait', '--as', 'Claude', '--timeout', '30', '--settle', '0');
  for (let i = 0; i < 100; i++) {
    if ((await call(port, '/api/state')).json().waiting.includes('claude')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const token = /"token":"([0-9a-f]+)"/.exec((await call(port, '/')).text)[1];
  const click = await call(port, '/api/verdict', { method: 'POST', body: JSON.stringify({ item: 'Sound effects/jump.wav', v: 'redo', note: 'shorter' }), headers: { 'x-board-owner': token, 'content-type': 'application/json' } });
  assert.deepEqual(click.json().waiting, ['claude']);
  const woke = await waiting;
  assert.equal(woke.status, 0);
  const body = JSON.parse(woke.stdout);
  assert.deepEqual([body.as, body.verdicts[0].item, body.verdicts[0].verdict, body.verdicts[0].note, body.verdicts[0].door], ['claude', 'Sound effects/jump.wav', 'redo', 'shorter', 'page']);
  assert.equal(body.verdicts[0].context.made[0].what, 'A rising blip for a jump');

  // One board per record: a second serve and an adopt are both turned away while it runs.
  const second = cli(game, 'serve', '--port', String(await freePort()));
  assert.equal(second.status, 2);
  assert.match(second.stderr, /A board is already running for this project/);
  const adopt = cli(game, 'adopt', '--thread', '019a0000-1111-7222-8333-444455556666');
  assert.equal(adopt.status, 2);
  assert.match(adopt.stderr, /Stop the board first/);

  // Stopping it leaves the record, and lets adopt write to it.
  board.child.removeAllListeners('close');
  const closed = new Promise((resolve) => board.child.once('close', resolve));
  board.child.kill('SIGTERM');
  await closed;
  assert.equal(fs.existsSync(path.join(game, '.glitchless', 'board', 'server.json')), false);
  const lines = fs.readFileSync(path.join(game, '.glitchless', 'board', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.seq, e.type, e.door]), [[1, 'verdict', 'page']]);
  const adopted = cli(game, 'adopt', '--thread', '019a0000-1111-7222-8333-444455556666', '--item', 'Sound effects/jump.wav');
  assert.equal(adopted.status, 0);
  assert.match(adopted.stdout, /made Sound effects\/jump\.wav/);
  // The game's own folders were only read.
  assert.deepEqual(fs.readdirSync(game).sort(), ['.gitignore', '.glitchless', 'art', 'audio', 'captures', 'glitchless.board.json']);
});

test('codex probe says so when there is no Codex', () => {
  const dir = scratch('cli');
  const r = cli(dir, 'codex', 'probe');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /codex command is not installed/);
  assert.equal(cli(dir, 'codex', 'start').status, 2);
});
