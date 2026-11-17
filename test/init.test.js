import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harnessPlans, initProject, loadConfig, planSections, scanProject } from '../src/index.js';
import { cleanUp, sampleGame, scratch } from './helpers.js';

after(cleanUp);

/** A game folder with no config yet, a pretend home folder, and what init printed. */
function fresh() {
  const game = sampleGame();
  fs.rmSync(path.join(game, 'glitchless.board.json'));
  const home = scratch('home');
  const lines = [];
  const init = (options = {}) => initProject(game, { home, codexHome: path.join(home, '.codex'), log: (m) => lines.push(m), ...options });
  return { game, home, lines, init, text: () => lines.join('\n') };
}

const filesUnder = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('init writes a config from what the folder holds', () => {
  const { game, init } = fresh();
  const r = init({ name: 'Test Game' });
  assert.equal(r.wrote, true);
  const written = read(path.join(game, 'glitchless.board.json'));
  assert.deepEqual(written, {
    name: 'Test Game',
    port: 8792,
    sections: [
      { title: 'Art', kind: 'pictures', folder: 'art', split: 'subfolders' },
      { title: 'Audio', kind: 'sounds', folder: 'audio', split: 'subfolders' },
      { title: 'Captures', kind: 'captures', folder: 'captures' },
    ],
    logs: [],
  });
  // The config it wrote loads, and finds the files.
  const scan = scanProject(loadConfig(game));
  assert.deepEqual(scan.sections.map((s) => [s.title, s.kind, s.items.length]), [['Art: characters', 'pictures', 5], ['Art: tiles', 'pictures', 3], ['Audio: music', 'sounds', 1], ['Audio: sfx', 'sounds', 4], ['Captures', 'captures', 2]]);
  assert.equal(scan.item('Art: characters/knight.png').file, path.join(game, 'art', 'characters', 'knight.png'));
});

test('sections are guessed sensibly, and build folders are left out', () => {
  const game = scratch('plan');
  const png = (rel) => {
    fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
    fs.writeFileSync(path.join(game, rel), 'x');
  };
  ['assets/sprites/player.png', 'assets/sprites/boss.png', 'assets/sfx/hit.wav', 'docs/screenshots/menu.jpg', 'node_modules/pkg/logo.png', 'build/icon.png', '.hidden/a.png', 'cover.png'].forEach(png);
  assert.deepEqual(planSections(game).sections, [
    { title: 'Pictures', kind: 'pictures', folder: '.' },
    { title: 'Sounds', kind: 'sounds', folder: '.' },
  ]);
  fs.rmSync(path.join(game, 'cover.png'));
  assert.deepEqual(planSections(game).sections, [
    { title: 'Sfx', kind: 'sounds', folder: 'assets/sfx' },
    { title: 'Sprites', kind: 'pictures', folder: 'assets/sprites' },
    { title: 'Screenshots', kind: 'captures', folder: 'docs/screenshots' },
  ]);
  assert.deepEqual(planSections(scratch('empty')).sections, []);
});

test('without a flag, init changes no harness: it only shows what each needs', () => {
  const { game, home, init, text } = fresh();
  const before = filesUnder(game);
  const r = init();
  assert.deepEqual(r.applied, []);
  assert.deepEqual(filesUnder(home), []);
  assert.deepEqual(filesUnder(game), [...before, 'glitchless.board.json'].sort());
  const out = text();
  assert.match(out, /Nothing below has been changed/);
  for (const flag of ['--claude', '--codex', '--codex-global', '--cursor', '--cursor-app']) assert.ok(out.includes(`(${flag}:`), flag);
  // Each harness's server entry, and the approval or allow rule it needs.
  assert.match(out, /"type": "http",\s+"url": "http:\/\/127\.0\.0\.1:8792\/mcp"/);
  assert.match(out, /"mcp__glitchless_board__\*"/);
  assert.match(out, /\[mcp_servers\.glitchless_board\]\s+url = "http:\/\/127\.0\.0\.1:8792\/mcp"\s+default_tools_approval_mode = "approve"/);
  assert.match(out, /"Mcp\(glitchless_board:\*\)"/);
  assert.match(out, /cursor-agent mcp enable glitchless_board/);
  // It ends by saying to restart, and that the session must be local.
  const tail = out.slice(out.indexOf('Then restart the harness'));
  assert.match(tail, /restart the harness/);
  assert.match(tail, /local session/);
  assert.match(tail, /cloud session/);
});

