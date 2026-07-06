// Central, guarded reader for environment-variable knobs and debug flags.
// The mod runs in the Electron renderer where `process` may be undefined, so
// every read goes through here instead of repeating the typeof guard inline.
const bag: Record<string, string | undefined> | undefined =
  typeof process !== 'undefined' ? (process as { env?: Record<string, string | undefined> }).env : undefined;

/** Raw string value of an env var, or undefined when unset or outside Node. */
export function envStr(name: string): string | undefined {
  return bag ? bag[name] : undefined;
}

/** Env var parsed as a number; NaN when unset (matches `Number(undefined)`). */
export function envNum(name: string): number {
  const v = bag ? bag[name] : undefined;
  return v == null ? NaN : Number(v);
}
