// OCTI_FAN_TRACE: per-line fan-builder trace. Self-gating debug module per
// the repo debug pattern; the builder passes each group's member line ids.

import { envStr } from '../../env';

export function fanTraceTarget(): string | undefined {
  return typeof process !== 'undefined' ? envStr('OCTI_FAN_TRACE') : undefined;
}

/** Returns a logger that prints '[fan] '+m when the traced line id is a
 *  member of the current group ('*' traces every group). */
export function makeFanLog(target: string | undefined, memberLineIds: string[]): (m: string) => void {
  const on = target !== undefined && target !== '' && (target === '*' || memberLineIds.includes(target));
  return (m: string) => { if (on) console.error('[fan] ' + m); };
}
