/**
 * In-memory capture of the renderer's console output, so a player who cannot
 * open the Electron dev console can still hand over a log after hitting a
 * problem. The panel's "Save logs" control writes the buffer to a text file.
 *
 * Console methods are wrapped, never replaced: every call still reaches the
 * original, so behaviour is unchanged when nothing reads the buffer. Uncaught
 * errors and unhandled promise rejections are captured too, since the export
 * paths run inside image/callback handlers where a throw would otherwise leave
 * no trace at all.
 *
 * The buffer is a bounded ring: a long session cannot grow it without limit.
 */

const MAX_ENTRIES = 500;
/** Truncate any single formatted entry, so one huge dump can't crowd out the rest. */
const MAX_ENTRY_CHARS = 4000;

type Level = 'log' | 'info' | 'warn' | 'error';

interface Entry {
  /** ms since capture install, so entries order without a wall clock. */
  t: number;
  level: Level;
  text: string;
}

// The buffer lives on the global, not in module scope: the loader re-executes the
// bundle on every mod reload, which would otherwise discard everything captured so
// far. One-time events (the geography harvest above all) happen early and would be
// wiped by the next reload, exactly when they are being asked about.
interface LogState { entries: Entry[]; startedAt: number; installed: boolean }
const KEY = '__improvedSchematicsLog__';
const gl = globalThis as unknown as Record<string, LogState | undefined>;
const state: LogState = gl[KEY] ?? (gl[KEY] = { entries: [], startedAt: Date.now(), installed: false });
const entries = state.entries;

/** Format one console argument. Errors keep their stack; objects are JSON when
 *  serializable, and fall back to their tag rather than throwing. */
function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? '(no stack)'}`;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

function push(level: Level, args: unknown[]): void {
  let text = args.map(fmt).join(' ');
  if (text.length > MAX_ENTRY_CHARS) text = text.slice(0, MAX_ENTRY_CHARS) + ` …(+${text.length - MAX_ENTRY_CHARS} chars)`;
  entries.push({ t: Date.now() - state.startedAt, level, text });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Wrap the console and the global error hooks. Idempotent: a second call (a
 *  mod hot-reload re-running the entry point) does nothing, so the console is
 *  never wrapped twice. */
export function installLogCapture(): void {
  // `installed` is on the shared state, so a reload does not wrap the console a
  // second time (each wrap would duplicate every entry).
  if (state.installed || typeof console === 'undefined') return;
  state.installed = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level]?.bind(console);
    if (!original) continue;
    console[level] = (...args: unknown[]): void => {
      try {
        push(level, args);
      } catch {
        /* capture must never break the call it is observing */
      }
      original(...args);
    };
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', (e: ErrorEvent) => {
      push('error', [`uncaught: ${e.message}`, `at ${e.filename}:${e.lineno}:${e.colno}`, e.error]);
    });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      push('error', ['unhandled promise rejection:', e.reason]);
    });
  }
}

/** Number of captured entries (0 when capture was never installed). */
export function logCount(): number {
  return entries.length;
}

/** Record a line without printing it, for context a log reader needs (the
 *  environment header). */
export function noteLog(text: string): void {
  push('info', [text]);
}

/** The captured log as plain text, newest last, with a small header. */
export function logText(header: Record<string, unknown> = {}): string {
  const head = Object.entries(header).map(([k, v]) => `${k}: ${fmt(v)}`);
  const body = entries.map((e) => `[${(e.t / 1000).toFixed(2)}s] ${e.level.toUpperCase().padEnd(5)} ${e.text}`);
  return [
    '=== Improved Schematics log ===',
    ...head,
    `entries: ${entries.length}${entries.length >= MAX_ENTRIES ? ` (ring full, oldest dropped)` : ''}`,
    '',
    ...body,
    '',
  ].join('\n');
}
