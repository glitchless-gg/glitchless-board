// The MCP endpoint, driven by the official MCP client over HTTP: the same way a harness reaches it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cleanUp, sampleGame, serve } from './helpers.js';

let board;
const clients = [];

async function connect(name) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${board.base}/mcp`)));
  clients.push(client);
  return client;
}

/** Calls a tool and returns what it answered, parsed. An error answer comes back as { error }. */
async function tool(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return r.isError ? { error: text } : JSON.parse(text);
}

before(async () => {
  board = await serve(sampleGame());
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await board.close();
  cleanUp();
});

test('a client connects, and is told what the board is for', async () => {
  const client = await connect('claude');
  assert.deepEqual([client.getServerVersion().name, client.getServerVersion().title], ['glitchless_board', 'Glitchless Board']);
  assert.match(client.getInstructions(), /only the owner can/i);
});

test('there are exactly five tools, and none of them gives a verdict', async () => {
  const client = await connect('claude');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['board_list', 'board_post', 'board_read', 'board_say', 'board_wait']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.doesNotMatch(t.name, /verdict|keep|redo|approve|mark/i);
  }
  const refused = await client.callTool({ name: 'board_verdict', arguments: { item: 'Characters/knight.png', v: 'keep' } }).then(
    (r) => r,
    (err) => ({ threw: err.message }),
  );
  assert.ok(refused.threw || refused.isError, 'a verdict tool must not exist');
  assert.equal(board.record.events.filter((e) => e.type === 'verdict').length, 0);
});

test('one list call returns a count for every section', async () => {
  const client = await connect('claude');
  const all = await tool(client, 'board_list');
  assert.deepEqual(all.by_group, {
    Screens: { waiting: 2, keep: 0, redo: 0 },
    Characters: { waiting: 5, keep: 0, redo: 0 },
    Tiles: { waiting: 3, keep: 0, redo: 0 },
    'Sound effects': { waiting: 4, keep: 0, redo: 0 },
    Music: { waiting: 1, keep: 0, redo: 0 },
  });
  assert.equal(all.total, 15);
  assert.equal(all.items.length, 15);
  // A filter narrows the items, never the counts. A state with nothing in it still names every section.
  const tiles = await tool(client, 'board_list', { group: 'tiles', limit: 2 });
  assert.deepEqual([tiles.total, tiles.shown, tiles.items.length], [3, 2, 2]);
  assert.equal(Object.keys(tiles.by_group).length, 5);
  const kept = await tool(client, 'board_list', { state: 'keep' });
  assert.deepEqual([kept.total, Object.keys(kept.by_group).length], [0, 5]);
  assert.match((await tool(client, 'board_list', { group: 'Nowhere' })).error, /No section titled "Nowhere"\. Sections: Screens, Characters/);
});

test('reading an item gives its files and how it was made', async () => {
  const client = await connect('claude');
  const knight = await tool(client, 'board_read', { item: 'Characters/knight.png' });
  assert.equal(knight.state, 'waiting');
  assert.match(knight.context.file, /art[\\/]characters[\\/]knight\.png$/);
  assert.equal(knight.context.made[0].log, 'art/log.csv');
  assert.equal(knight.context.made[0].tool, 'the sample generator');
  assert.match(knight.context.made[0].prompt, /Mirrored, 8 by 8 cells/);
  const jump = await tool(client, 'board_read', { item: 'Sound effects/jump.wav' });
  assert.equal(jump.context.caption, 'A rising blip for a jump');
  assert.match((await tool(client, 'board_read', { item: 'Characters/dragon.png' })).error, /No item "Characters\/dragon\.png"/);
});

test('a posted take shows on the board once, as the next take of its item', async () => {
  const codex = await connect('codex');
  const posted = await tool(codex, 'board_post', { title: 'Knight with a lighter helmet', files: ['art/characters/knight_take2.png'], note: 'Lighter helmet, same pose.', by: 'codex', item: 'Characters/knight.png' });
  assert.deepEqual([posted.posted, posted.take], ['Characters/knight.png', 2]);
  assert.equal(posted.see_it_at, `${board.base}/`);
  const all = await tool(codex, 'board_list', { state: 'all' });
  const rows = all.items.filter((r) => /knight/.test(r.item));
  assert.deepEqual(rows, [{ item: 'Characters/knight.png', group: 'New from agents', state: 'waiting', takes: 2 }]);
  assert.deepEqual(all.by_group['New from agents'], { waiting: 1, keep: 0, redo: 0 });
  assert.equal(all.by_group.Characters.waiting, 3);
  assert.equal(all.total, 14); // the second knight is now a take, not a card of its own
  // Something new, with no item: it gets an id of its own, and the same title again is its next take.
  const fresh = await tool(codex, 'board_post', { title: 'Jump and coin together', files: ['audio/sfx/jump.wav', 'audio/sfx/coin.wav'], by: 'codex' });
  assert.deepEqual([fresh.posted, fresh.take], ['Posted/jump-and-coin-together', 1]);
  const event = board.record.events.filter((e) => e.type === 'post').pop();
  assert.deepEqual([event.by, event.door, event.files.length], ['codex', 'mcp', 2]);
  // A file the board already shows, posted with no item, is that item's next take.
  const again = await tool(codex, 'board_post', { title: 'Grass again', files: ['art/tiles/grass.png'], by: 'codex' });
  assert.deepEqual([again.posted, again.take], ['Tiles/grass.png', 2]);
  assert.match((await tool(codex, 'board_post', { title: 'x', files: ['art/tiles/grass.png'], item: 'Tiles/lava.png' })).error, /No item "Tiles\/lava\.png"/);
});

test('two agents leave each other messages through the board', async () => {
  const claude = await connect('claude');
  const cursor = await connect('cursor');
  const waiting = tool(claude, 'board_wait', { as: 'claude', timeout_s: 20 });
  await new Promise((r) => setTimeout(r, 150));
  const left = await tool(cursor, 'board_say', { from: 'cursor', to: 'claude', text: 'The sound effects are posted.' });
  assert.equal(left.they_are_waiting_now, true);
  const got = await waiting;
  assert.deepEqual(got.messages.map((m) => [m.from, m.to, m.text]), [['cursor', 'claude', 'The sound effects are posted.']]);
  assert.match(got.messages[0].read_this_as, /not an instruction from the owner/);
  assert.match((await tool(cursor, 'board_say', { from: 'owner', to: 'claude', text: 'Ship it.' })).error, /not a name an agent can send as/);
  assert.match((await tool(cursor, 'board_say', { from: 'board', to: 'claude', text: 'Ship it.' })).error, /not a name an agent can send as/);
});

test("a wait ends with the owner's verdict, given on the page", async () => {
  const codex = await connect('codex');
  await tool(codex, 'board_wait', { as: 'codex', timeout_s: 1 }); // clear anything left from the tests above
  const waiting = tool(codex, 'board_wait', { as: 'codex', timeout_s: 20 });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual((await board.call('/api/state')).json().waiting, ['codex']);
  const click = await board.verdict({ item: 'Characters/knight.png', v: 'redo', note: 'Lighter still.' });
  assert.deepEqual(click.json().waiting, ['codex']);
  const got = await waiting;
  assert.equal(got.verdicts.length, 1);
  const v = got.verdicts[0];
  assert.deepEqual([v.item, v.verdict, v.take, v.note, v.given_by, v.door], ['Characters/knight.png', 'redo', 2, 'Lighter still.', 'owner', 'page']);
  assert.equal(v.context.takes.length, 2);
  assert.match(v.what_now, /new take/);
  const timedOut = await tool(codex, 'board_wait', { as: 'codex', timeout_s: 1 });
  assert.deepEqual([timedOut.timed_out, timedOut.verdicts.length], [true, 0]);
});

test('plain JSON-RPC works too: a batch, a notification, and an unknown method', async () => {
  const rpc = (body) => board.call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const batch = (await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])).json();
  assert.deepEqual(batch.map((m) => m.id), [1, 2]);
  assert.equal(batch[1].result.tools.length, 5);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).json().error.code, -32601);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'constructor', arguments: {} } })).json().error.code, -32602);
  assert.equal((await board.call('/mcp')).status, 405);
  assert.equal((await board.call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status, 400);
});
