import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeSeqFromSupport } from '../stopSeq';
import type { SupportGraph, SupportStation } from '../types';

const station = (id: string, stopNodes: Record<string, string>): SupportStation => ({
  id, label: id, lngLat: [0, 0], nodeId: 'x', stopNodes: new Map(Object.entries(stopNodes)),
});
const support = (stations: SupportStation[]): SupportGraph => ({
  nodes: new Map(), edges: new Map(), adj: new Map(), lineRefs: new Map(),
  lineTraversals: new Map(), stopAt: new Set(),
  stations: new Map(stations.map((s) => [s.id, s])),
});

test('nodeSeqFromSupport: re-keys intake group numbers onto each line stop node', () => {
  const h = support([
    station('gA', { L: 'nA' }),
    station('gB', { L: 'nB', M: 'ms9' }), // M re-homed onto a fused node
  ]);
  const numberByGroup = new Map([['L|gA', 1], ['L|gB', 2], ['M|gB', 7]]);
  const seq = nodeSeqFromSupport(h, numberByGroup);
  assert.equal(seq.get('L|nA'), 1);
  assert.equal(seq.get('L|nB'), 2);
  assert.equal(seq.get('M|ms9'), 7); // the re-homed node still gets its number
});

test('nodeSeqFromSupport: skips groups with no intake number; tolerates undefined', () => {
  const h = support([station('gX', { L: 'nX' })]);
  assert.equal(nodeSeqFromSupport(h, new Map()).size, 0);
  assert.equal(nodeSeqFromSupport(h, undefined).size, 0);
});
