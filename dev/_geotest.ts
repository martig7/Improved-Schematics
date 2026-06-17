// Test whether the geography bbox (which the dump omits but buildInput passes)
// explains offline≠in-game. geoFramePts uses only geo.bbox, so inject a minimal
// geography with the in-game bbox and see if the score matches the game.
import { readFileSync } from 'fs';
import { generateSchematicSVG } from '../src/render/schematic';

const dumpPath = process.argv[2] ?? 'improvedschematics-dump-current-sea-2.json';
const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;

// in-game geography bbox from the console: [minLng, minLat, maxLng, maxLat]
const bbox = (process.argv[3] ?? '-122.846,46.714,-121.435,48.310').split(',').map(Number) as [number, number, number, number];
const geography = { bbox, water: [], parks: [], landuse: [] } as never;

console.log('=== WITHOUT geography (current offline) ===');
generateSchematicSVG({ routes, tracks, stations, stationGroups, options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true } });

console.log(`=== WITH geography bbox [${bbox}] ===`);
generateSchematicSVG({ routes, tracks, stations, stationGroups, geography, options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true } } as never);
