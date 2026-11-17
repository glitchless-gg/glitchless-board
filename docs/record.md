# The board's record

For tools that want to read what happened on a board, or to join one without the board changing.

## Where it is

In the game's folder, under `.glitchless/board/`:

| File | What it holds |
| --- | --- |
| `events.jsonl` | The record: one JSON object per line, append-only. |
| `cursors.json` | How far each waiting name has been told. |
| `server.json` | The process and port serving this record now. Removed when the board stops. |

Only the board writes these. `adopt` writes to `events.jsonl` from the command line, and only while the board is stopped. Read them freely; don't write to them.

## Every line

```json
{ "seq": 12, "at": "2026-01-05T10:15:30.000Z", "type": "verdict", "door": "page", "item": "Characters/knight.png", "verdict": "redo", "take": 1, "note": "the helmet is too dark", "by": "owner" }
```

| Field | Meaning |
| --- | --- |
| `seq` | 1, 2, 3 and so on. The order things happened in. |
| `at` | When, in UTC. |
| `type` | What happened (below). |
| `door` | How it came in: `page` (a click on the board's page), `mcp` (a tool call), `cli` (a command), `codex` (an answer read back from Codex). A line without a door is refused. |

A line cut short by a crash is skipped when the record is read.

## Types

| `type` | Door | Fields | Meaning |
| --- | --- | --- | --- |
| `post` | `mcp` | `item`, `title`, `take`, `files`, `note`, `by` | An agent put a take on the board. `files` are real paths inside the configured folders. `by` is the name the agent gave. |
| `verdict` | `page` | `item`, `verdict`, `take`, `note`, `by` | A click. `verdict` is `keep`, `redo`, `pick` or `null`. With `null`, a `note` makes it a bare note, and no note means the verdict was taken back. `take` is the take it is about. `by` is `owner`. |
| `message` | `mcp` | `from`, `to`, `text` | A message between agents. `to` is a name or `all`. `from` is self-declared. |
| `thread` | `cli` | `thread`, `key`, `member`, `name`, `how` | A Codex thread the owner adopted. |
| `link` | `cli` | `item`, `thread` | The owner said that thread made that item. |
| `sent` | `page` | `item`, `thread`, `verdict`, `verdict_seq`, `note`, `to`, `how`, `by` | A press of Send to Codex. |
| `reply` | `codex` | `item`, `thread`, `text`, `how`, `tools` | What Codex answered to a send. |

## Items and takes

An item's id is its section's title, a slash, and the file's path inside the section's folder: `Characters/knight.png`. Something an agent posted that is not already a file on the board gets `Posted/` and a short form of its title.

A file the game holds is take 1 of its item. Each `post` for that item is the next take. An item's state is worked out from the record:

- `waiting`: no verdict, or a take was posted after the last one.
- `keep`: the last verdict is `keep` or `pick`.
- `redo`: the last verdict is `redo`.

## Joining without MCP

A tool that can make HTTP requests on the same computer can use these, at `http://127.0.0.1:<port>`:

| Request | Answer |
| --- | --- |
| `GET /api/state` | Everything the page shows: sections, items, takes, marks, messages, who is waiting. |
| `GET /api/wait?as=<name>&timeout=<s>&settle=<s>` | Stays open until a verdict or a message arrives for that name, then answers with it. |
| `POST /mcp` | JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`. One JSON answer per request; no session. |
| `GET /api/ping` | `{ "board": "glitchless-board", ... }` if a board is there. |

Giving a verdict needs the token in the board's own page, on purpose. A tool has joined when it can post a take and wait for the verdict.
