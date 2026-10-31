// Draws the Senderban icon with no image dependency and writes assets/icon.png (256) and
// assets/icon.ico (16/32/48/256, PNG-compressed entries), and the coloured strips of a toast (assets/toast).
// Run: node apps/desktop/scripts/make-icons.mjs
// Every size is drawn from the same vector description (not scaled down), so the small ones stay crisp.
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../assets");
const ICO_SIZES = [16, 32, 48, 256];
const SUPERSAMPLE = 4;

const BLUE = [37, 125, 224];
const RED = [217, 67, 58];

// One strip per spam level. Windows stretches it to the width of the toast; 728 is that width at 200%. It must read on Windows' light
// and dark card, and the word beside the score carries the meaning, so colour is never the only cue.
const STRIP_WIDTH = 728;
const STRIP_HEIGHT = 12;
const STRIPS = { low: [45, 164, 78], medium: [210, 153, 34], high: RED };

/** Signed distance to a rounded rectangle (negative inside). */
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to a line segment. */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Colour at a point of the unit square, or null where the icon is transparent. Drawn on a 32-unit grid, the size of the logo's master. */
function paint(x, y) {
  const u = x * 32;
  const v = y * 32;
  // The ban sign on the corner, in a clear ring: the taskbar shows through, so it reads on a light and on a dark one.
  const fromBan = Math.hypot(u - 24.5, v - 23.5);
  if (fromBan <= 7.5) {
    const ring = Math.abs(fromBan - 5.2) <= 1.2;
    const bar = fromBan <= 5.2 && segment(u, v, 21, 20, 28, 27) <= 1.2;
    return ring || bar ? RED : null;
  }
  const outline = Math.abs(roundRect(u, v, 2.5, 6, 27.5, 24.5, 3.5)) <= 1.3;
  const flap = Math.min(segment(u, v, 4, 8.5, 15, 17), segment(u, v, 15, 17, 26, 8.5)) <= 1.3;
  return outline || flap ? BLUE : null;
}

function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // PNG filter type: none
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const c = paint(
            (px + (sx + 0.5) / SUPERSAMPLE) / size,
            (py + (sy + 0.5) / SUPERSAMPLE) / size,
          );
          if (c === null) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const at = py * (size * 4 + 1) + 1 + px * 4;
      raw[at] = a === 0 ? 0 : Math.round(r / a);
      raw[at + 1] = a === 0 ? 0 : Math.round(g / a);
      raw[at + 2] = a === 0 ? 0 : Math.round(b / a);
      raw[at + 3] = Math.round((255 * a) / n);
    }
  }
  return png(size, size, raw);
}

function strip([r, g, b]) {
  const row = STRIP_WIDTH * 4 + 1;
  const raw = Buffer.alloc(STRIP_HEIGHT * row);
  for (let y = 0; y < STRIP_HEIGHT; y++) {
    raw[y * row] = 0; // PNG filter type: none
    for (let x = 0; x < STRIP_WIDTH; x++) {
      raw.set([r, g, b, 255], y * row + 1 + x * 4);
    }
  }
  return png(STRIP_WIDTH, STRIP_HEIGHT, raw);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(width, height, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head[at] = size === 256 ? 0 : size;
    head[at + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const images = ICO_SIZES.map((size) => ({ size, data: render(size) }));
writeFileSync(join(ASSETS, "icon.png"), images[images.length - 1].data);
writeFileSync(join(ASSETS, "icon.ico"), ico(images));
mkdirSync(join(ASSETS, "toast"), { recursive: true });
for (const [level, colour] of Object.entries(STRIPS)) {
  writeFileSync(join(ASSETS, "toast", `spam-${level}.png`), strip(colour));
}
console.log(`wrote icon.png, icon.ico (${ICO_SIZES.join("/")}) and the toast strips to ${ASSETS}`);
