# Notice

glitchless-board has no runtime dependencies: it is plain Node.

Its tests drive the board's MCP endpoint with the official client from the
[Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT, Copyright (c) 2024 Anthropic, PBC), installed as a development dependency only. It is not part of the published package.

The optional "Send to Codex" feature talks to the `codex` command a person has installed themself. No Codex code is included.

glitchless-board is not made or endorsed by Anthropic, OpenAI or Anysphere. Claude and Claude Code are trademarks of Anthropic, PBC. Codex and ChatGPT are trademarks of OpenAI. Cursor is a trademark of Anysphere, Inc.
