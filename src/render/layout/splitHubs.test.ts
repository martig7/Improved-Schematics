import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupportGraph, SupportEdge, SupportNode, Pixel } from './types';
import { splitHubs } from './splitHubs';
import { combineDeg2 } from './octi';

// Build a star hub: one centre node `hub` with `arms` spokes, each carrying a
// bundle of distinct lines. The hub is a station group `G`. linesPerArm defaults
// to 5 so the hub qualifies under the Phase-1 predicate (directionality >= 3 AND
// maxBundle >= 5): it is both a real fan-out and a big welded trunk.
function starHub(arms: number, linesPerArm = 5): SupportGraph {
  const nodes = new Map<string, SupportNode>();
  const edges = new Map<string, SupportEdge>();
  const adj = new Map<string, string[]>();
  const lineRefs = new Map<string, { id: string; label: string; color: string }>();
  const stopAt = new Set<string>();
  nodes.set('hub', { id: 'hub', pos: [0, 0] });
  adj.set('hub', []);
  let lineSeq = 0;
  for (let i = 0; i < arms; i++) {
    const ang = (i / arms) * Math.PI * 2;
    const tip: Pixel = [Math.cos(ang) * 200, Math.sin(ang) * 200];
    const tipId = 't' + i;
    nodes.set(tipId, { id: tipId, pos: tip });
    adj.set(tipId, []);
    const lineIds = new Set<string>();
    for (let k = 0; k < linesPerArm; k++) {
      const lid = 'L' + lineSeq++;
      lineIds.add(lid);
      lineRefs.set(lid, { id: lid, label: lid, color: '#000' });
    }
    const eid = 'e' + i;
    edges.set(eid, { id: eid, from: 'hub', to: tipId, points: [[0, 0], tip], lineIds });
    adj.get('hub')!.push(eid);
    adj.get(tipId)!.push(eid);
    for (const l of lineIds) stopAt.add(l + '|hub');
  }
  const stopNodes = new Map<string, string>();
  for (const l of lineRefs.keys()) stopNodes.set(l, 'hub');
  const stations = new Map();
  stations.set('G', { id: 'G', label: 'Hub', lngLat: [0, 0], nodeId: 'hub', members: 4, stopNodes });
  return { nodes, edges, adj, lineRefs, lineTraversals: new Map(), stations, stopAt };
}

test('splitHubs: no-op when flag is off (byte-identical)', () => {
  delete process.env.OCTI_SPLIT_HUBS;
  const h = starHub(6);
  const before = h.nodes.size;
  splitHubs(h);
  assert.equal(h.nodes.size, before, 'no new nodes when disabled');
  assert.ok(!h.nodes.get('hub')!.splitGroup, 'no splitGroup tag when disabled');
});

test('splitHubs: splits a high-degree hub into splitGroup leaves with a spine', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  const h = starHub(6); // dir 3 >= DIRMIN, maxBundle 5 >= BUNDLEMIN
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  // a − leaf was created and tagged
  const minus = [...h.nodes.values()].find((n) => n.id.includes('_sp-'));
  assert.ok(minus, 'a minus leaf exists');
  assert.equal(minus!.splitGroup, 'G', 'leaf carries the station group as splitGroup');
  // the retained hub node is also a split leaf
  assert.equal(h.nodes.get('hub')!.splitGroup, 'G', 'retained node tagged splitGroup');

  // a splitInternal spine edge joins the leaves
  const spine = [...h.edges.values()].find((e) => e.splitInternal && e.id.includes('_spine'));
  assert.ok(spine, 'a splitInternal spine edge exists');

  // station records the leaves for the capsule reunite
  const st = h.stations.get('G')!;
  assert.ok(st.splitNodeIds && st.splitNodeIds.length >= 2, 'station records split leaves');
});

test('splitHubs guard: a split leaf + spine survive combineDeg2 (not collapsed)', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  const h = starHub(6);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  const splitNodesBefore = [...h.nodes.values()].filter((n) => n.splitGroup).map((n) => n.id);
  const spineId = [...h.edges.values()].find((e) => e.id.includes('_spine'))!.id;

  const { hC } = combineDeg2(h);

  // every splitGroup node must still exist after the deg-2 collapse
  for (const id of splitNodesBefore) {
    assert.ok(hC.nodes.has(id), `split node ${id} survived combineDeg2`);
  }
  // the spine edge must still exist (not contracted away)
  assert.ok(hC.edges.has(spineId), 'spine edge survived combineDeg2');
});

