/**
 * Discord-optimized raster export.
 *
 * Discord embeds an uploaded image inline only when it clears two limits: the
 * free-tier upload cap (10 MB) and a preview pixel ceiling (community-reported
 * ~90 MP) beyond which it shows as a download link instead. A schematic is flat
 * line art, which is the ideal case for a PALETTE-QUANTIZED (indexed) PNG: at 256
 * colors it is visually lossless yet 2-3x smaller than a full-color PNG, and JPEG
 * would ring around every line and label. So the Discord export caps the long edge
 * to a safe, sharp size and encodes an indexed PNG, stepping the palette (then the
 * resolution) down only if a pathologically busy map would exceed the size budget.
 */
import UPNG from 'upng-js';

/** Byte budget, held under Discord's 10 MB free-tier cap with margin. */
export const DISCORD_MAX_BYTES = 9_500_000;
/** Default long-edge in px. ~13 MP at square, far under the ~90 MP preview cap and
 *  under the ~4096 px per-edge threshold where previews start to get flaky, yet
 *  crisp when the embed is opened to full size. */
export const DISCORD_MAX_EDGE = 3600;
/** Long-edge fallbacks, tried largest first. */
export const DISCORD_EDGE_STEPS: readonly number[] = [DISCORD_MAX_EDGE, 3000, 2400];
/** Palette sizes, tried richest first. 256 is near-lossless for flat line art. */
export const DISCORD_PALETTE_STEPS: readonly number[] = [256, 128, 64];

/** Raw RGBA pixels for one rasterization, plus its dimensions. */
export interface RasterFrame {
  rgba: ArrayBuffer;
  width: number;
  height: number;
}

/** Scale factor that brings the longer side to `edge`. May be > 1: the source is a
 *  vector SVG, so upscaling re-rasterizes crisply rather than blurring. */
export function edgeScale(width: number, height: number, edge: number): number {
  return edge / Math.max(width, height);
}

/** Palette-quantize RGBA pixels into an indexed PNG of at most `cnum` colors.
 *  Returns the raw PNG bytes as an ArrayBuffer (a valid Blob part). */
export function encodePalettePng(rgba: ArrayBuffer, width: number, height: number, cnum: number): ArrayBuffer {
  return UPNG.encode([rgba], width, height, cnum);
}

/**
 * Encode the smallest-but-richest indexed PNG that fits the Discord size budget.
 * `rasterize(edge)` renders the map with its longer side at `edge` px and returns
 * the RGBA pixels; it is called once per edge tried (not per palette). Returns the
 * first encoding under the budget; if none fit (a genuinely huge map), returns the
 * smallest produced so the caller can still download and warn. `maxBytes` is the
 * budget (defaulted; overridable for testing).
 */
export function encodeForDiscord(
  rasterize: (edge: number) => RasterFrame,
  maxBytes = DISCORD_MAX_BYTES,
): { png: ArrayBuffer; fits: boolean } {
  let best: ArrayBuffer | null = null;
  for (const edge of DISCORD_EDGE_STEPS) {
    const { rgba, width, height } = rasterize(edge);
    for (const cnum of DISCORD_PALETTE_STEPS) {
      const png = encodePalettePng(rgba, width, height, cnum);
      if (png.byteLength <= maxBytes) return { png, fits: true };
      if (!best || png.byteLength < best.byteLength) best = png;
    }
  }
  return { png: best!, fits: false };
}
