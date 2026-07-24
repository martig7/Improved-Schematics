import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installLogCapture, logText, logCount, noteLog } from '../debugLog';

// node:test runs each test FILE in its own process, so patching the console here
// cannot leak into other suites.

// Installed once for the whole file; a second call must be a no-op.
installLogCapture();
installLogCapture();

test('installLogCapture wraps once, so a call is captured a single time', () => {
  const before = logCount();
  console.error('once');
  // Wrapped twice would push two entries for this one call.
  assert.equal(logCount(), before + 1);
});

test('captures console output and renders it with level and header', () => {
  const before = logCount();
  console.warn('[ImprovedSchematics] a warning');
  assert.equal(logCount(), before + 1, 'captured the warn');
  const text = logText({ mod: '9.9.9' });
  assert.match(text, /mod: 9\.9\.9/);
  assert.match(text, /WARN\s+\[ImprovedSchematics\] a warning/);
});

test('an Error argument keeps its message and stack', () => {
  console.error('boom:', new TypeError('bad input'));
  const text = logText();
  assert.match(text, /TypeError: bad input/);
  assert.match(text, /debugLog\.test/, 'stack points at the throwing site');
});

test('non-serializable and circular values do not throw', () => {
  const circ: Record<string, unknown> = {};
  circ.self = circ;
  assert.doesNotThrow(() => console.log('circular:', circ, undefined, null, 42));
  assert.match(logText(), /circular:/);
});

test('noteLog records a line without needing the console', () => {
  const before = logCount();
  noteLog('a noted line');
  assert.equal(logCount(), before + 1);
  assert.match(logText(), /a noted line/);
});