test('splitHubs: stop flags re-home to the leaf carrying the line', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  const h = starHub(6);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  // every line that stopped at the hub now stops at one of the split leaves
  const leafIds = new Set([...h.nodes.values()].filter((n) => n.splitGroup).map((n) => n.id));
  for (const key of h.stopAt) {
    const nid = key.slice(key.indexOf('|') + 1);
    assert.ok(leafIds.has(nid), `stop flag ${key} homed to a split leaf`);
  }
});

// ---- contiguity invariant -------------------------------------------------
// Per line, the edges that carry it (external arms + the splitInternal spines
// they cross) must form ONE connected component over their {from,to} node
// endpoints. A split that drops a through-line from a spine breaks the line into
// 2+ components — exactly the subway-line-contiguity bug. This is the regression
// the box-count tests never caught.
function brokenLines(h: SupportGraph): string[] {
  const broken: string[] = [];
  for (const lineId of h.lineRefs.keys()) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (a: string, b: string) => {
      parent.set(a, parent.get(a) ?? a);
      parent.set(b, parent.get(b) ?? b);
      parent.set(find(a), find(b));
    };
    let carries = false;
    for (const e of h.edges.values()) {
      if (!e.lineIds.has(lineId)) continue;
      carries = true;
      union(e.from, e.to);
    }
    if (!carries) continue;
    const roots = new Set<string>();
    for (const k of parent.keys()) roots.add(find(k));
    if (roots.size > 1) broken.push(lineId);
  }
  return broken;
}

test('splitHubs contiguity: through-lines stay connected across a RECURSIVE split', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  // 6 arms x 5 lines => ldeg 30 >> LDEG_RECURSE (6), so the hub recurses to a
  // multi-level leaf chain. The depth-1 spine is where the bug manifested.
  const h = starHub(6);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  // sanity: the split actually recursed (more than one spine level)
  const spines = [...h.edges.values()].filter((e) => e.splitInternal && e.id.includes('_spine'));
  assert.ok(spines.length >= 2, `expected a recursive (multi-spine) split, got ${spines.length}`);

  const broken = brokenLines(h);
  assert.deepEqual(broken, [], `no line may break across a split; broken: ${broken.join(',')}`);
});

// ---- DRAWN-contiguity invariant: the spine must be in the line TRAVERSAL ----
// The graph-level `brokenLines` check above is necessary but NOT sufficient: the
// renderer draws and bridges strictly along `lineTraversals`. A through-line can
// be graph-connected (its arms + spine form one component) yet still render as a
// dangling stub if the spine edge is MISSING from its traversal — the renderer
// then hops from the + arm (ending at the + leaf) straight to the − arm (starting
// at the − leaf) and the connector pass refuses to bridge two lanes meeting at
// DIFFERENT nodes (`endA !== startB`), leaving a visible free end (Stratford /
// Poplar, 2026-06). This test asserts the traversal stitch: after a split, every
// step boundary in a through-line's traversal is node-contiguous, and a spine
// step is present where the line crosses the cut.
function travContiguous(h: SupportGraph, lineId: string): { ok: boolean; spineSteps: number; gap?: string } {
  const trav = h.lineTraversals.get(lineId);
  if (!trav) return { ok: true, spineSteps: 0 };
  const endOf = (s: { edgeId: string; reversed: boolean }) => {
    const e = h.edges.get(s.edgeId)!;
    return s.reversed ? e.from : e.to;
  };
  const startOf = (s: { edgeId: string; reversed: boolean }) => {
    const e = h.edges.get(s.edgeId)!;
    return s.reversed ? e.to : e.from;
  };
  let spineSteps = 0;
  for (const s of trav) if (h.edges.get(s.edgeId)?.splitInternal) spineSteps++;
  for (let i = 1; i < trav.length; i++) {
    const a = endOf(trav[i - 1]);
    const b = startOf(trav[i]);
    if (a !== b) return { ok: false, spineSteps, gap: `step ${i - 1}->${i}: ${a} != ${b}` };
  }
  return { ok: true, spineSteps };
}

