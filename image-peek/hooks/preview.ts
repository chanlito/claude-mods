import type { PeekPreview } from "../types";

/** ▀: the cell's foreground paints the top pixel, its background the bottom. */
const UPPER_HALF = 0x2580;
/** The terminal's own background, for the missing bottom pixel of an odd height. */
const TERMINAL_DEFAULT = 0x01000000;

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const isSpace = (b: number | undefined) =>
  b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/** Packs a picture into Raster cells, two pixel rows per cell row. */
function toCells(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): PeekPreview {
  const rows = Math.ceil(height / 2);
  const words = new Uint32Array(width * rows * 3);
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < width; x++) {
      const w = (r * width + x) * 3;
      words[w] = UPPER_HALF;
      words[w + 1] = pixel(x, 2 * r);
      words[w + 2] =
        2 * r + 1 < height ? pixel(x, 2 * r + 1) : TERMINAL_DEFAULT;
    }
  }
  return { columns: width, rows, cells: toBase64(new Uint8Array(words.buffer)) };
}

/** A binary PPM (P6, maxval 255): what ImageMagick and ffmpeg write. */
export function ppmToPreview(ppm: Uint8Array): PeekPreview | undefined {
  if (ppm[0] !== 0x50 || ppm[1] !== 0x36) return undefined;

  let i = 2;
  const header: number[] = [];
  while (header.length < 3) {
    while (i < ppm.length && isSpace(ppm[i])) i++;
    if (ppm[i] === 0x23) {
      while (i < ppm.length && ppm[i] !== 0x0a) i++;
      continue;
    }
    let value = 0;
    let digits = 0;
    for (
      let b = ppm[i];
      b !== undefined && b >= 0x30 && b <= 0x39;
      b = ppm[++i]
    ) {
      value = value * 10 + (b - 0x30);
      digits++;
    }
    if (digits === 0) return undefined;
    header.push(value);
  }
  i++; // the one whitespace byte between maxval and the pixels

  const [width = 0, height = 0, maxval = 0] = header;
  if (maxval !== 255 || width < 1 || height < 1) return undefined;
  if (ppm.length < i + width * height * 3) return undefined;

  return toCells(width, height, (x, y) => {
    const o = i + (y * width + x) * 3;
    return ((ppm[o] ?? 0) << 16) | ((ppm[o + 1] ?? 0) << 8) | (ppm[o + 2] ?? 0);
  });
}

/** One channel of a BI_BITFIELDS mask, read out and scaled to 0..255. */
function channel(mask: number) {
  if (mask === 0) return () => 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const max = mask >>> shift;
  return (word: number) => Math.round((((word & mask) >>> shift) * 255) / max);
}

/**
 * An uncompressed 24- or 32-bit BMP, bottom-up or top-down: what macOS's
 * `sips` writes, so a Mac needs nothing installed for a preview.
 */
export function bmpToPreview(bmp: Uint8Array): PeekPreview | undefined {
  if (bmp[0] !== 0x42 || bmp[1] !== 0x4d || bmp.length < 54) return undefined;
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const offset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const height = Math.abs(signedHeight);
  if (width < 1 || height < 1 || (bits !== 24 && bits !== 32)) return undefined;

  const stride = Math.ceil((width * bits) / 32) * 4;
  if (bmp.length < offset + stride * height) return undefined;
  const rowAt = (y: number) =>
    offset + (signedHeight > 0 ? height - 1 - y : y) * stride;

  if (bits === 24 || compression === 0) {
    const size = bits / 8;
    return toCells(width, height, (x, y) => {
      const o = rowAt(y) + x * size;
      return ((bmp[o + 2] ?? 0) << 16) | ((bmp[o + 1] ?? 0) << 8) | (bmp[o] ?? 0);
    });
  }
  if (compression !== 3 && compression !== 6) return undefined;
  const red = channel(view.getUint32(54, true));
  const green = channel(view.getUint32(58, true));
  const blue = channel(view.getUint32(62, true));
  return toCells(width, height, (x, y) => {
    const word = view.getUint32(rowAt(y) + x * 4, true);
    return (red(word) << 16) | (green(word) << 8) | blue(word);
  });
}

/** Whichever of the two the preview script printed. */
export const decodePreview = (bytes: Uint8Array) =>
  ppmToPreview(bytes) ?? bmpToPreview(bytes);

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const extensionFor = (mediaType: string) =>
  EXTENSIONS[mediaType] ?? "png";

export const isImagePath = (path: string) =>
  /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic|svg)$/i.test(path);
