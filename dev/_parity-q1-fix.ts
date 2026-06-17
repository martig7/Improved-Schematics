// Throwaway Q1: simulate the proposed fix WITHOUT touching src/ —
// refeed merge rounds with RDP-simplified interior geometry (eps=dHat)
// instead of endpoint chords. Compare against baseline (chord refeed) and
// against LOOM topo ground truth (line-pair co-occurrence).
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import {
  collapseSharedSegments, inputFromGraph, polylineLength, type TopoParams, type HBuilder,
} from '../src/render/layout/topo';
import { createProjection, computeBounds, padBounds, type Projection } from '../src/render/projection';
import { buildDensityWarp } from '../src/render/layout/densityWarp';
import type { Pixel } from '../src/render/layout/types';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const BLUE = '6b681564-4446-4daa-96be-17f7620b8d5c';
const PA = 'a3f11a38-2a9e-4fe2-bd23-2c1a73bbcb12';
const PB = 'bbf5a87e-686a-42c0-927b-365871373427';

const groups = getOrBuildStationGroups(stations, stationGroups);
const graph = buildTransitGraph(stations, routes, groups, tracks);

const bounds = (() => {
  const framePts: { points: Coordinate[] }[] = [...graph.nodes.values()].map((n) => ({ points: [n.lngLat] }));
  for (const e of graph.edges) if (e.geo) framePts.push({ points: e.geo });
  const b = computeBounds(framePts);
  return b ? padBounds(b, 0.1) : ([-1, -1, 1, 1] as [number, number, number, number]);
})();
const W = 2700, H = 2700;
const baseProj = createProjection(bounds, W, H, 0.06);
const warpSamples: Pixel[] = [];
for (const n of graph.nodes.values()) {
  const p = baseProj.toSVG(n.lngLat);
  const lines = new Set<string>();
  for (const eid of graph.adj.get(n.id) ?? []) {
    const e = graph.edges.find((x) => x.id === eid);
    if (e) for (const l of e.lines) lines.add(l.id);
  }
  const w = Math.max(1, Math.min(4, lines.size));
  for (let i = 0; i < w; i++) warpSamples.push(p);
}
const warp = buildDensityWarp(warpSamples, { minX: 0, minY: 0, maxX: W, maxY: H }, { alpha: 0.6 });
const proj: Projection = { ...baseProj, toSVG: (c: Coordinate) => warp(baseProj.toSVG(c)) };
for (const n of graph.nodes.values()) n.pos = proj.toSVG(n.lngLat) as Pixel;

// local RDP copy (simplifyRdp is module-private in topo.ts)
function rdp(pts: Pixel[], eps: number): Pixel[] {
  if (pts.length <= 2) return pts.map((p) => p.slice() as Pixel);
  const go = (s: Pixel[]): Pixel[] => {
    if (s.length <= 2) return s.map((p) => p.slice() as Pixel);
    const a = s[0], b = s[s.length - 1];
    let maxD = 0, idx = 0;
    for (let i = 1; i < s.length - 1; i++) {
      const vx = b[0]-a[0], vy = b[1]-a[1];
      const c2 = vx*vx+vy*vy;
      const t = c2===0?0:Math.max(0,Math.min(1,((s[i][0]-a[0])*vx+(s[i][1]-a[1])*vy)/c2));
      const d = Math.hypot(s[i][0]-(a[0]+t*vx), s[i][1]-(a[1]+t*vy));
      if (d>maxD){maxD=d;idx=i;}
    }
    if (maxD>eps){
      const l=go(s.slice(0,idx+1)), r=go(s.slice(idx));
      return [...l.slice(0,-1),...r];
    }
    return [a.slice() as Pixel, b.slice() as Pixel];
  };
  return go(pts);
}

const dHat = 16;
const params: TopoParams = {
  dHat, step: Math.max(2, dHat / 4), convergenceEpsilon: 0.002, maxRounds: 8,
  stationCandidateRadius: 2 * dHat, preserveStations: false,
};

