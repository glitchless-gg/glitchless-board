import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanUp, sampleGame, scratch, serve } from './helpers.js';

let game;
let board;
let outside;

before(async () => {
  game = sampleGame();
  // Things that must never be served: a picture beside the media folders, one outside the game altogether,
  // text inside a media folder, and links from inside a media folder to each.
  fs.writeFileSync(path.join(game, 'secret.png'), fs.readFileSync(path.join(game, 'art/characters/knight.png')));
  outside = path.join(scratch('outside'), 'private.png');
  fs.writeFileSync(outside, fs.readFileSync(path.join(game, 'art/characters/knight.png')));
  fs.writeFileSync(path.join(game, 'art/characters/notes.txt'), 'not a picture');
  fs.writeFileSync(path.join(game, 'art/characters/page.html'), '<script>alert(1)</script>');
  fs.symlinkSync(outside, path.join(game, 'art/characters/link_out.png'));
  fs.symlinkSync(path.join(game, 'secret.png'), path.join(game, 'art/characters/link_up.png'));
  fs.symlinkSync(path.dirname(outside), path.join(game, 'art/characters/linked_folder'));
  // A log row that points its prompt file outside the game.
  fs.writeFileSync(path.join(path.dirname(outside), 'prompt.txt'), 'a private prompt');
  fs.appendFileSync(path.join(game, 'art/log.csv'), `art/characters/mage.png,someone,2026-02-01,2,${path.join(path.dirname(outside), 'prompt.txt')}\n`);
  fs.appendFileSync(path.join(game, 'art/log.csv'), 'art/characters/bat.png,someone,2026-02-01,2,../glitchless.board.json\n');
  board = await serve(game);
});
after(async () => {
  await board.close();
  cleanUp();
});

const media = (p, opts) => board.call(`/media?p=${encodeURIComponent(p)}`, opts);

