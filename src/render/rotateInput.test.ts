import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateSchematicInput } from './rotateInput';
import type { Coordinate } from '../types/core';

const GEO = {
  bbox: [-74.2, 40.5, -73.7, 40.9] as [number, number, number, number],
  water: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-74.0, 40.7], [-73.9, 40.7], [-73.9, 40.8]]] } }] as never,
  green: [] as never,
};

const input = () => ({
  stations: [
    { id: 'a', coords: [-74.0, 40.7] as Coordinate },
    { id: 'b', coords: [-73.95, 40.75] as Coordinate },
  ],
  tracks: [{ id: 't', coords: [[-74.0, 40.7], [-73.95, 40.75]] as Coordinate[] }],
  routes: [{ stNodes: [{ id: 'n', center: [-74.0, 40.7] as Coordinate }] }],
  stationGroups: [{ center: [-73.95, 40.75] as Coordinate, stations: [{ coords: [-73.95, 40.75] as Coordinate }] }],
  geography: GEO,
});

test('rotateSchematicInput: bearing 0 is identity (same object)', () => {
  const i = input();
  assert.equal(rotateSchematicInput(i, 0), i);
});

test('rotateSchematicInput: does not mutate the source', () => {
  const i = input();
  const before = JSON.stringify(i);
  rotateSchematicInput(i, 29);
  assert.equal(JSON.stringify(i), before);
});

test('rotateSchematicInput: a compass-B segment becomes vertical in the rotated frame', () => {
  // build a segment with compass bearing 29° from station a (dEast/dNorth = tan29)
  const lat0 = 40.7;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const dNorth = 0.1;
  const dEast = Math.tan((29 * Math.PI) / 180) * dNorth;
  const i = input();
  i.stations[1].coords = [-74.0 + dEast / k, lat0 + dNorth];
  const out = rotateSchematicInput(i, 29);
  const a = out.stations[0].coords;
  const b = out.stations[1].coords;
  // vertical: pseudo-lng difference ~0, pseudo-lat difference > 0
  assert.ok(Math.abs(b[0] - a[0]) < 1e-6, `expected vertical, got dLng=${(b[0] - a[0]).toExponential(2)}`);
  assert.ok(b[1] - a[1] > 0.09);
});

test('rotateSchematicInput: metric distances are preserved (isometry)', () => {
  const i = input();
  const out = rotateSchematicInput(i, 47);
  const dist = (p: Coordinate, q: Coordinate, latRef: number): number => {
    const k = Math.cos((latRef * Math.PI) / 180);
    const e = (p[0] - q[0]) * k;
    const n = p[1] - q[1];
    return Math.sqrt(e * e + n * n);
  };
  const d0 = dist(i.stations[0].coords, i.stations[1].coords, 40.7);
  const d1 = dist(out.stations[0].coords, out.stations[1].coords, 40.7);
  assert.ok(Math.abs(d0 - d1) / d0 < 1e-4, `distance drifted: ${d0} -> ${d1}`);
});

test('rotateSchematicInput: rotates every coordinate carrier + rebuilds the bbox as an AABB', () => {
  type Poly = { geometry: { coordinates: Coordinate[][] } };
  const i = input();
  const out = rotateSchematicInput(i, 29);
  const outWater = out.geography!.water as unknown as Poly[];
  const inWater = i.geography.water as unknown as Poly[];
  assert.notDeepEqual(out.tracks[0].coords[0], i.tracks[0].coords[0]);
  assert.notDeepEqual(out.routes[0].stNodes![0].center, i.routes[0].stNodes![0].center);
  assert.notDeepEqual(out.stationGroups[0].center, i.stationGroups[0].center);
  assert.notDeepEqual(outWater[0].geometry.coordinates[0][0], inWater[0].geometry.coordinates[0][0]);
  const bb = out.geography!.bbox;
  assert.ok(bb[0] < bb[2] && bb[1] < bb[3]);
  // every rotated water vertex must lie inside the rebuilt bbox
  for (const c of outWater[0].geometry.coordinates[0]) {
    assert.ok(c[0] >= bb[0] - 1e-9 && c[0] <= bb[2] + 1e-9 && c[1] >= bb[1] - 1e-9 && c[1] <= bb[3] + 1e-9);
  }
});

test('rotateSchematicInput: deterministic', () => {
  assert.equal(JSON.stringify(rotateSchematicInput(input(), 29)), JSON.stringify(rotateSchematicInput(input(), 29)));
});
