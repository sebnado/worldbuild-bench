import zlib from "node:zlib";

/**
 * Minimal PNG decoder — enough to analyze Playwright/Chromium screenshots
 * (8-bit, RGB or RGBA, non-interlaced) without an image dependency.
 */
export interface PngStats {
  width: number;
  height: number;
  /** Mean luminance 0-255. */
  meanLuma: number;
  /** Std deviation of luminance — near 0 means a flat/blank frame. */
  stdLuma: number;
  /** Distinct quantized colors sampled across the image. */
  distinctColors: number;
}

export function pngStats(buf: Buffer): PngStats {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG unsupported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  // Undo PNG scanline filters.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const rowOut = pixels.subarray(y * stride, (y + 1) * stride);
    const prevRow = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rowOut[x - bpp] : 0;
      const b = prevRow ? prevRow[x] : 0;
      const c = x >= bpp && prevRow ? prevRow[x - bpp] : 0;
      let v = rowIn[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      rowOut[x] = v;
    }
  }

  // Sample up to ~40k pixels for stats.
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 40_000));
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  const colors = new Set<number>();
  for (let i = 0; i < total; i += step) {
    const o = i * bpp;
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSq += luma * luma;
    n++;
    // Quantize to 4 bits/channel for distinct color counting.
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const mean = sum / n;
  const variance = Math.max(sumSq / n - mean * mean, 0);
  return {
    width,
    height,
    meanLuma: mean,
    stdLuma: Math.sqrt(variance),
    distinctColors: colors.size,
  };
}

/** Heuristic: does this screenshot look like a rendered scene (not blank/black)? */
export function looksRendered(stats: PngStats): boolean {
  return stats.stdLuma > 8 && stats.distinctColors >= 8;
}
