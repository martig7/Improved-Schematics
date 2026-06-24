// The detail-area (selection) lifecycle decision, extracted as a PURE function so its
// invariants can be unit-tested apart from the React render effect that drives it.
//
// Detail areas are drawn in render-pixel coordinates, so a set of areas is valid ONLY
// against the exact layout it was drawn on. The render effect ("the inject") calls this
// once per (re)paint with the current layout key and decides whether to restore, clear,
// or keep the on-screen areas. Getting this wrong has two failure modes, both seen in the
// wild: clearing on a spurious re-render / same-fp regenerate (areas vanish though the
// layout is identical) and, conversely, resurrecting stale areas onto a different layout.
//
// The layout key is `s:<fingerprint>` in smoothed mode and `m:<mode>` in any non-smoothed
// mode. Inputs:
//   queuedRestore — areas queued by a fresh generate-with-saved-areas or a file load
//                   (restoreSelectionsRef). Highest priority; always installed.
//   prevKey       — the key from the previous paint (undefined on the very first paint).
//   nextKey       — the key for this paint.
//   isSmoothed    — whether this paint is in smoothed mode.
//   snapshot      — the in-memory copy of the last smoothed-mode areas. This is what
//                   survives a smoothed↔non-smoothed round-trip: the smoothed layout is
//                   still cached (so nothing gets queued) AND a file-loaded layout has no
//                   durable store backing (its fingerprint is null), so the in-memory
//                   snapshot — not the store — is the only correct source.

export type AreaAction<T> =
  | { kind: 'restore'; selections: T[] }
  | { kind: 'clear' }
  | { kind: 'keep' };

export interface AreaDecisionInput<T> {
  queuedRestore: T[] | null;
  prevKey: string | undefined;
  nextKey: string;
  isSmoothed: boolean;
  snapshot: T[];
}

export function decideAreaAction<T>(i: AreaDecisionInput<T>): AreaAction<T> {
  // (1) An explicit queued restore (fresh generate with saved areas, or a file load) wins
  //     outright — it carries the areas for the layout being installed this paint.
  if (i.queuedRestore) return { kind: 'restore', selections: i.queuedRestore };

  // (4) Same key, or the very first paint: a spurious re-render / same-fp regenerate /
  //     label-station toggle — the layout is unchanged, so keep what's on screen.
  if (i.prevKey === undefined || i.nextKey === i.prevKey) return { kind: 'keep' };

  // The key changed.
  // (2) Returning to smoothed from a non-smoothed mode (m:* -> s:*): the smoothed layout
  //     is the SAME one we left (its cache is still populated), so reinstate the in-memory
  //     snapshot. Trusting the snapshot is safe ONLY here, because we know the layout is
  //     unchanged; an empty snapshot (no areas, or a genuine delete-all) falls through to
  //     a clear, which is a no-op when already empty and correctly avoids resurrection.
  const cameFromOtherMode = i.isSmoothed && i.prevKey.startsWith('m:');
  if (cameFromOtherMode && i.snapshot.length > 0) return { kind: 'restore', selections: i.snapshot };

  // (3) Any other key change — a genuinely different smoothed fingerprint, or a switch INTO
  //     a non-smoothed mode — the on-screen boxes are stale (wrong-layout coords): clear.
  return { kind: 'clear' };
}