test('a picture and a sound inside the configured folders are served, as what they are', async () => {
  const png = await media('art/characters/knight.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(png.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual([...png.buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const wav = await media('audio/sfx/jump.wav');
  assert.equal(wav.status, 200);
  assert.equal(wav.headers['content-type'], 'audio/wav');
  assert.equal(wav.buffer.subarray(0, 4).toString(), 'RIFF');
  // The same file by its full path.
  assert.equal((await media(path.join(game, 'art/characters/knight.png'))).status, 200);
});

test('a part of a sound can be asked for, so a player can seek', async () => {
  const part = await media('audio/music/theme.wav', { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.buffer.length, 100);
  assert.match(part.headers['content-range'], /^bytes 0-99\/\d+$/);
  assert.equal((await media('audio/music/theme.wav', { headers: { Range: 'bytes=99999999-' } })).status, 416);
});

test('a file outside the configured folders is refused', async () => {
  for (const p of ['secret.png', path.join(game, 'secret.png'), outside, 'glitchless.board.json', 'art/log.csv', '.glitchless/board/events.jsonl', '/etc/hosts', '']) {
    assert.equal((await media(p)).status, 404, p);
  }
});

test('".." does not climb out of a media folder', async () => {
  for (const p of ['art/characters/../../secret.png', 'art/characters/../../glitchless.board.json', '../game/secret.png', 'art/characters/..%2F..%2Fsecret.png']) {
    assert.equal((await media(p)).status, 404, p);
  }
  // The raw path, not encoded by the test.
  assert.equal((await board.call('/media?p=art/characters/../../secret.png')).status, 404);
  assert.equal((await board.call('/media/../secret.png')).status, 404);
});

test('a link inside a media folder that points out of it is refused, and is not listed', async () => {
  assert.equal((await media('art/characters/link_out.png')).status, 404);
  assert.equal((await media('art/characters/link_up.png')).status, 404);
  assert.equal((await media('art/characters/linked_folder/private.png')).status, 404);
  const state = (await board.call('/api/state')).json();
  const ids = state.sections.flatMap((s) => s.items.map((it) => it.id));
  assert.equal(ids.some((id) => /link|private|secret/.test(id)), false);
  assert.ok(ids.includes('Characters/knight.png'));
});

test('only pictures and sound are served from a media folder', async () => {
  assert.equal((await media('art/characters/notes.txt')).status, 404);
  assert.equal((await media('art/characters/page.html')).status, 404);
  assert.equal((await media('art/characters')).status, 404);
});

test('an agent can post only files inside the configured folders', async () => {
  const post = (files) =>
    board.call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_post', arguments: { title: 'A take', files, by: 'codex' } } }) }).then((r) => r.json().result);
  for (const files of [['secret.png'], [outside], ['art/characters/link_out.png'], ['art/characters/notes.txt'], ['art/log.csv'], ['art/characters/knight.png', outside], []]) {
    const r = await post(files);
    assert.equal(r.isError, true, JSON.stringify(files));
  }
  const ok = await post(['art/tiles/grass.png']);
  assert.equal(ok.isError, undefined);
  assert.equal(JSON.parse(ok.content[0].text).posted, 'Tiles/grass.png');
  assert.equal(board.record.events.filter((e) => e.type === 'post').length, 1);
});

test("a log's prompt file is read only from inside the game, and only if it is text", async () => {
  const read = (item) =>
    board.call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_read', arguments: { item } } }) }).then((r) => JSON.parse(r.json().result.content[0].text));
  assert.match((await read('Characters/knight.png')).context.made[0].prompt, /steel blue/);
  const mage = (await read('Characters/mage.png')).context.made[0];
  assert.equal(mage.tool, 'someone');
  assert.equal(mage.prompt, undefined); // the row pointed outside the game
  assert.equal((await read('Characters/bat.png')).context.made[0].prompt, undefined); // inside, but not a text file
});

test('the board answers this computer only', async () => {
  assert.equal((await board.call('/', { host: 'attacker.example' })).status, 403);
  assert.equal((await board.call('/api/state', { host: `attacker.example:${board.port}` })).status, 403);
  assert.equal((await board.call('/api/state', { host: '127.0.0.1:1' })).status, 403);
  assert.equal((await board.call('/api/state', { host: `localhost:${board.port}` })).status, 200);
  assert.equal(board.server.address().address, '127.0.0.1');
});

test('a request a browser makes from another site is turned away, except opening the page', async () => {
  const cross = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };
  assert.equal((await board.call('/api/state', { headers: cross })).status, 403);
  assert.equal((await media('art/characters/knight.png', { headers: cross })).status, 403);
  assert.equal((await board.call('/api/wait?as=claude&timeout=1', { headers: cross })).status, 403);
  assert.equal((await board.call('/mcp', { method: 'POST', headers: { ...cross, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await board.call('/mcp', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await board.call('/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).status, 200);
  assert.equal((await board.call('/api/state', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test("a verdict needs the page's own token, and there is no other way to give one", async () => {
  const body = JSON.stringify({ item: 'Characters/knight.png', v: 'keep' });
  const json = { 'content-type': 'application/json' };
  assert.equal((await board.call('/api/verdict', { method: 'POST', body, headers: json })).status, 403);
  assert.equal((await board.call('/api/verdict', { method: 'POST', body, headers: { ...json, 'x-board-owner': 'guess' } })).status, 403);
  assert.equal((await board.call('/api/verdict', { method: 'POST', body, headers: { ...json, 'x-board-owner': board.token, origin: 'https://attacker.example' } })).status, 403);
  assert.equal(board.record.events.filter((e) => e.type === 'verdict').length, 0);
  const ok = await board.verdict({ item: 'Characters/knight.png', v: 'keep', note: 'good' });
  assert.equal(ok.status, 200);
  assert.equal((await board.verdict({ item: 'Characters/nobody.png', v: 'keep' })).status, 404);
  assert.equal((await board.verdict({ item: 'Characters/knight.png', v: 'approved' })).status, 400);
  const verdicts = board.record.events.filter((e) => e.type === 'verdict');
  assert.deepEqual(verdicts.map((e) => [e.item, e.verdict, e.by, e.door]), [['Characters/knight.png', 'keep', 'owner', 'page']]);
  assert.equal((await board.call('/api/send', { method: 'POST', body, headers: json })).status, 403);
});

test('the page loads nothing from anywhere else and plays nothing by itself', async () => {
  const page = await board.call('/');
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[^']+'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  const html = page.text;
  assert.match(html, /<title>Glitchless Board<\/title>/);
  assert.equal(html.includes('__NONCE__'), false);
  assert.equal(html.includes('/*BOOT*/null'), false);
  // Every src and href in the markup points at the board itself.
  const refs = [...html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) assert.match(ref, /^\/[a-z-]+\.svg$/, ref);
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i);
  assert.doesNotMatch(html, /autoplay/i);
  assert.match(html, /preload = 'none'/);
  assert.equal((await board.call('/favicon.svg')).status, 200);
  assert.equal((await board.call('/../package.json')).status, 404);
  assert.equal((await board.call('/index.html')).status, 404);
});
