// `glitchless-board sample`: writes a small made-up game folder to try the board on. Every picture and sound
// is made here in code (a seeded sprite generator and a few square waves), so nothing in it comes from a real
// game. The tests use the same folder.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CONFIG_FILE, DEFAULT_PORT } from './config.js';
import { Problem } from './util.js';

// ─── PNG ───

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** An 8-bit RGBA PNG from a canvas ({ w, h, data }). */
export function encodePng({ w, h, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const canvas = (w, h) => ({ w, h, data: Buffer.alloc(w * h * 4) });
function rect(c, x, y, w, h, [r, g, b, a = 255]) {
  for (let yy = Math.max(0, y); yy < Math.min(c.h, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(c.w, x + w); xx++) c.data.set([r, g, b, a], (yy * c.w + xx) * 4);
  }
}

// A small seeded generator, so the same folder comes out every time.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shade = ([r, g, b], f) => [Math.round(r * f), Math.round(g * f), Math.round(b * f)];

/** A mirrored 8 by 8 creature with an outline, as a 10 by 10 grid of 0 (empty), 1 (outline), 2 (body), 3 (shade), 4 (eye). */
function creature(seed) {
  const r = rng(seed);
  const g = Array.from({ length: 10 }, () => new Array(10).fill(0));
  for (let y = 1; y <= 8; y++) {
    for (let x = 1; x <= 4; x++) {
      const on = r() < 0.38 + x * 0.12; // fuller towards the middle
      if (on) g[y][x] = g[y][9 - x] = r() < 0.25 ? 3 : 2;
    }
  }
  g[3][3] = g[3][6] = 4;
  g[3][4] = g[3][5] = g[4][4] = g[4][5] = 2;
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      if (g[y][x]) continue;
      const near = [g[y - 1]?.[x], g[y + 1]?.[x], g[y][x - 1], g[y][x + 1]].some((v) => v > 1);
      if (near) g[y][x] = 1;
    }
  }
  return g;
}

function drawCreature(c, grid, ox, oy, scale, colour) {
  const paint = { 1: [24, 22, 34], 2: colour, 3: shade(colour, 0.68), 4: [250, 250, 245] };
  grid.forEach((row, y) => row.forEach((v, x) => v && rect(c, ox + x * scale, oy + y * scale, scale, scale, paint[v])));
}

function sprite(seed, colour) {
  const c = canvas(80, 80);
  drawCreature(c, creature(seed), 0, 0, 8, colour);
  return encodePng(c);
}

function tile(seed, colour) {
  const c = canvas(64, 64);
  const r = rng(seed);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rect(c, x * 4, y * 4, 4, 4, shade(colour, 0.82 + r() * 0.3).map((v) => Math.min(255, v)));
  return encodePng(c);
}

function scene(seed, sky, ground, cast) {
  const c = canvas(320, 180);
  const r = rng(seed);
  for (let y = 0; y < 180; y += 6) rect(c, 0, y, 320, 6, shade(sky, 1 - y / 420));
  for (let x = 0; x < 320; x += 4) rect(c, x, 96 - Math.round(Math.sin(x / 38 + seed) * 12 + Math.sin(x / 13) * 4), 4, 60, shade(ground, 0.62));
  for (let x = 0; x < 320; x += 8) rect(c, x, 140, 8, 40, shade(ground, 0.85 + r() * 0.25).map((v) => Math.min(255, v)));
  cast.forEach(([s, colour], i) => drawCreature(c, creature(s), 36 + i * 84, 110, 3, colour));
  for (let i = 0; i < 3; i++) rect(c, 10 + i * 12, 10, 8, 8, [226, 74, 74]);
  rect(c, 250, 10, 60, 6, [24, 22, 34]);
  rect(c, 251, 11, 38, 4, [46, 230, 166]);
  return encodePng(c);
}

// ─── WAV ───

const RATE = 22050;

/** A 16-bit mono WAV from a function of time (seconds) returning -1..1. */
export function encodeWav(seconds, fn) {
  const n = Math.round(seconds * RATE);
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, fn(i / RATE, seconds))) * 0.25 * 32767), 44 + i * 2);
  return out;
}

const square = (phase) => (Math.sin(phase) >= 0 ? 1 : -1);
const fade = (t, d) => Math.max(0, 1 - t / d);

