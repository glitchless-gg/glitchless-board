// `glitchless-board prompt`: the set-up prompt a person pastes into their coding agent.
//
// It is kept in one place, docs/agent-setup-prompt.md, between two markers. The command prints it from
// there and the README carries a copy, which a test compares, so the three cannot drift apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Problem } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_FILE = path.join(HERE, '..', 'docs', 'agent-setup-prompt.md');
const BLOCK = /<!-- setup-prompt:start -->\s*```text\n([\s\S]*?)\n```\s*<!-- setup-prompt:end -->/;

/** The prompt inside a Markdown file's setup-prompt markers, or null. */
export function promptIn(markdown) {
  return BLOCK.exec(markdown)?.[1] ?? null;
}

/** The set-up prompt, as plain text. */
export function setupPrompt() {
  const text = promptIn(fs.readFileSync(PROMPT_FILE, 'utf8'));
  if (text == null) throw new Problem(`${PROMPT_FILE} has no set-up prompt between its markers.`);
  return text;
}
