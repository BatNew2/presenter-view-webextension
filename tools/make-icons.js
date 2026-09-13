/*
 * Generates the extension icons — no dependencies, just Node's zlib.
 *
 *   node tools/make-icons.js
 *
 * The mark is a lectern with a gooseneck mic, drawn as geometry in a 128-unit
 * design space and rasterised separately at each size, so every icon is sharp
 * rather than a resampled copy of one bitmap. Edit the shapes in GLYPH below
 * and re-run.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4; // sub-samples per axis, so 16x per pixel
const OUT_DIR = path.join(__dirname, "..", "icons");

const TILE_COLOR = [79, 70, 229]; // indigo — reads on both light and dark toolbars
const GLYPH_COLOR = [255, 255, 255];
const TILE_RADIUS = 26; // in design units

// ------------------------------------------------------------------ shapes --
const D = 128; // design space is D x D

/** Distance from a point to a line segment. */
function distToSegment(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((x - x0) * dx + (y - y0) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + t * dx;
  const py = y0 + t * dy;
  return Math.hypot(x - px, y - py);
}

/** Quadratic bezier flattened to segments, used as a round-capped thick stroke. */
function quadPoints(x0, y0, cx, cy, x1, y1, steps = 24) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    points.push([
      mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
      mt * mt * y0 + 2 * mt * t * cy + t * t * y1,
    ]);
  }
  return points;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}

function inStroke(x, y, points, width) {
  const half = width / 2;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (distToSegment(x, y, x0, y0, x1, y1) <= half) return true;
  }
  return false;
}

const MIC_ARM = quadPoints(46, 60, 36, 26, 66, 24);

/** The lectern. Everything in design units, y down. */
function inGlyph(x, y) {
  // Reading desk: a wide slab, tapering slightly towards the floor.
  if (inPolygon(x, y, [[17, 57], [111, 57], [102, 75], [26, 75]])) return true;
  // Stem.
  if (inPolygon(x, y, [[56, 75], [72, 75], [69, 101], [59, 101]])) return true;
  // Base.
  if (inRoundRect(x, y, 35, 101, 93, 113, 5)) return true;
  // Gooseneck mic rising from the left of the desk, bending right.
  if (inStroke(x, y, MIC_ARM, 9)) return true;
  // Mic head.
  if (Math.hypot(x - 66, y - 24) <= 8) return true;
  return false;
}

function inTile(x, y) {
  return inRoundRect(x, y, 0, 0, D, D, TILE_RADIUS);
}

// ------------------------------------------------------------------- raster --
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = D / (size * SUPERSAMPLE);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tileHits = 0;
      let glyphHits = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          if (!inTile(x, y)) continue;
          tileHits++;
          if (inGlyph(x, y)) glyphHits++;
        }
      }

      const alpha = tileHits / samples;
      const offset = (py * size + px) * 4;
      if (alpha === 0) continue;

      // Glyph sits inside the tile, so blend the two by their share of the
      // covered area, then store un-premultiplied colour.
      const glyphShare = glyphHits / tileHits;
      for (let c = 0; c < 3; c++) {
        rgba[offset + c] = Math.round(
          TILE_COLOR[c] * (1 - glyphShare) + GLYPH_COLOR[c] * glyphShare,
        );
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------- png --
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function toPng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------- main --
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, toPng(size, render(size)));
  console.log("wrote", path.relative(path.join(__dirname, ".."), file));
}
