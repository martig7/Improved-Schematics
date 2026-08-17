import { envStr } from '../../../env';
import { censusStationGeometry, type StationGeometryCensusInput } from '../stationGeometryCensus';

/** OCTI_STATION_CENSUS: compact-capsule and direct-endpoint invariant census. */
export function reportStationGeometryCensus(input: StationGeometryCensusInput): void {
  if (envStr('OCTI_STATION_CENSUS') !== '1') return;
  const result = censusStationGeometry(input);
  for (const violation of result.violations) {
    console.warn(
      `[station-census] ${violation.kind} node=${violation.nodeId}` +
      ` lines=${violation.lineIds.join(',')} ${violation.detail}`,
    );
  }
  console.warn(
    `[station-census] stations=${result.stations} cells=${result.cells}` +
    ` directEndpoints=${result.directEndpoints} violations=${result.violations.length}`,
  );
}
