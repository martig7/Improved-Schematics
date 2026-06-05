// Octilinear simplification (the "schematicness" relaxation) ported from the game
// (dev/reference/nearestOctilinearUnit.js, simplifyLayout.js), plus a new
// geographic-anchored variant (smoothGeographic) for the Smoothed render mode.

import type { TransitGraph, Layout, Pixel } from './types';
import {
  OCT_UNIT,
  ITERATIONS,
  TARGET_EDGE_CELLS,
  EDGE_STIFFNESS,
  REPULSE_MIN_CELLS,
  REPULSE_STRENGTH,
  BEND_STIFFNESS,
  MAX_STEP_PER_ITER,
} from '../constants';
import { findFreeCell, rebuildLayoutFromCells } from './octilinear';
import type { Cell } from './types';

/** Snap a direction vector to the nearest of the 8 octilinear unit directions. */
export function nearestOctilinearUnit(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [1, 0];
  const ux = dx / len;
  const uy = dy / len;
  let best = OCT_UNIT[0];
  let bestDot = -Infinity;
  for (const u of OCT_UNIT) {
    const dot = ux * u[0] + uy * u[1];
    if (dot > bestDot) {
      bestDot = dot;
      best = u;
    }
  }
  return best;
}

/**
 * Relax the grid layout so edges align to 8 directions: edge springs toward an
 * octilinear ideal, pairwise repulsion, bend-straightening along lines, with a
 * per-iteration step clamp. Re-snaps to integer cells and rebuilds.
 */
export function simplifyLayout(layout: Layout, graph: TransitGraph): Layout {
  if (layout.nodes.size < 2 || layout.edges.length === 0) return layout;

  const pos = new Map<string, [number, number]>();
  for (const [id, n] of layout.nodes) pos.set(id, [n.cell[0], n.cell[1]]);
  const ids = [...pos.keys()];
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));

  // Per-line node chains for bend-straightening.
  const chains: string[][] = [];
  for (const steps of layout.lineTraversals.values()) {
    if (steps.length === 0) continue;
    const chain: string[] = [];
    for (const step of steps) {
      const edge = edgeById.get(step.edgeId);
      if (!edge) continue;
      const a = step.reversed ? edge.to : edge.from;
      const b = step.reversed ? edge.from : edge.to;
      if (chain.length === 0) chain.push(a);
      else if (chain[chain.length - 1] !== a) chain.push(a);
      chain.push(b);
    }
    if (chain.length >= 3) chains.push(chain);
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const force = new Map<string, [number, number]>();
    for (const id of ids) force.set(id, [0, 0]);

    // edge springs toward octilinear ideal
    for (const edge of layout.edges) {
      const pf = pos.get(edge.from);
      const pt = pos.get(edge.to);
      if (!pf || !pt) continue;
      const dx = pt[0] - pf[0];
      const dy = pt[1] - pf[1];
      const [ux, uy] = nearestOctilinearUnit(dx, dy);
      const tx = ux * TARGET_EDGE_CELLS;
      const ty = uy * TARGET_EDGE_CELLS;
      const fx = (tx - dx) * EDGE_STIFFNESS;
      const fy = (ty - dy) * EDGE_STIFFNESS;
      const ff = force.get(edge.from)!;
      const ft = force.get(edge.to)!;
      ff[0] -= fx * 0.5;
      ff[1] -= fy * 0.5;
      ft[0] += fx * 0.5;
      ft[1] += fy * 0.5;
    }

    // pairwise repulsion within REPULSE_MIN_CELLS
    for (let i = 0; i < ids.length; i++) {
      const pi = pos.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const pj = pos.get(ids[j])!;
        const dx = pj[0] - pi[0];
        const dy = pj[1] - pi[1];
        const dist = Math.hypot(dx, dy);
        if (dist >= REPULSE_MIN_CELLS) continue;
        const fi = force.get(ids[i])!;
        const fj = force.get(ids[j])!;
        if (dist < 1e-3) {
          fi[0] -= 0.4;
          fj[0] += 0.4;
          continue;
        }
        const overlap = REPULSE_MIN_CELLS - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        const strength = (overlap / REPULSE_MIN_CELLS) * REPULSE_STRENGTH;
        fi[0] -= nx * strength;
        fi[1] -= ny * strength;
        fj[0] += nx * strength;
        fj[1] += ny * strength;
      }
    }

    // bend-straightening along line chains
    for (const chain of chains) {
      for (let k = 1; k < chain.length - 1; k++) {
        const a = pos.get(chain[k - 1]);
        const b = pos.get(chain[k]);
        const c = pos.get(chain[k + 1]);
        if (!a || !b || !c) continue;
        const midx = (a[0] + c[0]) / 2;
        const midy = (a[1] + c[1]) / 2;
        const f = force.get(chain[k])!;
        f[0] += (midx - b[0]) * BEND_STIFFNESS;
        f[1] += (midy - b[1]) * BEND_STIFFNESS;
      }
    }

    // apply with per-iteration step clamp
    for (const id of ids) {
      const p = pos.get(id)!;
      const f = force.get(id)!;
      const mag = Math.hypot(f[0], f[1]);
      if (mag > MAX_STEP_PER_ITER) {
        const s = MAX_STEP_PER_ITER / mag;
        f[0] *= s;
        f[1] *= s;
      }
      p[0] += f[0];
      p[1] += f[1];
    }
  }

  // re-snap to integer cells (high-degree first), then rebuild
  const order = [...ids].sort((a, b) => {
    const da = graph.adj.get(a)?.length ?? 0;
    const db = graph.adj.get(b)?.length ?? 0;
    if (db !== da) return db - da;
    return a.localeCompare(b);
  });
  const newCells = new Map<string, Cell>();
  const used = new Map<string, string>();
  for (const id of order) {
    const p = pos.get(id)!;
    newCells.set(id, findFreeCell([Math.round(p[0]), Math.round(p[1])], id, used));
  }
  return rebuildLayoutFromCells(graph, newCells);
}

