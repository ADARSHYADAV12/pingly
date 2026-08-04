// Generates resources/icons/*.ico and resources/sounds/*.wav from code.
// Run with `node scripts/gen-assets.mjs`; the committed output is the shipped asset.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- the Pingly mascot, drawn on a 32-unit grid ---------------- */

const CREAM = [239, 235, 228];
const DARK = [19, 19, 22];
const AMBER = [245, 165, 36];
const EYE = [242, 240, 234];

const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const roundRect = (x0, y0, w, h, r) => (x, y) => {
  if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r));
  const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r));
  return dx * dx + dy * dy <= r * r;
};

/** Thick line with rounded ends — used for the antenna and the little arms. */
const capsule = (x1, y1, x2, y2, r) => (x, y) => {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / len2));
  const dx = x - (x1 + t * vx);
  const dy = y - (y1 + t * vy);
  return dx * dx + dy * dy <= r * r;
};

// painter order: later entries draw over earlier ones
const MASCOT = [
  [capsule(16, 6.5, 16, 10.5, 0.75), AMBER], // antenna stem
  [circle(16, 5.6, 2), AMBER], // antenna bulb
  [capsule(8.6, 19, 6.6, 23, 2.3), CREAM], // left arm
  [capsule(23.4, 19, 26, 15.6, 2.3), CREAM], // right arm, mid-wave
  [roundRect(9.6, 26.2, 4.6, 2.9, 1.4), AMBER], // feet
  [roundRect(17.8, 26.2, 4.6, 2.9, 1.4), AMBER],
  [roundRect(6.4, 10.8, 19.2, 17, 8.2), CREAM], // body
  [roundRect(9.4, 13.9, 13.2, 9.6, 4.3), DARK], // visor
  [circle(13.3, 18.3, 1.15), EYE], // eyes
  [circle(18.7, 18.3, 1.15), EYE]
];

/** Renders the mascot at size S with 4x4 supersampling for clean edges. */
function mascotPixels(S) {
  const px = Buffer.alloc(S * S * 4); // BGRA, bottom-up
  const k = S / 32;
  const N = 4;

  for (let py = 0; py < S; py++) {
    for (let pxi = 0; pxi < S; pxi++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = (pxi + (sx + 0.5) / N) / k;
          const y = (py + (sy + 0.5) / N) / k;
          let color = null;
          for (const [inside, c] of MASCOT) if (inside(x, y)) color = c;
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            hits++;
          }
        }
      }
      if (!hits) continue;
      const a = hits / (N * N);
      const i = ((S - 1 - py) * S + pxi) * 4;
      px[i] = b / hits;
      px[i + 1] = g / hits;
      px[i + 2] = r / hits;
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/* ---------------- ico container ---------------- */

function iconImage(S) {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(S, 4);
  info.writeInt32LE(S * 2, 8); // XOR + AND mask
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  const mask = Buffer.alloc((S / 8) * S); // 32bpp still needs an (empty) AND mask
  return Buffer.concat([info, mascotPixels(S), mask]);
}

/** Packs one or more sizes into a single .ico. Size byte 0 means 256. */
function ico(sizes) {
  const images = sizes.map(iconImage);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((S, i) => {
    const e = Buffer.alloc(16);
    e[0] = S >= 256 ? 0 : S;
    e[1] = S >= 256 ? 0 : S;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images]);
}

/* ---------------- wav: 16-bit mono 44.1k ---------------- */

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(44100, 24);
  h.writeUInt32LE(88200, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// tones: [{ freq, startMs, durMs, gain }] with a soft attack + exponential decay
function tones(totalMs, parts) {
  const n = Math.round((44100 * totalMs) / 1000);
  const out = new Float64Array(n);
  for (const p of parts) {
    const s0 = Math.round((44100 * p.startMs) / 1000);
    const len = Math.round((44100 * p.durMs) / 1000);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const t = i / 44100;
      const attack = Math.min(1, i / 300);
      const env = attack * Math.exp((-4 * i) / len);
      out[s0 + i] += p.gain * env * (Math.sin(2 * Math.PI * p.freq * t) + 0.25 * Math.sin(4 * Math.PI * p.freq * t));
    }
  }
  return out;
}

const done = tones(400, [{ freq: 880, startMs: 0, durMs: 400, gain: 0.22 }]);
const attention = tones(520, [
  { freq: 740, startMs: 0, durMs: 230, gain: 0.3 },
  { freq: 988, startMs: 190, durMs: 330, gain: 0.3 }
]);

mkdirSync(join(root, 'resources/icons'), { recursive: true });
mkdirSync(join(root, 'resources/sounds'), { recursive: true });
writeFileSync(join(root, 'resources/icons/tray.ico'), ico([16, 24, 32, 48]));
// electron-builder requires the app icon to include a 256x256 image
writeFileSync(join(root, 'resources/icons/app.ico'), ico([16, 32, 48, 64, 128, 256]));
writeFileSync(join(root, 'resources/sounds/done.wav'), wav(done));
writeFileSync(join(root, 'resources/sounds/attention.wav'), wav(attention));
console.log('assets written');
