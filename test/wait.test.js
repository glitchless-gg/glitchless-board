// A wait whose caller goes away must not swallow what arrives next: through the wait address and through
// the board_wait tool alike.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cleanUp, sampleGame, serve } from './helpers.js';

after(cleanUp);

const KNIGHT = 'Characters/knight.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a request and returns a way to drop the connection, as a harness does when it gives up on a call. */
function open(port, pathname, { method = 'GET', body } = {}) {
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: `127.0.0.1:${port}`, 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(body);
  return () => req.destroy();
}
const toolCall = (name, args) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const untilWaiting = async (board, names) => {
  for (let i = 0; i < 100 && JSON.stringify(board.board.waitingNames()) !== JSON.stringify(names); i++) await sleep(20);
  assert.deepEqual(board.board.waitingNames(), names);
};

for (const [door, start] of [
  ['the wait address', (port) => open(port, '/api/wait?as=claude&timeout=30&settle=0')],
  ['the board_wait tool', (port) => open(port, '/mcp', { method: 'POST', body: toolCall('board_wait', { as: 'claude', timeout_s: 30 }) })],
]) {
  test(`a wait dropped by its caller holds the next verdict for that name (${door})`, async () => {
    const board = await serve(sampleGame());
    try {
      const drop = start(board.port);
      await untilWaiting(board, ['claude']);
      drop();
      await untilWaiting(board, []); // the board noticed, and nobody is shown as waiting
      const click = (await board.verdict({ item: KNIGHT, v: 'redo', note: 'held for later' })).json();
      assert.deepEqual(click.waiting, []);
      await sleep(1200); // longer than a delivery to a dead caller would have taken
      const got = (await board.call('/api/wait?as=claude&timeout=2&settle=0')).json();
      assert.deepEqual(got.verdicts.map((v) => [v.item, v.verdict, v.note]), [[KNIGHT, 'redo', 'held for later']]);
    } finally {
      await board.close();
    }
  });
}

test('a message left for a caller that dropped its wait is held too', async () => {
  const board = await serve(sampleGame());
  try {
    const drop = open(board.port, '/mcp', { method: 'POST', body: toolCall('board_wait', { as: 'claude', timeout_s: 30 }) });
    await untilWaiting(board, ['claude']);
    drop();
    await untilWaiting(board, []);
    const left = JSON.parse((await board.call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: toolCall('board_say', { from: 'codex', to: 'claude', text: 'still here?' }) })).json().result.content[0].text);
    assert.equal(left.they_are_waiting_now, false);
    const got = (await board.call('/api/wait?as=claude&timeout=2&settle=0')).json();
    assert.deepEqual(got.messages.map((m) => m.text), ['still here?']);
  } finally {
    await board.close();
  }
});

test('a caller that drops its wait while a click is settling still gets that verdict later', async () => {
  const board = await serve(sampleGame());
  try {
    const drop = open(board.port, '/api/wait?as=claude&timeout=30&settle=1');
    await untilWaiting(board, ['claude']);
    await board.verdict({ item: KNIGHT, v: 'keep', note: 'on its way' }); // the wait now holds it for a second of quiet
    drop();
    await untilWaiting(board, []);
    await sleep(1200);
    const got = (await board.call('/api/wait?as=claude&timeout=2&settle=0')).json();
    assert.deepEqual(got.verdicts.map((v) => [v.item, v.verdict, v.note]), [[KNIGHT, 'keep', 'on its way']]);
  } finally {
    await board.close();
  }
});
