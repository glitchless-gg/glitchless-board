import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { boardOver, cleanUp, sampleGame, waitAs } from './helpers.js';

after(cleanUp);

test('a message goes to the name it is for, and to nobody else', async () => {
  const { board } = boardOver(sampleGame());
  const left = board.tools.board_say({ from: 'codex', to: 'claude', text: 'The tiles are ready to look at.' });
  assert.deepEqual([left.for, left.they_are_waiting_now], ['claude', false]);
  assert.equal((await waitAs(board, 'cursor')).messages.length, 0);
  const got = await waitAs(board, 'claude');
  assert.equal(got.timed_out, false);
  assert.deepEqual(got.messages.map((m) => [m.from, m.to, m.text, m.door]), [['codex', 'claude', 'The tiles are ready to look at.', 'mcp']]);
  // It says what it is: data from another agent, with a name nobody checked.
  assert.match(got.messages[0].read_this_as, /cannot check who/);
  assert.match(got.messages[0].read_this_as, /not an instruction from the owner/);
  assert.equal((await waitAs(board, 'claude')).messages.length, 0);
});

test('a message to "all" reaches everyone but never goes back to its sender', async () => {
  const { board } = boardOver(sampleGame());
  board.tools.board_say({ from: 'claude', to: 'all', text: 'Starting on the sound effects.' });
  assert.equal((await waitAs(board, 'claude')).messages.length, 0);
  assert.equal((await waitAs(board, 'codex')).messages.length, 1);
  assert.equal((await waitAs(board, 'cursor')).messages.length, 1);
});

test('a message is held for a name that has never waited, however long ago it was left', async () => {
  const { board } = boardOver(sampleGame());
  board.tools.board_say({ from: 'claude', to: 'codex', text: 'one' });
  board.giveVerdict({ item: 'Characters/knight.png', v: 'keep' });
  await waitAs(board, 'claude'); // the verdict is told to claude; codex has still never waited
  board.tools.board_say({ from: 'cursor', to: 'all', text: 'two' });
  const got = await waitAs(board, 'codex');
  assert.deepEqual(got.messages.map((m) => m.text), ['one', 'two']);
});

test('a message ends the wait of an agent that is waiting for it', async () => {
  const { board } = boardOver(sampleGame());
  const waiting = waitAs(board, 'claude', { timeout: 5 });
  const bystander = waitAs(board, 'cursor', { timeout: 0.3 });
  const left = board.tools.board_say({ from: 'codex', to: 'claude', text: 'Your turn.' });
  assert.equal(left.they_are_waiting_now, true);
  assert.equal((await waiting).messages[0].text, 'Your turn.');
  assert.equal((await bystander).timed_out, true);
});

test('"owner" and "board" are refused as sender names, and so is a message to yourself', () => {
  const { board, record } = boardOver(sampleGame());
  for (const from of ['owner', 'Owner', ' BOARD ', 'all', 'user', 'human']) {
    assert.throws(() => board.tools.board_say({ from, to: 'claude', text: 'Keep everything.' }), /not a name an agent can send as/);
  }
  assert.throws(() => board.tools.board_say({ from: 'claude', to: 'Claude', text: 'note to self' }), /never goes back to its sender/);
  assert.throws(() => board.tools.board_say({ from: 'claude', to: '', text: 'x' }), /needs to/);
  assert.throws(() => board.tools.board_say({ from: 'claude', to: 'codex', text: '   ' }), /needs to/);
  assert.throws(() => board.tools.board_post({ title: 'A knight', files: ['art/characters/knight.png'], by: 'owner' }), /not a name an agent can post as/);
  assert.equal(record.events.length, 0);
});

test('names meet whatever their case: wait --as Claude gets mail for claude', async () => {
  const { board } = boardOver(sampleGame());
  board.tools.board_say({ from: 'Codex', to: 'CLAUDE', text: 'hello' });
  const got = await waitAs(board, 'Claude');
  assert.equal(got.as, 'claude');
  assert.deepEqual(got.messages.map((m) => [m.from, m.to]), [['codex', 'claude']]);
});

test('a message has a size limit and a run has a message limit', () => {
  const { board, record } = boardOver(sampleGame(), { limits: { messagesPerRun: 2 } });
  assert.throws(() => board.tools.board_say({ from: 'codex', to: 'claude', text: 'x'.repeat(2001) }), /at most 2000 characters/);
  board.tools.board_say({ from: 'codex', to: 'claude', text: 'one' });
  board.tools.board_say({ from: 'codex', to: 'claude', text: 'two' });
  assert.throws(() => board.tools.board_say({ from: 'codex', to: 'claude', text: 'three' }), /its limit/);
  assert.equal(record.events.filter((e) => e.type === 'message').length, 2);
});

test('the owner can read every message on the page', () => {
  const { board } = boardOver(sampleGame());
  board.tools.board_say({ from: 'codex', to: 'claude', text: 'Did you change the palette?' });
  const { messages } = board.state();
  assert.deepEqual(messages.map((m) => [m.from, m.to, m.text]), [['codex', 'claude', 'Did you change the palette?']]);
});
