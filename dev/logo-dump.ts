/**
 * Build a synthetic "logo city" dump: each word becomes one station capsule whose
 * per-line bullets spell the word. See docs/superpowers/specs/2026-07-01-logo-render-design.md.
 *
 * Topology per word: a capsule node `A` (all letter-lines stop) plus a pass-through
 * node `T` due north (letter-lines run through it but never stop, so it draws nothing
 * and no duplicate capsule appears). Each letter is a route whose single combo is
 * `A → (track at T) → A`, giving visits [A stop, T non-stop, A stop] — one shared
 * edge A–T that fans the bullets east–west into a horizontal word.
 */

import type { Coordinate } from '../src/types/core';

export interface LogoWord {
  /** The text to spell; one bullet (letter) per character. */
  text: string;
  /** [lng, lat] of the capsule node A (where the word appears). */
  anchor: Coordinate;
}

export interface LogoOptions {
  /** Latitude delta from capsule A to pass-through T (the north "tail" length), degrees. */
  northDelta?: number;
  /** Per-letter rainbow palette (must be at least as long as the longest word to avoid
   *  two same-letter positions collapsing into one line). */
  palette?: string[];
  /** Shift where each word starts reading the palette (0 = every word starts at red). */
  paletteOffsetPerWord?: number;
}

/** Bright, dark-legible rainbow (Apple-system-ish); length 10 covers our longest word. */
export const RAINBOW: string[] = [
  '#ff3b30', // red
  '#ff9500', // orange
  '#ffcc00', // yellow
  '#34c759', // green
  '#00c7be', // teal
  '#30b0ff', // sky
  '#0a84ff', // blue
  '#5e5ce6', // indigo
  '#bf5af2', // purple
  '#ff2d92', // pink
];

const pad2 = (n: number): string => (n < 10 ? '0' + n : '' + n);

interface DumpStation {
  id: string;
  name: string;
  coords: Coordinate;
  stNodeIds: string[];
  trackIds: string[];
  trackGroupId: string;
  buildType: 'constructed';
  routeIds: string[];
  createdAt: number;
  nearbyStations: [];
}

const mkStation = (
  id: string,
  name: string,
  coords: Coordinate,
  stNodeIds: string[],
  trackIds: string[],
  trackGroupId: string,
): DumpStation => ({
  id,
  name,
  coords,
  stNodeIds,
  trackIds,
  trackGroupId,
  buildType: 'constructed',
  routeIds: [],
  createdAt: 0,
  nearbyStations: [],
});

export function buildLogoDump(words: LogoWord[], opts: LogoOptions = {}) {
  const northDelta = opts.northDelta ?? 0.02;
  const palette = opts.palette ?? RAINBOW;
  const paletteOffsetPerWord = opts.paletteOffsetPerWord ?? 0;

  const stations: DumpStation[] = [];
  const stationGroups: { id: string; name: string; center: Coordinate; stationIds: string[] }[] = [];
  const routes: Record<string, unknown>[] = [];

  words.forEach((word, wi) => {
    const slug = word.text.replace(/[^a-z0-9]/gi, '').toLowerCase() + '_' + wi;
    const [lng, lat] = word.anchor;
    const aSn = `A_sn_${slug}`;
    const tSn = `T_sn_${slug}`;
    const gA = `gA_${slug}`;
    const gT = `gT_${slug}`;
    const tNorth = `t_north_${slug}`;

    // Capsule node A — its own group. Pass-through node T due north — its own group,
    // carrying the corridor track id (via trackIds; no real Track object required).
    stations.push(mkStation(`st_A_${slug}`, word.text, [lng, lat], [aSn], [], gA));
    stations.push(mkStation(`st_T_${slug}`, '', [lng, lat + northDelta], [tSn], [tNorth], gT));

    stationGroups.push({ id: gA, name: word.text, center: [lng, lat], stationIds: [`st_A_${slug}`] });
    stationGroups.push({ id: gT, name: '', center: [lng, lat + northDelta], stationIds: [`st_T_${slug}`] });

    const letters = [...word.text];
    letters.forEach((ch, k) => {
      // Lane slot 0 seats to the RIGHT, so ascending id → right-to-left. Reverse the
      // id index (N-1-k) so the sorted order reads LEFT → RIGHT as written.
      const idIndex = letters.length - 1 - k;
      routes.push({
        id: `${slug}_${pad2(idIndex)}_${ch}`, // sorted id order fixes left→right letter order
        name: word.text,
        bullet: ch.toUpperCase(),
        color: palette[(k + wi * paletteOffsetPerWord) % palette.length],
        textColor: '#ffffff',
        shape: 'circle',
        stCombos: [
          // A → (track at T) → A: visits [A stop, T non-stop, A stop] → one shared
          // edge A–T, capsule at A only (T is a pass-through, draws nothing). This
          // seats the capsule dots most cleanly; the residual lane overshoot ("nub")
          // is cropped in the compose step (dev/render-logo.ts).
          {
            startStNodeId: aSn,
            endStNodeId: aSn,
            path: [{ trackId: tNorth, reversed: false, length: 100, signals: [] }],
            distance: 100,
          },
        ],
      });
    });
  });

  return { routes, tracks: [] as unknown[], stations, stationGroups };
}
