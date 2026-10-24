// Draws the Senderban icon with no image dependency and writes assets/icon.png (256) and
// assets/icon.ico (16/32/48/256, PNG-compressed entries). Run: node apps/desktop/scripts/make-icons.mjs
// Every size is drawn from the same vector description (not scaled down), so the small ones stay crisp.
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../assets");
const ICO_SIZES = [16, 32, 48, 256];
const SUPERSAMPLE = 4;

const BLUE = [11, 95, 255];
const WHITE = [255, 255, 255];
const RED = [229, 72, 77];

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

/** Colour at a point of the unit square, painter's order, or null where the icon is transparent. */
function paint(x, y) {
  if (roundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22) > 0) return null;
  let color = BLUE;
  if (roundRect(x, y, 0.17, 0.28, 0.83, 0.72, 0.06) <= 0) color = WHITE;
  const flap =
    Math.min(segment(x, y, 0.17, 0.3, 0.5, 0.53), segment(x, y, 0.5, 0.53, 0.83, 0.3)) <= 0.022;
  if (flap && color === WHITE) color = BLUE;
  // The ban slash: a white halo under a red bar, so it reads on both the blue ground and the envelope.
  const slash = segment(x, y, 0.24, 0.76, 0.76, 0.24);
  if (slash <= 0.1) color = WHITE;
  if (slash <= 0.065) color = RED;
  return color;
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
  return png(size, raw);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
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
console.log(`wrote icon.png and icon.ico (${ICO_SIZES.join("/")}) to ${ASSETS}`);
