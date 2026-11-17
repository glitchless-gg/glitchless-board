// glitchless-board: one small local board per game project, where coding agents post things to judge, the
// owner marks them Keep or Redo on a local page, and each verdict reaches the agent that is waiting.
// Used by the glitchless-board command; the same pieces can be used from code.
//
//   const made = await startServer({ dir: gameFolder });       // the page, the API and MCP on 127.0.0.1
//   const { code, body } = await waitOnBoard({ port, as: 'claude' });

export { Problem, cleanName, RESERVED_NAMES } from './util.js';
export { CONFIG_FILE, DEFAULT_PORT, SERVER_NAME, KINDS, MEDIA, POSTED, findConfig, loadConfig } from './config.js';
export { scanProject, liveProject, allowedMedia, parseCsv } from './project.js';
export { openRecord, servingNow, DOORS } from './record.js';
export { createBoard, LIMITS } from './board.js';
export { createMcp } from './mcp.js';
export { createServer, startServer, isBoard, packageVersion } from './server.js';
export { waitOnBoard, boardStatus, WAIT_EXIT } from './wait.js';
export { initProject, planSections, harnessPlans, mergeInto, HARNESS_FLAGS } from './init.js';
export { adoptThread } from './adopt.js';
export { writeSample, sampleFiles, encodePng, encodeWav } from './sample.js';
