import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openRecord } from '../src/index.js';
import { boardOver, cleanUp, sampleGame, scratch, waitAs } from './helpers.js';

after(cleanUp);

const KNIGHT = 'Characters/knight.png';
const MAGE = 'Characters/mage.png';

test('the record numbers each event, keeps it on disk, and picks up where it left off', () => {
  const dir = scratch('record');
  const a = openRecord(dir);
  const first = a.append({ type: 'message', from: 'codex', to: 'claude', text: 'hello', door: 'mcp' });
  a.append({ type: 'verdict', item: 'x', verdict: 'keep', door: 'page' });
  assert.equal(first.seq, 1);
  assert.match(first.at, /^\d{4}-\d\d-\d\dT/);
  const b = openRecord(dir);
  assert.deepEqual(b.events.map((e) => [e.seq, e.type, e.door]), [[1, 'message', 'mcp'], [2, 'verdict', 'page']]);
  assert.equal(b.append({ type: 'post', item: 'y', door: 'mcp' }).seq, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 3);
});

test('every event says which door it came through, or it is refused', () => {
  const r = openRecord(scratch('record'));
  assert.throws(() => r.append({ type: 'verdict', item: 'x' }), /door/);
  assert.throws(() => r.append({ type: 'verdict', item: 'x', door: 'window' }), /door/);
  assert.throws(() => r.append({ door: 'page' }), /type/);
  assert.equal(r.events.length, 0);
});

test('a line cut short by a crash is skipped, not fatal', () => {
  const dir = scratch('record');
  openRecord(dir).append({ type: 'verdict', item: 'x', verdict: 'keep', door: 'page' });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":2,"type":"verd');
  const r = openRecord(dir);
  assert.equal(r.events.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.append({ type: 'verdict', item: 'x', verdict: 'redo', door: 'page' }).seq, 2);
});

test('a verdict given while nobody waits is held for a name that has never waited', async () => {
  const { board, record } = boardOver(sampleGame());
  board.giveVerdict({ item: KNIGHT, v: 'redo', note: 'the helmet is too dark' });
  const got = await waitAs(board, 'claude');
  assert.equal(got.timed_out, false);
  assert.equal(got.verdicts.length, 1);
  const v = got.verdicts[0];
  assert.deepEqual([v.item, v.verdict, v.note, v.given_by, v.door, v.take], [KNIGHT, 'redo', 'the helmet is too dark', 'owner', 'page', 1]);
  assert.match(v.what_now, /board_post/);
  assert.equal(v.context.section, 'Characters');
  assert.match(v.context.file, /knight\.png$/);
  assert.equal(v.context.made[0].tool, 'the sample generator');
  assert.match(v.context.made[0].prompt, /knight in steel blue/i);
  // It is told once: the next wait has nothing.
  assert.equal((await waitAs(board, 'claude')).timed_out, true);
  assert.deepEqual(record.cursor('claude'), { verdicts: v.seq, messages: 0 });
});

test('a name that has waited before gets everything since, even what another name was told meanwhile', async () => {
  const { board } = boardOver(sampleGame());
  assert.equal((await waitAs(board, 'codex')).timed_out, true); // codex joins, then goes away
  board.giveVerdict({ item: KNIGHT, v: 'keep' });
  assert.equal((await waitAs(board, 'claude')).verdicts.length, 1); // claude is told
  board.giveVerdict({ item: MAGE, v: 'redo', note: 'more purple' });
  const got = await waitAs(board, 'codex');
  assert.deepEqual(got.verdicts.map((v) => [v.item, v.verdict]), [[KNIGHT, 'keep'], [MAGE, 'redo']]);
});

test('a brand new name starts after the last verdict anyone was told', async () => {
  const { board } = boardOver(sampleGame());
  board.giveVerdict({ item: KNIGHT, v: 'keep' });
  assert.equal((await waitAs(board, 'claude')).verdicts.length, 1);
  board.giveVerdict({ item: MAGE, v: 'keep' });
  const got = await waitAs(board, 'cursor');
  assert.deepEqual(got.verdicts.map((v) => v.item), [MAGE]);
});

test('an old message does not make a new name hear verdicts others were already told', async () => {
  const { board } = boardOver(sampleGame());
  board.tools.board_say({ from: 'claude', to: 'codex', text: 'the tiles are done' }); // seq 1
  board.giveVerdict({ item: KNIGHT, v: 'keep' }); // seq 2
  assert.equal((await waitAs(board, 'claude')).verdicts.length, 1); // told to claude
  const first = await waitAs(board, 'codex');
  assert.deepEqual([first.messages.length, first.verdicts.length], [1, 0]);
  const second = await waitAs(board, 'codex');
  assert.deepEqual([second.messages.length, second.verdicts.length, second.timed_out], [0, 0, true]);
});

