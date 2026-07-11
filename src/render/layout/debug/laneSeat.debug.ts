// Lane-true seating diagnostics (env-gated, dev only). Extracted from
// laneSeat so the solver keeps only the call site. Enable with
// OCTI_LANESEAT_TRACE=<stationId>: after the global along-lane deconflict,
// prints every slot of that station with its arc state, slide bounds, world
// position, seed anchor, and tangent, to show whether the boxes spread on
// their lanes or piled up against their clamps.
import { envStr } from '../../../env';
import type { Pixel } from '../types';

export interface LaneSeatSlotView {
  station: string;
  lineId: string;
  t: number;
  lo: number;
  hi: number;
  pos: Pixel;
  anchor: Pixel;
  tangent: Pixel;
}

export function debugLaneSeatPhase1(slots: LaneSeatSlotView[]): void {
  const station = envStr('OCTI_LANESEAT_TRACE');
  if (!station) return;
  for (const s of slots) {
    if (s.station !== station) continue;
    console.warn(
      '[laneseat] phase1 ' + s.lineId.slice(0, 6) +
      ' t=' + s.t.toFixed(1) + ' [' + s.lo.toFixed(1) + ',' + s.hi.toFixed(1) + ']' +
      ' pos=' + s.pos.map((v) => v.toFixed(1)).join(',') +
      ' anchor=' + s.anchor.map((v) => v.toFixed(1)).join(',') +
      ' tg=' + s.tangent.map((v) => v.toFixed(2)).join(','),
    );
  }
}
