// Tests for the keyed tree diff (B-3).
//
// The important one is the round-trip: apply the ops to a copy of `prev` and
// assert the result deep-equals `next`. Op counts alone can look right while
// ordering is wrong, and ordering is what the native side depends on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { diffTree, longestIncreasingSubsequence } from '../src/ir.mjs';

// ---- a reference applier (mirrors what Flutter will do) --------------------

function index(tree) {
  const byId = new Map();
  const parentOf = new Map();
  const walk = (n, parent) => {
    byId.set(n.id, n);
    if (parent) parentOf.set(n.id, parent);
    for (const c of n.children || []) walk(c, n);
  };
  walk(tree, null);
  return { byId, parentOf };
}

function detach(tree, id) {
  const { byId, parentOf } = index(tree);
  const node = byId.get(id);
  const parent = parentOf.get(id);
  if (!parent) throw new Error(`cannot detach root ${id}`);
  const i = parent.children.findIndex((c) => c.id === id);
  parent.children.splice(i, 1);
  return node;
}

function insertInto(tree, parentId, beforeId, node) {
  const { byId } = index(tree);
  const parent = byId.get(parentId);
  if (!parent) throw new Error(`no parent ${parentId}`);
  parent.children ||= [];
  if (beforeId == null) {
    parent.children.push(node);
    return;
  }
  const i = parent.children.findIndex((c) => c.id === beforeId);
  if (i < 0) throw new Error(`no sibling ${beforeId}`);
  parent.children.splice(i, 0, node);
}

export function applyOps(root, ops) {
  let tree = structuredClone(root);
  for (const op of ops) {
    if (op.op === 'insert') {
      if (op.parent == null) return structuredClone(op.node);
      insertInto(tree, op.parent, op.before ?? null, structuredClone(op.node));
    } else if (op.op === 'remove') {
      if (op.parent == null) { tree = null; continue; }
      detach(tree, op.id);
    } else if (op.op === 'update') {
      const { byId } = index(tree);
      const n = byId.get(op.id);
      assert.ok(n, `update on missing ${op.id}`);
      for (const [k, v] of Object.entries(op.patch)) {
        if (v === null) delete n[k];
        else n[k] = v;
      }
    } else if (op.op === 'move') {
      const node = detach(tree, op.id);
      insertInto(tree, op.parent, op.before ?? null, node);
    } else {
      throw new Error(`unknown op ${op.op}`);
    }
  }
  return tree;
}

// ---- builders --------------------------------------------------------------

let seq = 0;
const node = (t = 'box', extra = {}) => ({ id: `n${++seq}`, t, ...extra });
const parent = (children) => ({ id: `n${++seq}`, t: 'box', children });
const text = (s) => ({ id: `n${++seq}`, t: 'text', text: s });

function ops(prev, next) {
  const o = diffTree(prev, next);
  assert.deepEqual(applyOps(prev, o), next, 'patch must reproduce the new tree');
  return o;
}

const count = (o, kind) => o.filter((x) => x.op === kind).length;

// ---- LIS -------------------------------------------------------------------

test('LIS returns indices of a longest increasing subsequence', () => {
  const idx = longestIncreasingSubsequence([3, 1, 2, 0, 5]);
  const values = idx.map((i) => [3, 1, 2, 0, 5][i]);
  assert.deepEqual(values, [1, 2, 5]);
  assert.deepEqual(longestIncreasingSubsequence([]), []);
  assert.deepEqual(longestIncreasingSubsequence([7]), [0]);
});

// ---- the cases that motivated this diff ------------------------------------

test('prepending one child costs one insert and nothing else', () => {
  const a = parent([text('a'), text('b'), text('c')]);
  const fresh = text('z');
  const b = { ...a, children: [structuredClone(fresh), ...a.children] };

  const o = ops(a, b);
  assert.equal(count(o, 'insert'), 1);
  assert.equal(count(o, 'remove'), 0, 'an index-aligned diff would remove every sibling');
  assert.equal(count(o, 'move'), 0);
});

test('appending one child costs one insert', () => {
  const a = parent([text('a'), text('b')]);
  const fresh = text('z');
  const b = { ...a, children: [...a.children, structuredClone(fresh)] };
  const o = ops(a, b);
  assert.equal(count(o, 'insert'), 1);
  assert.equal(count(o, 'remove'), 0);
  assert.equal(count(o, 'move'), 0);
});