test('what init shows for a harness is exactly what it writes', () => {
  const { game, home, init } = fresh();
  init();
  for (const plan of harnessPlans({ root: game, port: 8792, home, codexHome: path.join(home, '.codex') })) {
    for (const step of plan.steps) {
      assert.equal(step.apply(), 'written', step.file);
      const text = fs.readFileSync(step.file, 'utf8');
      if (step.file.endsWith('.toml')) assert.equal(text.trim(), step.show);
      else assert.deepEqual(JSON.parse(text), JSON.parse(step.show));
      assert.equal(step.apply(), 'already there', step.file);
    }
  }
});

test('--claude writes the two project files and keeps what was in them', () => {
  const { game, home, init, text } = fresh();
  fs.writeFileSync(path.join(game, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }));
  fs.mkdirSync(path.join(game, '.claude'));
  fs.writeFileSync(path.join(game, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] }, model: 'x' }));
  const r = init({ apply: ['claude'], port: 4760 });
  assert.deepEqual(r.applied.map((a) => [path.relative(game, a.file), a.result]), [['.mcp.json', 'written'], [path.join('.claude', 'settings.local.json'), 'written']]);
  assert.deepEqual(read(path.join(game, '.mcp.json')), { mcpServers: { other: { command: 'other-server' }, glitchless_board: { type: 'http', url: 'http://127.0.0.1:4760/mcp' } } });
  assert.deepEqual(read(path.join(game, '.claude', 'settings.local.json')), {
    permissions: { allow: ['Bash(npm test)', 'mcp__glitchless_board__*', 'Bash(npx -y glitchless-board wait *)', 'Bash(glitchless-board wait *)'], deny: ['Read(./.env)'] },
    model: 'x',
    enabledMcpjsonServers: ['glitchless_board'],
  });
  assert.match(text(), /\.mcp\.json {2}\[written\]/);
  // Only what was asked for: no Codex or Cursor file, and nothing in the home folder.
  assert.equal(fs.existsSync(path.join(game, '.codex')), false);
  assert.equal(fs.existsSync(path.join(game, '.cursor')), false);
  assert.deepEqual(filesUnder(home), []);
  // Again: the config is kept, and nothing is written twice.
  const again = init({ apply: ['claude'] });
  assert.equal(again.wrote, false);
  assert.deepEqual(again.applied.map((a) => a.result), ['already there', 'already there']);
});

test('--codex writes a project file; --codex-global adds to Codex\'s own without touching the rest', () => {
  const { game, home, init } = fresh();
  init({ apply: ['codex'] });
  assert.equal(fs.readFileSync(path.join(game, '.codex', 'config.toml'), 'utf8'), '[mcp_servers.glitchless_board]\nurl = "http://127.0.0.1:8792/mcp"\ndefault_tools_approval_mode = "approve"\n');
  assert.deepEqual(filesUnder(home), []);

  const own = path.join(home, '.codex', 'config.toml');
  const existing = 'model = "some-model"\n\n[mcp_servers.board]\nurl = "http://127.0.0.1:1/mcp"\n\n[profiles.fast]\nmodel = "other"';
  fs.mkdirSync(path.dirname(own));
  fs.writeFileSync(own, existing);
  init({ apply: ['codex-global'] });
  assert.equal(fs.readFileSync(own, 'utf8'), `${existing}\n\n[mcp_servers.glitchless_board]\nurl = "http://127.0.0.1:8792/mcp"\ndefault_tools_approval_mode = "approve"\n`);

  // A new port updates the board's own table and leaves every other line as it was.
  fs.writeFileSync(path.join(game, 'glitchless.board.json'), JSON.stringify({ ...read(path.join(game, 'glitchless.board.json')), port: 4760 }));
  const r = init({ apply: ['codex-global'] });
  assert.deepEqual(r.applied.map((a) => a.result), ['written']);
  const text = fs.readFileSync(own, 'utf8');
  assert.ok(text.startsWith(existing));
  assert.match(text, /\[mcp_servers\.glitchless_board\]\nurl = "http:\/\/127\.0\.0\.1:4760\/mcp"\ndefault_tools_approval_mode = "approve"\n$/);
  assert.equal(text.match(/glitchless_board/g).length, 1);
});

