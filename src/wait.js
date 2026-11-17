// `glitchless-board wait`: blocks until the owner clicks or another agent leaves a message, then returns.
// The command prints what arrived as JSON and exits, which is what wakes a session that ran it in the
// background.
//
//   exit 0 = verdicts or messages printed, 3 = timed out with nothing, 2 = the board isn't running.

export const WAIT_EXIT = { arrived: 0, nothing: 3, noBoard: 2 };

/** Returns { code, body } or { code: 2, message }. */
export async function waitOnBoard({ port, as = 'agent', timeout = 3600, settle = 2, since } = {}) {
  const qs = new URLSearchParams({ as: String(as), timeout: String(timeout), settle: String(settle) });
  if (since !== undefined && since !== null) qs.set('since', String(since));
  let body;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/wait?${qs}`, { signal: AbortSignal.timeout((Number(timeout) + 30) * 1000) });
    const text = await r.text();
    body = JSON.parse(text);
    if (!r.ok) return { code: WAIT_EXIT.noBoard, message: `The board on port ${port} refused the wait: ${body.error || r.status}` };
  } catch (err) {
    return { code: WAIT_EXIT.noBoard, message: `No board is answering on port ${port} (${err.cause?.code || err.name || err.message}). Start it in the game's folder with: glitchless-board serve` };
  }
  return { code: body.verdicts?.length || body.messages?.length ? WAIT_EXIT.arrived : WAIT_EXIT.nothing, body };
}

/** What the board on a port holds now, or null if none answers. */
export async function boardStatus(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const s = await r.json();
    if (!Array.isArray(s.sections)) return null;
    const count = { waiting: 0, keep: 0, redo: 0 };
    for (const section of s.sections) {
      for (const it of section.items) {
        const m = s.marks[it.id];
        count[!m || !m.v || m.stale ? 'waiting' : m.v === 'redo' ? 'redo' : 'keep']++;
      }
    }
    return { project: s.project, version: s.version, port, url: `http://127.0.0.1:${port}/`, mcp: `http://127.0.0.1:${port}/mcp`, sections: s.sections.length, items: count.waiting + count.keep + count.redo, ...count, agents_waiting: s.waiting, messages: s.messages.length, send_to_codex: s.codex, problems: s.problems };
  } catch {
    return null;
  }
}
