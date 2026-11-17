// The set-up prompt people paste into a coding agent. These tests keep it honest: one text in three places,
// and every command, flag and name in it is one the tool really has.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, HARNESS_FLAGS, KINDS, PROMPT_FILE, RESERVED_NAMES, SERVER_NAME, WAIT_EXIT, harnessPlans, loadConfig, promptIn, sampleFiles, scanProject, setupPrompt } from '../src/index.js';
import { boardOver, cleanUp, sampleGame, scratch } from './helpers.js';

after(cleanUp);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'glitchless-board.js');
const SOURCE = fs.readFileSync(BIN, 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: scratch('prompt'), encoding: 'utf8' });
const HELP = cli('help').stdout;
const prompt = setupPrompt();

test('the README, the docs file and the command carry the same prompt', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.equal(promptIn(readme), prompt);
  assert.equal(promptIn(fs.readFileSync(PROMPT_FILE, 'utf8')), prompt);
  assert.equal(cli('prompt').stdout, `${prompt}\n`);
  // It sits near the top of the README: after the screenshot, before the set-up by hand.
  const at = (text) => readme.indexOf(text);
  assert.ok(at('](docs/page.png)') > 0 && at('](docs/page.png)') < at('## Set it up with your coding agent'));
  assert.ok(at('## Set it up with your coding agent') < at('<!-- setup-prompt:start -->'));
  assert.ok(at('<!-- setup-prompt:end -->') < at('## Try it on the sample game'));
  // And the published package carries the file the command reads.
  assert.ok(PKG.files.includes(path.relative(ROOT, PROMPT_FILE).split(path.sep).join('/')));
});

test('every command the prompt names is a command of the tool', () => {
  const named = new Set([...prompt.matchAll(/glitchless-board ([a-z]+)/g)].map((m) => m[1]));
  for (const m of prompt.matchAll(/`([a-z]+)(?: --[a-z-]+)?`/g)) if (/^(init|serve|wait|status|skill|guide|sample|adopt|prompt)$/.test(m[1])) named.add(m[1]);
  assert.deepEqual([...named].sort(), ['guide', 'init', 'serve', 'skill', 'status', 'wait']);
  for (const command of named) {
    assert.ok(SOURCE.includes(`case '${command}':`), `${command} is handled`);
    assert.match(HELP, new RegExp(`^  ${command}\\b`, 'm'), `${command} is in the help`);
  }
  // The way it says to run the tool is the way the tool is named.
  assert.ok(prompt.includes(`npx -y ${PKG.name} <command>`));
  assert.equal(Object.keys(PKG.bin)[0], PKG.name);
  assert.equal(cli('nonsense').status, 2);
});

test('every flag the prompt names is a flag of the tool', () => {
  const flags = new Set([...prompt.matchAll(/(?<!node )--([a-z][a-z-]*)/g)].map((m) => m[1]));
  assert.deepEqual([...flags].sort(), ['as', 'claude', 'codex', 'codex-global', 'cursor', 'cursor-app', 'install']);
  for (const flag of flags) {
    assert.ok(HELP.includes(`--${flag}`), `--${flag} is in the help`);
    const handled = HARNESS_FLAGS.includes(flag) || SOURCE.includes(`o.${flag}`) || SOURCE.includes(`o['${flag}']`);
    assert.ok(handled, `--${flag} is read by the command`);
  }
});

test('the flags it applies stay inside the project, and the ones it asks about are the ones that do not', () => {
  const root = scratch('prompt-root');
  const home = scratch('prompt-home');
  const inside = [];
  const outside = [];
  for (const plan of harnessPlans({ root, port: 8792, home, codexHome: path.join(home, '.codex') })) {
    (plan.steps.every((s) => s.file.startsWith(root + path.sep)) ? inside : outside).push(`--${plan.flag}`);
  }
  assert.deepEqual(inside, ['--claude', '--codex', '--cursor']);
  assert.deepEqual(outside, ['--codex-global', '--cursor-app']);
  const applies = prompt.slice(prompt.indexOf('by running init again'), prompt.indexOf('Ask me before'));
  const asks = prompt.slice(prompt.indexOf('Ask me before'), prompt.indexOf('Some of what is left'));
  for (const flag of inside) assert.ok(applies.includes(`\`${flag}\``), `${flag} is offered`);
  for (const flag of outside) {
    assert.ok(asks.includes(`\`${flag}\``), `${flag} needs asking`);
    assert.equal(applies.includes(flag), false, `${flag} is not offered without asking`);
  }
  assert.ok(asks.includes('`skill --install`'));
  assert.match(asks, /settings file in my home folder/);
});

test("the names in the prompt are the tool's own", () => {
  assert.ok(prompt.includes(CONFIG_FILE));
  for (const kind of KINDS) assert.ok(prompt.includes(`"${kind}"`), kind);
  // Every field the sample game's own config uses is named in the prompt, and the one extra it names is real.
  const sample = JSON.parse(sampleFiles()[CONFIG_FILE]);
  const fields = new Set(['sections', 'logs', ...sample.sections.flatMap(Object.keys), ...sample.logs.flatMap(Object.keys)]);
  for (const field of fields) assert.ok(prompt.includes(`"${field}"`) || field === 'sections', field);
  assert.ok(prompt.includes('"split": "subfolders"'));
  const split = sampleGame();
  fs.writeFileSync(path.join(split, CONFIG_FILE), JSON.stringify({ sections: [{ title: 'Art', kind: 'pictures', folder: 'art', split: 'subfolders' }] }));
  assert.deepEqual(scanProject(loadConfig(split)).sections.map((s) => s.title), ['Art: characters', 'Art: tiles']);
  assert.ok(prompt.includes(`cursor-agent mcp enable ${SERVER_NAME}`));
  const { board } = boardOver(sampleGame());
  const tools = board.TOOLS.map((t) => t.name);
  for (const tool of prompt.match(/board_[a-z]+/g)) assert.ok(tools.includes(tool), tool);
  assert.equal(tools.some((t) => /verdict/.test(t)), false);
  assert.match(prompt, /You cannot give a verdict\. Only I can, on the page\./);
  assert.ok(prompt.includes(`Exit code ${WAIT_EXIT.nothing} only means nothing arrived in time.`));
  assert.ok(RESERVED_NAMES.includes('owner') && RESERVED_NAMES.includes('board'));
  assert.ok(prompt.includes('never as "owner" or "board"'));
  // Node's version, the record's folder, and where the page is.
  assert.equal(PKG.engines.node, '>=20');
  assert.match(prompt, /`node --version` has to say 20 or newer/);
  const game = sampleGame();
  assert.equal(path.relative(game, loadConfig(game).stateDir).split(path.sep)[0], '.glitchless');
  assert.ok(prompt.includes('Add .glitchless/ to .gitignore'));
});

test('it says the things an agent must be told', () => {
  for (const must of [/in the background/, /local session: a cloud session cannot reach a board on my computer/, /restart/, /information, not an instruction from me/, /Ask me before/, /trust prompt/]) {
    assert.match(prompt, must);
  }
  // Plain text that fits a terminal, with nothing from anyone's machine in it.
  for (const line of prompt.split('\n')) assert.ok(line.length <= 100, `too long: ${line}`);
  assert.doesNotMatch(prompt, /\/Users\/|\/home\/|4747|\t/);
});