test('deleting the middle child costs one remove', () => {
  const a = parent([text('a'), text('b'), text('c')]);
  const b = { ...a, children: [a.children[0], a.children[2]] };
  const o = ops(a, b);
  assert.equal(count(o, 'remove'), 1);
  assert.equal(count(o, 'insert'), 0);
  assert.equal(count(o, 'move'), 0);
});

test('swapping two siblings moves exactly one', () => {
  const a = parent([text('a'), text('b')]);
  const b = { ...a, children: [a.children[1], a.children[0]] };
  const o = ops(a, b);
  assert.equal(count(o, 'move'), 1);
  assert.equal(count(o, 'insert'), 0);
  assert.equal(count(o, 'remove'), 0);
});

test('reordering three of five keeps the LIS in place', () => {
  const a = parent([text('1'), text('2'), text('3'), text('4'), text('5')]);
  const [n1, n2, n3, n4, n5] = a.children;
  const b = { ...a, children: [n1, n4, n2, n3, n5] };
  const o = ops(a, b);
  // n1..n3..n5 is an increasing subsequence of length 3; only n4 has to move.
  assert.equal(count(o, 'move'), 1);
  assert.equal(count(o, 'insert'), 0);
  assert.equal(count(o, 'remove'), 0);
});

test('a changed label is an update, not a rebuild', () => {
  const a = parent([text('a')]);
  const b = { ...a, children: [{ ...a.children[0], text: 'b' }] };
  const o = ops(a, b);
  assert.equal(o.length, 1);
  assert.equal(o[0].op, 'update');
  assert.equal(o[0].patch.text, 'b');
});

test('a node that changes kind is replaced, not patched', () => {
  const a = node('box');
  const b = { ...a, t: 'text' };
  const o = ops(a, b);
  assert.equal(count(o, 'remove'), 1);
  assert.equal(count(o, 'insert'), 1);
});

test('identical trees produce no ops at all', () => {
  const a = parent([text('a'), parent([text('b')])]);
  assert.deepEqual(diffTree(a, structuredClone(a)), []);
});

test('deep changes are patched at the leaf, not the root', () => {
  const leaf = text('old');
  const mid = parent([leaf]);
  const a = parent([mid]);
  const b = structuredClone(a);
  b.children[0].children[0].text = 'new';

  const o = ops(a, b);
  assert.equal(o.length, 1);
  assert.equal(o[0].op, 'update');
  assert.equal(o[0].id, leaf.id);
});

test('removing a whole subtree is one remove of its root', () => {
  const sub = parent([text('a'), text('b')]);
  const a = parent([sub, text('keep')]);
  const b = { ...a, children: [a.children[1]] };
  const o = ops(a, b);
  assert.equal(count(o, 'remove'), 1, 'children of a removed subtree must not each emit a remove');
  assert.equal(o[0].id, sub.id);
});

test('insert before an existing sibling names that sibling, not an index', () => {
  const a = parent([text('a'), text('c')]);
  const mid = text('b');
  const b = { ...a, children: [a.children[0], structuredClone(mid), a.children[1]] };
  const o = ops(a, b);
  const ins = o.find((x) => x.op === 'insert');
  assert.ok(ins);
  assert.equal(ins.before, a.children[1].id);
});

test('a single text node collapsing into its parent is an update', () => {
  // serialize() folds one text child into the box as `text`; the diff must see
  // that as a prop change, not as "the child disappeared".
  const a = { id: 'r', t: 'box', children: [] };
  const b = { id: 'r', t: 'box', text: 'hi' };
  const o = ops(a, b);
  assert.equal(o.length, 1);
  assert.equal(o[0].patch.text, 'hi');
});

test('interleaved insert/remove/move round-trips', () => {
  const a = parent([text('a'), text('b'), text('c'), text('d')]);
  const [na, nb, nc, nd] = a.children;
  const ne = text('e');
  const b = { ...a, children: [nc, structuredClone(ne), na, nd] };
  const o = ops(a, b);
  assert.ok(o.length > 0);
});
