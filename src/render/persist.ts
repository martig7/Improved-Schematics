// Serialize/deserialize a generated smoothed map so it can be saved to a file and
// reloaded instantly — skipping the expensive octi precompute on every mod reload.
//
// The precompute (SmoothedPrecomputed) is almost all plain data, but it nests
// several Maps (layout.nodes, layout.edges[].stops, layout.lineTraversals,
// nodePx, stationPx, stations[].stopNodes) and carries one function, `unproject`.
// JSON can't represent either, so: a Map-aware replacer/reviver round-trips the
// Maps, and `unproject` — which is separable and monotone per axis (render-x ⟷
// lng, render-y ⟷ lat) — is stored as two 1-D sample tables and rebuilt by linear
// interpolation. drawSmoothedSchematic never reads `unproject`, so a restored map
// draws byte-identically; only the magnifier's box→geo step uses it.

import type { SmoothedPrecomputed } from './schematic';

const MAP_TAG = '__impmap__';
const N = 256; // unproject sample count per axis

export interface MapBundle {
  version: number;
  city: string;
  /** Opaque UI settings blob (mode, toggles, applied appearance, export prefs). */
  settings: unknown;
  /** Opaque detail-area selections (plain data: id/box/color/name). */
  selections?: unknown;
  pre: SmoothedPrecomputed | string;
}

function replacer(_k: string, v: unknown): unknown {
  return v instanceof Map ? { [MAP_TAG]: Array.from(v as Map<unknown, unknown>) } : v;
}
function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, MAP_TAG)) {
    return new Map((v as Record<string, [unknown, unknown][]>)[MAP_TAG]);
  }
  return v;
}

function sampleUnproject(pre: SmoothedPrecomputed): { ux: number[]; uy: number[] } {
  const ux: number[] = [];
  const uy: number[] = [];
  for (let i = 0; i <= N; i++) {
    ux.push(pre.unproject([(i / N) * pre.width, pre.height / 2])[0]); // lng at render-x
    uy.push(pre.unproject([pre.width / 2, (i / N) * pre.height])[1]); // lat at render-y
  }
  return { ux, uy };
}
function rebuildUnproject(ux: number[], uy: number[], w: number, h: number): SmoothedPrecomputed['unproject'] {
  const at = (t: number, a: number[]): number => {
    if (t <= 0) return a[0];
    if (t >= N) return a[N];
    const i = Math.floor(t);
    return a[i] + (a[i + 1] - a[i]) * (t - i);
  };
  return ([px, py]) => [at((px / w) * N, ux), at((py / h) * N, uy)];
}

export function serializeMap(bundle: MapBundle): string {
  const unproj = typeof bundle.pre === 'string' ? null : sampleUnproject(bundle.pre);
  return JSON.stringify({ ...bundle, unproj }, replacer);
}

/** Throws on malformed JSON / wrong shape — callers should try/catch. */
export function deserializeMap(json: string): MapBundle {
  const obj = JSON.parse(json, reviver) as MapBundle & { unproj?: { ux: number[]; uy: number[] } | null };
  if (typeof obj.version !== 'number' || obj.pre == null) throw new Error('not an Improved Schematics map file');
  if (obj.unproj && typeof obj.pre !== 'string') {
    const pre = obj.pre as SmoothedPrecomputed;
    pre.unproject = rebuildUnproject(obj.unproj.ux, obj.unproj.uy, pre.width, pre.height);
  }
  return obj;
}