type Mode = 'chord' | 'rdp-dHat' | 'rdp-halfdHat';
function runRounds(mode: Mode): HBuilder {
  let h: HBuilder | null = null;
  let prevLen = Infinity, prevEdges = Infinity;
  for (let round = 1; round <= params.maxRounds; round++) {
    const input = h === null
      ? inputFromGraph(graph)
      : { edges: h.edgeList().map((e: any) => {
          const a = h!.nodePos(e.a), b = h!.nodePos(e.b);
          const pts = mode === 'chord'
            ? [a.slice() as Pixel, b.slice() as Pixel]
            : rdp(e.points, mode === 'rdp-dHat' ? dHat : dHat / 2);
          pts[0] = a.slice() as Pixel; pts[pts.length-1] = b.slice() as Pixel;
          return { fromId: e.a, toId: e.b, a, b, points: pts, lineIds: e.lineIds };
        }) };
    const next = collapseSharedSegments(input as any, params);
    const len = next.totalLength();
    const edgeCount = next.edgeList().length;
    if (h !== null && prevEdges !== Infinity && edgeCount >= prevEdges) break;
    h = next;
    if (prevLen !== Infinity && Math.abs(1 - len / prevLen) < params.convergenceEpsilon) break;
    prevLen = len; prevEdges = edgeCount;
  }
  return h!;
}

function postProcess(h: HBuilder): HBuilder {
  h.sanitizeEdgeGeometry(dHat);
  h.contractShortEdges(dHat);
  h.contractDegree2WithMatchingLines();
  h.sanitizeEdgeGeometry(dHat);
  h.intersectionSmoothing(dHat);
  return h;
}

// line-pair co-occurrence weighted by edge length
function pairStats(h: HBuilder): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of h.edgeList()) {
    const len = polylineLength(e.points);
    const ids = [...e.lineIds].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      m.set(k, (m.get(k) ?? 0) + len);
    }
  }
  return m;
}

// LOOM topo ground-truth pairs (meters)
const topo = JSON.parse(readFileSync('dev/_probe-topo-out.json','utf-8'));
const R = 6378137;
const toM = (c:number[]):[number,number] => [R*(c[0]*Math.PI/180), R*Math.log(Math.tan(Math.PI/4+(c[1]*Math.PI/180)/2))];
const loomPairs = new Map<string, number>();
for (const f of topo.features) {
  if (f.geometry.type!=='LineString') continue;
  const ids=((f.properties.lines||[]) as {id:string}[]).map(l=>l.id).sort();
  const cs=f.geometry.coordinates.map(toM);
  let len=0; for(let i=1;i<cs.length;i++) len+=Math.hypot(cs[i][0]-cs[i-1][0],cs[i][1]-cs[i-1][1]);
  for(let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++){
    const k=ids[i]+'|'+ids[j];
    loomPairs.set(k,(loomPairs.get(k)??0)+len);
  }
}
const loomSig = new Set([...loomPairs.entries()].filter(([,v])=>v>200).map(([k])=>k));
console.log(`LOOM topo: ${loomPairs.size} co-occurring line pairs, ${loomSig.size} with >200m shared`);

const lineLabel = new Map<string,string>();
for (const f of topo.features) for (const l of (f.properties.lines||[])) lineLabel.set(l.id, l.label+'#'+l.color);

for (const mode of ['chord','rdp-dHat','rdp-halfdHat'] as Mode[]) {
  const t0 = Date.now();
  const h = postProcess(runRounds(mode));
  const edges = h.edgeList();
  const multi = edges.filter(e=>e.lineIds.size>1);
  const ps = pairStats(h);
  const oursSig = new Set([...ps.entries()].filter(([,v])=>v>40).map(([k])=>k));
  const spurious = [...oursSig].filter(k=>!loomSig.has(k));
  const missing = [...loomSig].filter(k=>!oursSig.has(k));
  let bpA=0,bpB=0;
  for (const e of edges) {
    if (!e.lineIds.has(BLUE)) continue;
    const len = polylineLength(e.points);
    if (e.lineIds.has(PA)) bpA+=len;
    if (e.lineIds.has(PB)) bpB+=len;
  }
  console.log(`\n== mode=${mode} (${((Date.now()-t0)/1000).toFixed(1)}s) ==`);
  console.log(`edges=${edges.length} multiLine=${multi.length} pairs>40px=${oursSig.size}`);
  console.log(`blue+pinkA len=${bpA.toFixed(0)}px blue+pinkB len=${bpB.toFixed(0)}px`);
  console.log(`spurious pairs vs LOOM (${spurious.length}): ${spurious.slice(0,12).map(k=>k.split('|').map(id=>lineLabel.get(id)??id.slice(0,6)).join('+')+`(${ps.get(k)!.toFixed(0)}px)`).join(' ')}`);
  console.log(`missing pairs vs LOOM (${missing.length}): ${missing.slice(0,12).map(k=>k.split('|').map(id=>lineLabel.get(id)??id.slice(0,6)).join('+')+`(${loomPairs.get(k)!.toFixed(0)}m)`).join(' ')}`);
}
