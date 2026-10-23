/**
 * Minimal PNG reader for test assertions.
 *
 * Playwright hands back a PNG buffer, and the figure has to be measured from
 * that rather than from the canvas: reading pixels back out of a WebGL
 * canvas returns an empty buffer unless the context was created with
 * preserveDrawingBuffer, and turning that on in production to make a test
 * easier is the wrong trade. Playwright's screenshots always carry 8-bit
 * RGBA, non-interlaced, so only that case is handled.
 */
import { inflateSync } from "node:zlib";

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG ${depth}bit i${interlace}`);
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colour}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each row is prefixed with its filter type
  // and is predicted from the pixel to its left (a) and the row above (b).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? dst[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      dst[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Lit fraction, blown-out fraction and mean luma of a screenshot. */
export function exposure(png) {
  const { width, height, channels, data } = png;
  let lit = 0, blown = 0, sum = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const l = (r + g + b) / 3;
    sum += l;
    // The page's own background sits around luma 10, so "lit" starts above it.
    if (l > 26) lit++;
    if (r > 250 && g > 250 && b > 250) blown++;
  }
  return { litFraction: lit / n, blownFraction: blown / n, meanLuma: sum / n };
}
