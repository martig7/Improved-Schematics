// Throwaway Q1: LOOM-side measurements.
// 1. geo bbox of window-1 (Hanford St -> 118 St blue corridor) from our graph
// 2. LOOM topo (_probe-topo-out.json): blue vs pinkA corridor separation in window
// 3. LOOM render (out-loom-sea.svg): drawn gap between #0039a6 and #b933ad there
// 4. where LOOM's 2 shared blue+pinkB edges sit
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import type { Coordinate } from '../src/types/core';

const dump = JSON.parse(readFileSync('improvedschematics-input.json', 'utf-8'));
const { routes, tracks, stations, stationGroups } = dump;
const BLUE = '6b681564-4446-4daa-96be-17f7620b8d5c';
const PA = 'a3f11a38-2a9e-4fe2-bd23-2c1a73bbcb12';
const PB = 'bbf5a87e-686a-42c0-927b-365871373427';

const groups = getOrBuildStationGroups(stations, stationGroups);
const graph = buildTransitGraph(stations, routes, groups, tracks);

// window-1 blue edges by station labels (from previous probe: e126..e133)
const winEdgeIds = new Set(['e126','e127','e128','e129','e130','e131','e132','e133']);
const winPts: Coordinate[] = [];
for (const e of graph.edges) {
  if (!winEdgeIds.has(e.id)) continue;
  const g = e.geo ?? [graph.nodes.get(e.from)!.lngLat, graph.nodes.get(e.to)!.lngLat];
  winPts.push(...g);
}
const lngs = winPts.map(p=>p[0]), lats = winPts.map(p=>p[1]);
const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
console.log('window-1 geo bbox:', bbox.map(v=>v.toFixed(5)).join(', '));

// webmerc helpers
const R = 6378137;
const mercX = (lng:number)=> R * (lng*Math.PI/180);
const mercY = (lat:number)=> R * Math.log(Math.tan(Math.PI/4 + (lat*Math.PI/180)/2));
const toM = (c:Coordinate):[number,number] => [mercX(c[0]), mercY(c[1])];

// pad bbox by 500m
const padM = 500;
const bbM = [mercX(bbox[0])-padM, mercY(bbox[1])-padM, mercX(bbox[2])+padM, mercY(bbox[3])+padM];
const inWin = (m:[number,number]) => m[0]>=bbM[0]&&m[0]<=bbM[2]&&m[1]>=bbM[1]&&m[1]<=bbM[3];

// ---- LOOM topo corridors ----
const topo = JSON.parse(readFileSync('dev/_probe-topo-out.json','utf-8'));
type Feat = { geometry:{type:string;coordinates:number[][]}, properties:{lines?:{id:string;label:string;color:string}[]} };
function corridorM(lineId:string): [number,number][][] {
  const out:[number,number][][]=[];
  for (const f of topo.features as Feat[]) {
    if (f.geometry.type!=='LineString') continue;
    if (!(f.properties.lines||[]).some(l=>l.id===lineId)) continue;
    out.push(f.geometry.coordinates.map(c=>toM(c as Coordinate)));
  }
  return out;
}
function densifyM(poly:[number,number][], step=25): [number,number][] {
  const out:[number,number][]=[poly[0]];
  for(let i=1;i<poly.length;i++){
    const a=poly[i-1],b=poly[i];
    const d=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const n=Math.max(1,Math.ceil(d/step));
    for(let k=1;k<=n;k++) out.push([a[0]+(b[0]-a[0])*k/n, a[1]+(b[1]-a[1])*k/n]);
  }
  return out;
}
const blueM = corridorM(BLUE).flatMap(p=>densifyM(p));
const paM = corridorM(PA).flatMap(p=>densifyM(p));
const pbM = corridorM(PB).flatMap(p=>densifyM(p));

// blue points inside window: distance to nearest pinkA point
const dists:number[]=[];
for (const b of blueM) {
  if(!inWin(b)) continue;
  let dmin=Infinity;
  for(const p of paM) dmin=Math.min(dmin,Math.hypot(b[0]-p[0],b[1]-p[1]));
  dists.push(dmin);
}
dists.sort((a,b)=>a-b);
const q=(arr:number[],t:number)=>arr[Math.min(arr.length-1,Math.floor(arr.length*t))];
console.log(`LOOM topo window-1: blue samples=${dists.length} sep to pinkA: min=${dists[0]?.toFixed(0)}m p25=${q(dists,0.25).toFixed(0)}m median=${q(dists,0.5).toFixed(0)}m p75=${q(dists,0.75).toFixed(0)}m max=${dists.at(-1)?.toFixed(0)}m`);