test('splitHubs traversal: the spine is spliced into a through-line traversal (drawn contiguity)', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  delete process.env.OCTI_NO_STITCH;
  // Hub with a through-line LP threaded across two opposite arms, with an actual
  // TRAVERSAL: enter via e0 (t0 -> hub), leave via e3 (hub -> t3). The split puts
  // e0 and e3 on opposite leaves; the stitch must insert the spine between them.
  const h = starHub(6, 6);
  h.lineRefs.set('LP', { id: 'LP', label: 'LP', color: '#f00' });
  h.edges.get('e0')!.lineIds.add('LP');
  h.edges.get('e3')!.lineIds.add('LP');
  h.lineTraversals.set('LP', [
    { edgeId: 'e0', reversed: true },  // t0 -> hub
    { edgeId: 'e3', reversed: false }, // hub -> t3
  ]);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  const r = travContiguous(h, 'LP');
  assert.ok(r.ok, `LP traversal must be node-contiguous after split: ${r.gap}`);
  assert.ok(r.spineSteps >= 1, `LP traversal must ride at least one spine step, got ${r.spineSteps}`);
});

test('splitHubs traversal A/B: OCTI_NO_STITCH reproduces the drawn break (checker is real)', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  process.env.OCTI_NO_STITCH = '1'; // disable the stitch -> pre-fix behaviour
  const h = starHub(6, 6);
  h.lineRefs.set('LP', { id: 'LP', label: 'LP', color: '#f00' });
  h.edges.get('e0')!.lineIds.add('LP');
  h.edges.get('e3')!.lineIds.add('LP');
  h.lineTraversals.set('LP', [
    { edgeId: 'e0', reversed: true },
    { edgeId: 'e3', reversed: false },
  ]);
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;
  delete process.env.OCTI_NO_STITCH;

  // Pre-fix: the two arms land on DIFFERENT leaves with no spine step between
  // them -> the traversal has a node gap (the exact discontinuity that renders as
  // a dangling stub). This proves the stitched test above is meaningful.
  const r = travContiguous(h, 'LP');
  assert.equal(r.ok, false, 'without the stitch, LP traversal MUST have a node gap (the bug)');
});

// ---- Phase-2 density-aware throttle ---------------------------------------
// Build TWO qualifying star hubs whose centres are `sep` px apart (each a
// distinct station group). Both qualify under the Phase-1 predicate, so with the
// throttle off BOTH split; with a minSep that exceeds `sep`, only the DENSER one
// (more linesPerArm) splits and the near neighbour is throttled.
function twoHubs(sep: number, armsA = 6, linesA = 6, armsB = 6, linesB = 5): SupportGraph {
  const nodes = new Map<string, SupportNode>();
  const edges = new Map<string, SupportEdge>();
  const adj = new Map<string, string[]>();
  const lineRefs = new Map<string, { id: string; label: string; color: string }>();
  const stopAt = new Set<string>();
  const stations = new Map();
  let lineSeq = 0;
  const build = (hubId: string, center: Pixel, arms: number, linesPerArm: number, grp: string) => {
    nodes.set(hubId, { id: hubId, pos: center });
    adj.set(hubId, []);
    const stopNodes = new Map<string, string>();
    for (let i = 0; i < arms; i++) {
      const ang = (i / arms) * Math.PI * 2;
      const tip: Pixel = [center[0] + Math.cos(ang) * 200, center[1] + Math.sin(ang) * 200];
      const tipId = hubId + '_t' + i;
      nodes.set(tipId, { id: tipId, pos: tip });
      adj.set(tipId, []);
      const lineIds = new Set<string>();
      for (let k = 0; k < linesPerArm; k++) {
        const lid = 'L' + lineSeq++;
        lineIds.add(lid);
        lineRefs.set(lid, { id: lid, label: lid, color: '#000' });
        stopNodes.set(lid, hubId);
        stopAt.add(lid + '|' + hubId);
      }
      const eid = hubId + '_e' + i;
      edges.set(eid, { id: eid, from: hubId, to: tipId, points: [center.slice() as Pixel, tip], lineIds });
      adj.get(hubId)!.push(eid);
      adj.get(tipId)!.push(eid);
    }
    stations.set(grp, { id: grp, label: grp, lngLat: [0, 0], nodeId: hubId, members: 4, stopNodes });
  };
  build('hubA', [0, 0], armsA, linesA, 'GA'); // denser (linesA > linesB)
  build('hubB', [sep, 0], armsB, linesB, 'GB');
  return { nodes, edges, adj, lineRefs, lineTraversals: new Map(), stations, stopAt };
}

