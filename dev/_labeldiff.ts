import { readFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';
const dump = (() => { const r = JSON.parse(readFileSync(process.argv[2], 'utf8')); return r['debug-render-input'] ?? r; })();
function render() {
  return generateSchematicSVG({ routes: dump.routes, tracks: dump.tracks, stations: dump.stations, stationGroups: dump.stationGroups, geography: dump.geography,
    options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: true } });
}
function P(svg: string) { const m: Record<string,{x:number;y:number;name:string}> = {};
  const re = /data-station-id="([^"]+)" transform="translate\(([-\d.]+),([-\d.]+)\)">.*?<text [^>]*>([^<]*)</g; let x;
  while ((x = re.exec(svg))) m[x[1]] = { x: +x[2], y: +x[3], name: x[4] }; return m; }
process.env.OCTI_NO_LABEL_REANCHOR = '1'; const base = P(render());
delete process.env.OCTI_NO_LABEL_REANCHOR; const fix = P(render());
const arr: [string,string,number][] = [];
for (const k in fix) { if (!base[k]) continue; const d = Math.hypot(fix[k].x-base[k].x, fix[k].y-base[k].y); if (d>0.5) arr.push([fix[k].name||k, k, d]); }
arr.sort((a,b)=>b[2]-a[2]);
console.error(`changed=${arr.length}  top movers:`);
arr.slice(0,8).forEach(a=>console.error(`  "${a[0]}" (${a[1]})  ${a[2].toFixed(0)}px`));