// where are LOOM's blue+pinkB shared edges?
for (const f of topo.features as Feat[]) {
  if (f.geometry.type!=='LineString') continue;
  const ids=(f.properties.lines||[]).map(l=>l.id);
  if (ids.includes(BLUE)&&ids.includes(PB)) {
    const c0=f.geometry.coordinates[0], c1=f.geometry.coordinates.at(-1)!;
    let len=0; const cs=f.geometry.coordinates.map(c=>toM(c as Coordinate));
    for(let i=1;i<cs.length;i++) len+=Math.hypot(cs[i][0]-cs[i-1][0],cs[i][1]-cs[i-1][1]);
    console.log(`LOOM shared blue+pinkB edge: ${c0.map(v=>v.toFixed(4))} -> ${c1.map(v=>v.toFixed(4))} len=${len.toFixed(0)}m lines=[${(f.properties.lines||[]).map(l=>l.label).join(',')}]`);
  }
}

// ---- LOOM final render: drawn gap ----
const svg = readFileSync('dev/out-loom-sea.svg','utf-8');
// latlng-box="-122.612413,47.022228,-121.986442,47.988860" viewBox 0 0 6968.239401 15929.978319
const box = svg.match(/latlng-box="([^"]+)"/)![1].split(',').map(Number);
const vb = svg.match(/viewBox="([^"]+)"/)![1].split(/\s+/).map(Number);
const Wm = [mercX(box[0]), mercY(box[1]), mercX(box[2]), mercY(box[3])];
const sx = vb[2]/(Wm[2]-Wm[0]);
const sy = vb[3]/(Wm[3]-Wm[1]);
console.log(`LOOM svg scale: sx=${sx.toFixed(5)} px/m sy=${sy.toFixed(5)} px/m (1px=${(1/sx).toFixed(1)}m)`);
const toSvg = (m:[number,number]):[number,number] => [(m[0]-Wm[0])*sx, vb[3]-(m[1]-Wm[1])*sy];

// parse polylines by color
function polysOf(color:string):[number,number][][] {
  const out:[number,number][][]=[];
  const re=/<polyline class="transit-edge [^"]*" points="([^"]+)" style="[^"]*stroke:(#[0-9a-fA-F]{6})/g;
  let m:RegExpExecArray|null;
  while((m=re.exec(svg))){
    if(m[2].toLowerCase()!==color) continue;
    const pts=m[1].trim().split(/\s+/).map(s=>s.split(',').map(Number) as [number,number]);
    out.push(pts);
  }
  return out;
}
const bluePolys=polysOf('#0039a6');
const pinkPolys=polysOf('#b933ad');
console.log(`LOOM svg polylines: blue=${bluePolys.length} pink=${pinkPolys.length}`);

// project window corners into LOOM svg, pad 300px
const c1=toSvg([bbM[0],bbM[1]]), c2=toSvg([bbM[2],bbM[3]]);
const wx=[Math.min(c1[0],c2[0])-150, Math.max(c1[0],c2[0])+150];
const wy=[Math.min(c1[1],c2[1])-150, Math.max(c1[1],c2[1])+150];
console.log(`window-1 in LOOM svg px: x[${wx[0].toFixed(0)},${wx[1].toFixed(0)}] y[${wy[0].toFixed(0)},${wy[1].toFixed(0)}]`);

function densifyPx(poly:[number,number][],step=4){ return densifyM(poly,step); }
const pinkSamp:[number,number][]=[];
for(const p of pinkPolys) for(const s of densifyPx(p)) if(s[0]>=wx[0]&&s[0]<=wx[1]&&s[1]>=wy[0]&&s[1]<=wy[1]) pinkSamp.push(s);
const gaps:number[]=[];
for(const p of bluePolys) for(const s of densifyPx(p)){
  if(!(s[0]>=wx[0]&&s[0]<=wx[1]&&s[1]>=wy[0]&&s[1]<=wy[1])) continue;
  let dmin=Infinity;
  for(const t of pinkSamp) dmin=Math.min(dmin,Math.hypot(s[0]-t[0],s[1]-t[1]));
  gaps.push(dmin);
}
gaps.sort((a,b)=>a-b);
console.log(`LOOM drawn gap blue->pink in window-1: n=${gaps.length} min=${gaps[0]?.toFixed(1)}px(${(gaps[0]/sx*sx/sx).toFixed(0)} ) median=${q(gaps,0.5).toFixed(1)}px max=${gaps.at(-1)?.toFixed(1)}px  (1px=${(1/sx).toFixed(1)}m -> min=${(gaps[0]/sx).toFixed(0)}m median=${(q(gaps,0.5)/sx).toFixed(0)}m)`);
