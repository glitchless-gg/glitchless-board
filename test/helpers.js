// Shared by the tests: a scratch copy of the sample game, a board on a free port, and plain HTTP calls with
// full control of the headers. Nothing here touches a real harness, a real home folder or a fixed port.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBoard, createServer, loadConfig, openRecord, writeSample } from '../src/index.js';

const made = [];

/** A new empty folder, as a real path (macOS keeps its temp folder behind a link). */
export function scratch(name = 'board') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `glitchless-${name}-`)));
  made.push(dir);
  return dir;
}

export function cleanUp() {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** The sample game in a scratch folder. */
export function sampleGame() {
  return writeSample(path.join(scratch('game'), 'game'));
}

/** A board over a game folder with no server: for the record, delivery and message rules. */
export function boardOver(dir, options = {}) {
  const config = loadConfig(dir);
  const record = openRecord(config.stateDir);
  const { limits, ...rest } = options;
  return { config, record, board: createBoard({ config, record, ...rest, limits: { settleCap: 1, ...limits } }) };
}

/** A served board on a free port. */
export async function serve(dir, options = {}) {
  const config = loadConfig(dir);
  const server = createServer({ config, ...options, limits: { settleCap: 1, ...options.limits } });
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    ...server,
    port,
    base,
    call: (pathname, opts) => call(port, pathname, opts),
    /** A verdict the way the page gives one: with this run's token. */
    verdict: (body) => call(port, '/api/verdict', { method: 'POST', body: JSON.stringify(body), headers: { 'x-board-owner': server.token, 'content-type': 'application/json' } }),
    close: () => server.close(),
  };
}

/** One HTTP request. `host` sets the Host header; the answer is { status, headers, text, json() }. */
export function call(port, pathname, { method = 'GET', host, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: host || `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8'), json: () => JSON.parse(buffer.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Waits as a name, with no settling and a short limit unless told otherwise. */
export const waitAs = (board, name, { timeout = 0.25, settle = 0, since } = {}) => board.startWait({ name, timeout, settle, since }).promise;