test('a waiting agent is told as soon as the owner clicks', async () => {
  const { board } = boardOver(sampleGame());
  const waiting = waitAs(board, 'claude', { timeout: 5 });
  assert.deepEqual(board.waitingNames(), ['claude']);
  const answer = board.giveVerdict({ item: KNIGHT, v: 'keep' });
  assert.deepEqual(answer.waiting, ['claude']);
  const got = await waiting;
  assert.equal(got.verdicts[0].verdict, 'keep');
  assert.deepEqual(board.waitingNames(), []);
});

test('a burst of clicks on one item arrives as its last state', async () => {
  const { board } = boardOver(sampleGame());
  board.giveVerdict({ item: KNIGHT, v: 'redo', note: 'too dark' });
  board.giveVerdict({ item: KNIGHT, v: 'keep', note: 'on second thought' });
  board.giveVerdict({ item: MAGE, v: 'keep' });
  board.giveVerdict({ item: MAGE, v: null }); // marked, then unmarked: nothing to tell
  const got = await waitAs(board, 'claude');
  assert.equal(got.verdicts.length, 1);
  assert.deepEqual([got.verdicts[0].item, got.verdicts[0].verdict, got.verdicts[0].earlier_clicks_on_this_item], [KNIGHT, 'keep', 1]);
  assert.equal((await waitAs(board, 'claude')).timed_out, true);
});

test('a verdict taken back later is told as cleared, and a bare note as a note', async () => {
  const { board } = boardOver(sampleGame());
  board.giveVerdict({ item: KNIGHT, v: 'keep' });
  await waitAs(board, 'claude');
  board.giveVerdict({ item: KNIGHT, v: null });
  board.giveVerdict({ item: MAGE, v: null, note: 'compare with the knight' });
  const got = await waitAs(board, 'claude');
  assert.deepEqual(got.verdicts.map((v) => [v.item, v.verdict]), [[KNIGHT, 'cleared'], [MAGE, 'note']]);
});

test('--since hears older lines again without moving the name backwards', async () => {
  const { board, record } = boardOver(sampleGame());
  board.giveVerdict({ item: KNIGHT, v: 'keep' });
  await waitAs(board, 'claude');
  const again = await waitAs(board, 'claude', { since: 0 });
  assert.equal(again.verdicts.length, 1);
  assert.equal(record.cursor('claude').verdicts, again.verdicts[0].seq);
});

test('a take posted after a Redo puts the item back to waiting, and a pick names its take', async () => {
  const dir = sampleGame();
  const { board } = boardOver(dir);
  board.giveVerdict({ item: KNIGHT, v: 'redo', note: 'lighter helmet' });
  assert.equal(board.tools.board_list({ state: 'redo' }).total, 1);
  const posted = board.tools.board_post({ title: 'Knight, lighter helmet', files: ['art/characters/knight_take2.png'], by: 'Codex', item: KNIGHT });
  assert.deepEqual([posted.posted, posted.take], [KNIGHT, 2]);
  assert.equal(board.tools.board_list({ state: 'redo' }).total, 0);
  const read = board.tools.board_read({ item: KNIGHT });
  assert.equal(read.state, 'waiting');
  assert.equal(read.verdict.stale, true);
  assert.deepEqual(read.context.takes.map((t) => [t.take, t.by]), [[1, 'project'], [2, 'codex']]);
  // The owner prefers the first take after all.
  board.giveVerdict({ item: KNIGHT, v: 'pick', take: 1 });
  const got = await waitAs(board, 'codex');
  assert.deepEqual([got.verdicts[0].verdict, got.verdicts[0].take], ['pick', 1]);
  assert.equal(board.tools.board_read({ item: KNIGHT }).state, 'keep');
  // Picking the newest take is simply keeping it; a take that is not there is refused.
  board.giveVerdict({ item: KNIGHT, v: 'pick', take: 2 });
  assert.equal(board.tools.board_read({ item: KNIGHT }).verdict.v, 'keep');
  assert.throws(() => board.giveVerdict({ item: KNIGHT, v: 'pick', take: 9 }), /no such take/);
  assert.throws(() => board.giveVerdict({ item: KNIGHT, v: 'approve' }), /keep, redo or pick/);
  assert.throws(() => board.giveVerdict({ item: 'Characters/nobody.png', v: 'keep' }), /No such item/);
});