test('--cursor writes the two project files; --cursor-app writes the app\'s own', () => {
  const { game, home, init, text } = fresh();
  init({ apply: ['cursor'] });
  assert.deepEqual(read(path.join(game, '.cursor', 'mcp.json')), { mcpServers: { glitchless_board: { url: 'http://127.0.0.1:8792/mcp' } } });
  assert.deepEqual(read(path.join(game, '.cursor', 'cli.json')), { permissions: { allow: ['Mcp(glitchless_board:*)'], deny: [] } });
  assert.deepEqual(filesUnder(home), []);
  assert.match(text(), /approve the server for this folder yourself: cursor-agent mcp enable glitchless_board/);
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { board: { url: 'http://127.0.0.1:1/mcp' } } }));
  init({ apply: ['cursor-app'] });
  assert.deepEqual(read(path.join(home, '.cursor', 'mcp.json')), { mcpServers: { board: { url: 'http://127.0.0.1:1/mcp' }, glitchless_board: { url: 'http://127.0.0.1:8792/mcp' } } });
});

test('a harness file that is not valid JSON is left alone', () => {
  const { game, init } = fresh();
  fs.writeFileSync(path.join(game, '.mcp.json'), '{ "mcpServers": { // my servers\n }');
  assert.throws(() => init({ apply: ['claude'] }), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(game, '.mcp.json'), 'utf8'), '{ "mcpServers": { // my servers\n }');
  assert.throws(() => init({ apply: ['vscode'] }), /Unknown harness/);
});

test('init keeps a config that is already there, unless told to write a new one', () => {
  const { game, init, lines } = fresh();
  init();
  const file = path.join(game, 'glitchless.board.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'Mine', port: 4760, sections: [{ title: 'Fighters', kind: 'pictures', folder: 'art/characters' }] }));
  const kept = init({ port: 5000 });
  assert.equal(kept.wrote, false);
  assert.equal(read(file).name, 'Mine');
  assert.equal(kept.config.port, 4760);
  assert.match(lines.join('\n'), /is already there: kept as it is/);
  assert.match(lines.join('\n'), /http:\/\/127\.0\.0\.1:4760\/mcp/);
  const forced = init({ force: true, port: 5000 });
  assert.equal(forced.wrote, true);
  assert.deepEqual([read(file).port, read(file).sections.length], [5000, 3]);
});

test('a config with a mistake says what is wrong', () => {
  const game = sampleGame();
  const file = path.join(game, 'glitchless.board.json');
  const good = read(file);
  const broken = (change, pattern) => {
    fs.writeFileSync(file, JSON.stringify({ ...good, ...change }));
    assert.throws(() => loadConfig(game), pattern);
  };
  broken({ sections: [{ title: 'A', kind: 'models', folder: 'art' }] }, /"kind": one of pictures, captures, sounds/);
  broken({ sections: [{ title: 'A', kind: 'pictures' }] }, /needs "folder"/);
  broken({ sections: [{ title: 'A', kind: 'pictures', folder: 'art' }, { title: 'a', kind: 'sounds', folder: 'audio' }] }, /two sections are titled/);
  broken({ sections: [{ title: 'New from agents', kind: 'pictures', folder: 'art' }] }, /keeps for takes posted by agents/);
  broken({ sections: [{ title: 'Art/Fighters', kind: 'pictures', folder: 'art' }] }, /without "\/"/);
  broken({ port: 99999 }, /"port"/);
  broken({ logs: [{ file: 'art/log.txt' }] }, /\.csv or a \.jsonl/);
  fs.writeFileSync(file, '{ nope');
  assert.throws(() => loadConfig(game), /not valid JSON/);
  assert.throws(() => loadConfig(scratch('none')), /No glitchless\.board\.json/);
  // A folder that is not there is a note on the page, not a crash.
  fs.writeFileSync(file, JSON.stringify({ ...good, sections: [{ title: 'Later', kind: 'pictures', folder: 'art/not-yet' }] }));
  const scan = scanProject(loadConfig(game));
  assert.deepEqual([scan.sections[0].items.length, scan.missing.length], [0, 1]);
});