test('splitHubs throttle: a near neighbour is skipped, the denser hub still splits', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  process.env.OCTI_SPLIT_MAXHUBS = '0'; // uncapped: throttle is the only gate
  // Hubs 60px apart; offset ~ med/3 of 200px edges ≈ 66.7, so minSep factor 5 is
  // huge relative to 60 -> hubB is throttled. (We assert relative behaviour, not
  // a px value, to stay robust to the offset heuristic.)
  process.env.OCTI_SPLIT_MINSEP = '5';
  const h = twoHubs(60);
  splitHubs(h);
  const aSplit = !!h.stations.get('GA')!.splitNodeIds;
  const bSplit = !!h.stations.get('GB')!.splitNodeIds;
  delete process.env.OCTI_SPLIT_HUBS;
  delete process.env.OCTI_SPLIT_MAXHUBS;
  delete process.env.OCTI_SPLIT_MINSEP;
  assert.ok(aSplit, 'the denser hub A splits');
  assert.ok(!bSplit, 'the near neighbour hub B is throttled (not split)');
});

test('splitHubs throttle: MINSEP=0 disables the throttle (both near hubs split)', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  process.env.OCTI_SPLIT_MAXHUBS = '0';
  process.env.OCTI_SPLIT_MINSEP = '0'; // throttle off
  const h = twoHubs(60);
  splitHubs(h);
  const aSplit = !!h.stations.get('GA')!.splitNodeIds;
  const bSplit = !!h.stations.get('GB')!.splitNodeIds;
  delete process.env.OCTI_SPLIT_HUBS;
  delete process.env.OCTI_SPLIT_MAXHUBS;
  delete process.env.OCTI_SPLIT_MINSEP;
  assert.ok(aSplit && bSplit, 'with the throttle off, both near hubs split');
});

test('splitHubs throttle: inert at cap=1 (single split, no neighbour check)', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  // cap defaults to 1; the throttle must never fire (no prior committed hub).
  delete process.env.OCTI_SPLIT_MAXHUBS;
  process.env.OCTI_SPLIT_MINSEP = '5';
  const h = twoHubs(60);
  splitHubs(h);
  const splitCount = [h.stations.get('GA')!.splitNodeIds, h.stations.get('GB')!.splitNodeIds].filter(Boolean).length;
  delete process.env.OCTI_SPLIT_HUBS;
  delete process.env.OCTI_SPLIT_MINSEP;
  // exactly the densest one splits (cap=1), and that decision is unaffected by the
  // throttle (it would split at cap=1 regardless of MINSEP).
  assert.equal(splitCount, 1, 'cap=1 splits exactly one hub; throttle is inert');
});

test('splitHubs contiguity: a planted through-line survives a recursive cut', () => {
  process.env.OCTI_SPLIT_HUBS = '1';
  // Build a hub where one line LP threads straight through (two opposite arms),
  // so it must ride every spine it crosses. With dense bundles forcing recursion,
  // LP previously dropped off the depth-1 spine.
  const h = starHub(6, 6);
  // add a dedicated through-line LP on two opposite arms (e0 and e3 are antipodal)
  h.lineRefs.set('LP', { id: 'LP', label: 'LP', color: '#f00' });
  h.edges.get('e0')!.lineIds.add('LP');
  h.edges.get('e3')!.lineIds.add('LP');
  splitHubs(h);
  delete process.env.OCTI_SPLIT_HUBS;

  const broken = brokenLines(h);
  assert.ok(!broken.includes('LP'), `through-line LP must stay contiguous; broken: ${broken.join(',')}`);
  assert.deepEqual(broken, [], `no line may break; broken: ${broken.join(',')}`);
});