/** Smoothed mode: octilinear-leaning relaxation anchored to geography. */
const ANCHOR_STIFFNESS = 0.25; // tuning knob (not from the game)

export function smoothGeographic(graph: TransitGraph): Map<string, Pixel> {
  const orig = new Map<string, Pixel>();
  const pos = new Map<string, [number, number]>();
  for (const [id, n] of graph.nodes) {
    orig.set(id, [n.pos[0], n.pos[1]]);
    pos.set(id, [n.pos[0], n.pos[1]]);
  }
  if (graph.nodes.size < 2 || graph.edges.length === 0) return orig;

  const lengths = graph.edges.map((e) => {
    const a = graph.nodes.get(e.from)!.pos;
    const b = graph.nodes.get(e.to)!.pos;
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  });
  lengths.sort((p, q) => p - q);
  const median = lengths[Math.floor(lengths.length / 2)] || 1;
  const maxStep = (median / TARGET_EDGE_CELLS) * MAX_STEP_PER_ITER;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const force = new Map<string, [number, number]>();
    for (const id of pos.keys()) force.set(id, [0, 0]);

    for (const e of graph.edges) {
      const pf = pos.get(e.from)!;
      const pt = pos.get(e.to)!;
      const dx = pt[0] - pf[0];
      const dy = pt[1] - pf[1];
      const [ux, uy] = nearestOctilinearUnit(dx, dy);
      const fx = (ux * median - dx) * EDGE_STIFFNESS;
      const fy = (uy * median - dy) * EDGE_STIFFNESS;
      const ff = force.get(e.from)!;
      const ft = force.get(e.to)!;
      ff[0] -= fx * 0.5;
      ff[1] -= fy * 0.5;
      ft[0] += fx * 0.5;
      ft[1] += fy * 0.5;
    }

    for (const [id, p] of pos) {
      const o = orig.get(id)!;
      const f = force.get(id)!;
      f[0] += (o[0] - p[0]) * ANCHOR_STIFFNESS;
      f[1] += (o[1] - p[1]) * ANCHOR_STIFFNESS;
      const mag = Math.hypot(f[0], f[1]);
      if (mag > maxStep) {
        const s = maxStep / mag;
        f[0] *= s;
        f[1] *= s;
      }
      p[0] += f[0];
      p[1] += f[1];
    }
  }

  const out = new Map<string, Pixel>();
  for (const [id, p] of pos) out.set(id, [p[0], p[1]]);
  return out;
}