function sounds() {
  const noise = rng(7);
  let jump = 0;
  let door = 0;
  return {
    'sfx/jump.wav': encodeWav(0.18, (t, d) => square((jump += (2 * Math.PI * (300 + (600 * t) / d)) / RATE)) * fade(t, d)),
    'sfx/coin.wav': encodeWav(0.27, (t, d) => square(2 * Math.PI * (t < 0.07 ? 988 : 1319) * t) * fade(t, d)),
    'sfx/hit.wav': encodeWav(0.15, (t, d) => ((noise() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 110 * t) * 0.6) * fade(t, d) ** 2),
    'sfx/door.wav': encodeWav(0.35, (t, d) => (((door += (140 - (50 * t) / d) / RATE) % 1) * 2 - 1) * fade(t, d)),
    'music/theme.wav': encodeWav(2, (t) => {
      const notes = [262, 330, 392, 523, 392, 330, 294, 392];
      const f = notes[Math.floor(t * 8) % notes.length];
      return (Math.asin(Math.sin(2 * Math.PI * f * t)) * 2) / Math.PI * (1 - ((t * 8) % 1) * 0.6);
    }),
  };
}

// ─── The folder ───

const CHARACTERS = [
  ['knight', 11, [96, 132, 196], 'A knight in steel blue'],
  ['mage', 23, [164, 104, 212], 'A mage in purple'],
  ['slime', 37, [92, 190, 108], 'A green slime'],
  ['bat', 52, [208, 130, 82], 'An orange bat'],
];
const TILES = [
  ['grass', 3, [98, 164, 92], 'Grass, 16 by 16 cells'],
  ['stone', 5, [136, 136, 150], 'Stone, 16 by 16 cells'],
  ['sand', 8, [214, 190, 130], 'Sand, 16 by 16 cells'],
];
const SOUND_NOTES = {
  jump: ['sfx', 'A rising blip for a jump'],
  coin: ['sfx', 'Two high notes for a coin'],
  hit: ['sfx', 'A short thud for a hit'],
  door: ['sfx', 'A low slide for a door'],
  theme: ['music', 'Eight notes that loop, as a placeholder theme'],
};

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (rows) => `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;

/** Every file of the sample game, as { relative path: Buffer or string }. */
export function sampleFiles({ port = DEFAULT_PORT } = {}) {
  const files = {};
  const artLog = [['file', 'tool', 'date', 'take', 'prompt_file']];
  for (const [name, seed, colour, prompt] of CHARACTERS) {
    files[`art/characters/${name}.png`] = sprite(seed, colour);
    files[`art/prompts/${name}.txt`] = `${prompt}. Mirrored, 8 by 8 cells, one dark outline, two white eyes.\n`;
    artLog.push([`art/characters/${name}.png`, 'the sample generator', '2026-01-05', 1, `prompts/${name}.txt`]);
  }
  // A second knight, to try a Redo with. It shows as a card of its own until an agent posts it as take 2 of the knight.
  files['art/characters/knight_take2.png'] = sprite(12, [96, 132, 196]);
  for (const [name, seed, colour, prompt] of TILES) {
    files[`art/tiles/${name}.png`] = tile(seed, colour);
    files[`art/prompts/${name}.txt`] = `${prompt}, small changes in brightness from cell to cell.\n`;
    artLog.push([`art/tiles/${name}.png`, 'the sample generator', '2026-01-06', 1, `prompts/${name}.txt`]);
  }
  files['art/log.csv'] = csv(artLog);
  files['captures/title.png'] = scene(1, [70, 110, 190], [98, 164, 92], [[11, [96, 132, 196]], [23, [164, 104, 212]]]);
  files['captures/first-fight.png'] = scene(2, [44, 40, 80], [136, 136, 150], [[11, [96, 132, 196]], [37, [92, 190, 108]], [52, [208, 130, 82]]]);
  const audioLog = [['id', 'kind', 'made_with', 'what']];
  for (const [rel, data] of Object.entries(sounds())) {
    files[`audio/${rel}`] = data;
    const id = path.posix.basename(rel, '.wav');
    audioLog.push([id, SOUND_NOTES[id][0], 'the sample generator', SOUND_NOTES[id][1]]);
  }
  files['audio/log.csv'] = csv(audioLog);
  files[CONFIG_FILE] = `${JSON.stringify(
    {
      name: 'Sample Game',
      port,
      sections: [
        { title: 'Screens', kind: 'captures', folder: 'captures' },
        { title: 'Characters', kind: 'pictures', folder: 'art/characters' },
        { title: 'Tiles', kind: 'pictures', folder: 'art/tiles' },
        { title: 'Sound effects', kind: 'sounds', folder: 'audio/sfx' },
        { title: 'Music', kind: 'sounds', folder: 'audio/music' },
      ],
      logs: [
        { file: 'art/log.csv', id: 'file', prompt_file: 'prompt_file' },
        { file: 'audio/log.csv', id: 'id', caption: 'what' },
      ],
    },
    null,
    2,
  )}\n`;
  files['.gitignore'] = '.glitchless/\n';
  return files;
}

/** Writes the sample game into dir, which must be empty or not there yet. Returns the folder. */
export function writeSample(dir, { port } = {}) {
  const root = path.resolve(dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Problem(`${root} is not empty. Give sample a new folder, so it never writes over a game.`);
  for (const [rel, data] of Object.entries(sampleFiles({ port }))) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return root;
}
