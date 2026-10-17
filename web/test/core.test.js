'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('weightsAt is normalized and peaks at the nearest anchor', () => {
  for (const a of C.ANCHORS) {
    const w = C.weightsAt(a.x, a.y);
    near(w.reduce((s, v) => s + v, 0), 1);
    assert.equal(w.indexOf(Math.max(...w)), C.ANCHORS.indexOf(a));
  }
});

test('paramsAt returns every BASE key, finite', () => {
  const P = C.paramsAt(0.37, 0.61);
  for (const k of Object.keys(C.BASE)) assert.ok(Number.isFinite(P[k]), k);
});

test('decayMultiplier spans 0.25x..4x with 0.5 neutral', () => {
  near(C.decayMultiplier(0), 0.25);
  near(C.decayMultiplier(0.5), 1);
  near(C.decayMultiplier(1), 4);
  near(C.decayMultiplier(-3), 0.25);
});

test('quantizedSlot snaps to the 1/16 grid and finer grids', () => {
  const tempo = 120, stepDur = C.slotDuration(tempo, 16);
  near(stepDur, 0.125);
  let q = C.quantizedSlot(0.13, 0, stepDur, tempo, 16);
  assert.equal(q.stepIndex, 1); assert.equal(q.offset, 0); near(q.time, 0.125);
  // 1/32: halfway into step 3
  q = C.quantizedSlot(3.5 * stepDur + 0.001, 0, stepDur, tempo, 32);
  assert.equal(q.stepIndex, 3); near(q.offset, 0.5);
  // 1/24 (non power of two): one third into step 0
  q = C.quantizedSlot(stepDur * (2 / 3), 0, stepDur, tempo, 24);
  assert.equal(q.stepIndex, 0); near(q.offset, 2 / 3, 1e-6);
  // wraps past the bar
  q = C.quantizedSlot(17 * stepDur, 0, stepDur, tempo, 16);
  assert.equal(q.stepIndex, 1);
});

test('toggling a step off fully resets it', () => {
  const s = new C.Sequence();
  s.liveWriteSlot(2, 0, 0.1, 0.2);
  s.liveWriteSlot(2, 0.5, 0.3, 0.4);
  s.setLane(2, 'prob', 0.3);
  s.toggle(2);
  assert.deepEqual(s.steps[2], C.freshStep());
});

test('hold one step + tap another copies, and neither toggles on release', () => {
  const s = new C.Sequence();
  s.load([[0, 0.1, 0.9]]);
  s.stepDown(0); s.stepDown(5); s.stepUp(5); s.stepUp(0);
  assert.equal(s.steps[0].on, true);
  assert.equal(s.steps[5].on, true);
  assert.equal(s.steps[5].x, 0.1); assert.equal(s.steps[5].y, 0.9);
});

test('ratchets upsert by offset and stay sorted', () => {
  const s = new C.Sequence();
  s.liveWriteSlot(4, 0, 0.5, 0.5);
  s.liveWriteSlot(4, 0.75, 0.1, 0.1);
  s.liveWriteSlot(4, 0.25, 0.2, 0.2);
  s.liveWriteSlot(4, 0.76, 0.9, 0.9);
  assert.deepEqual(s.steps[4].ratchets.map((r) => r.offset), [0.25, 0.76]);
  s.liveWriteSlot(4, 0, 0.5, 0.5);
  assert.deepEqual(s.steps[4].ratchets, []);
});

test('trial never fires an off step and respects prob=0', () => {
  const s = new C.Sequence();
  assert.equal(s.trial(0).fired, false);
  s.load([[0, 0.5, 0.5]]);
  s.setLane(0, 'prob', 0);
  for (let i = 0; i < 50; i++) assert.equal(s.trial(0).fired, false);
});
