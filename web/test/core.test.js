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

test('catchStep: early moves count for this step, late ones for the next', () => {
  const dur = C.slotDuration(120, 16);
  near(dur, 0.125);
  assert.equal(C.catchStep(3 * dur + 0.2 * dur, 0, dur), 3);
  assert.equal(C.catchStep(3 * dur + 0.49 * dur, 0, dur), 3);
  assert.equal(C.catchStep(3 * dur + 0.5 * dur, 0, dur), 4);
  assert.equal(C.catchStep(3 * dur + 0.9 * dur, 0, dur), 4);
  assert.equal(C.catchStep(3 * dur + 0.7 * dur, 0, dur, 0.8), 3);
  assert.equal(C.catchStep(17 * dur, 0, dur), 17); // unwrapped
});

test('ratchet values fit whole hits into a step', () => {
  for (const n of C.RATCHET_VALUES) assert.equal(n % 16, 0);
  assert.deepEqual(C.RATCHET_VALUES.map(C.ratchetHits), [1, 2, 3, 4, 6]);
});

test('swingOffset: 50% straight, 75% delays the off-beat by half a step', () => {
  const dur = 0.125;
  near(C.swingOffset(1, 50, dur), 0);
  near(C.swingOffset(1, 75, dur), dur / 2);
  near(C.swingOffset(3, 66, dur), 0.32 * dur);
  near(C.swingOffset(2, 75, dur), 0);
});

test('recordStep writes even ratchets and replaces whatever the step had', () => {
  const s = new C.Sequence();
  s.recordStep(5, 0.2, 0.3, 4);
  assert.deepEqual(s.steps[5].ratchets.map((r) => r.offset), [0.25, 0.5, 0.75]);
  assert.equal(s.steps[5].on, true);
  s.recordStep(5, 0.4, 0.3, 3);
  assert.deepEqual(s.steps[5].ratchets.map((r) => +r.offset.toFixed(3)), [0.333, 0.667]);
  assert.equal(s.steps[5].ratchets[0].x, 0.4);
  s.recordStep(5, 0.2, 0.3, 1); // a plain 1/16 recording clears ratchets
  assert.deepEqual(s.steps[5].ratchets, []);
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

test('foldCurve is the identity at 0 and folds at 1', () => {
  const c0 = C.foldCurve(0), c1 = C.foldCurve(1), n = c0.length;
  for (let i = 0; i < n; i += 97) near(c0[i], i / (n - 1) * 2 - 1, 1e-6);
  let zc = 0;
  for (let i = 1; i < n; i++) if ((c1[i] >= 0) !== (c1[i - 1] >= 0)) zc++;
  assert.ok(zc >= 7, `only ${zc} zero crossings`);
});

test('modeRatios hits harmonic, membrane and bar sets at 0, 0.5, 1', () => {
  assert.deepEqual(C.modeRatios(0).map((r) => +r.toFixed(3)), [1, 2, 3, 4, 5]);
  near(C.modeRatios(0.5)[1], 1.594, 1e-9);
  near(C.modeRatios(1)[4], 13.344, 1e-9);
  for (const s of [0.1, 0.3, 0.7, 0.9]) {
    const r = C.modeRatios(s);
    for (let k = 1; k < r.length; k++) assert.ok(r[k] > r[k - 1]);
  }
});

test('modeQ gives the requested -60 dB ring time', () => {
  const Q = C.modeQ(440, 0.75);
  near(Q * Math.log(1000) / (Math.PI * 440), 0.75, 1e-9);
});

test('new synthesis params blend and default from BASE', () => {
  for (const k of ['fmRatio', 'fold', 'res', 'resF', 'resDec', 'resShape']) assert.ok(k in C.BASE, k);
  const kick = C.ANCHORS.find((a) => a.name === 'kick');
  near(C.paramsAt(kick.x, kick.y).fmRatio, 1.41, 1e-3);
  const marimba = C.ANCHORS.find((a) => a.name === 'marimba');
  assert.ok(C.paramsAt(marimba.x, marimba.y).res > 0.7);
});

test('autoAt interpolates between automation points', () => {
  const auto = [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }];
  assert.deepEqual(C.autoAt(auto, 0), { x: 0, y: 1 });
  const m = C.autoAt(auto, 0.25); near(m.x, 0.25); near(m.y, 0.75);
  assert.deepEqual(C.autoAt(auto, 1), { x: 1, y: 0 });
  assert.deepEqual(C.autoAt(auto, 2), { x: 1, y: 0 });
});

test('setAuto stores a gesture and moves ratchets onto it; recordStep clears it', () => {
  const s = new C.Sequence();
  s.recordStep(3, 0.1, 0.1, 2);
  s.setAuto(3, Array.from({ length: C.AUTO_POINTS }, (_, k) => ({ x: k / (C.AUTO_POINTS - 1), y: 0.5 })));
  assert.equal(s.steps[3].auto.length, C.AUTO_POINTS);
  assert.equal(s.steps[3].x, 0);
  near(s.steps[3].ratchets[0].x, 0.5);
  s.setAuto(4, [{ x: 0, y: 0 }, { x: 1, y: 1 }]); // off step: ignored
  assert.equal(s.steps[4].auto, undefined);
  s.recordStep(3, 0.2, 0.2, 1);
  assert.equal(s.steps[3].auto, null);
  s.toggle(3);
  assert.deepEqual(s.steps[3], C.freshStep());
});

test('every LFO shape stays roughly within -1..1 and sine/kepler(0) agree', () => {
  for (const sh of C.MOD_SHAPES.filter((s) => !s.env)) {
    for (let k = 0; k < 400; k++) {
      const v = C.lfoAt(sh.id, k / 97, 0.5).x;
      assert.ok(Number.isFinite(v) && v >= -1.3 && v <= 1.3, `${sh.id} gave ${v}`);
    }
  }
  near(C.lfoAt('kepler', 0.3, 0).x, Math.cos(2 * Math.PI * 0.3), 1e-6);
});

test('envelope rises over the attack, then falls to zero', () => {
  const m = Object.assign(C.freshMod(), { atk: 0.5, dec: 0.5 });
  const a = C.envAttack(m), d = C.envDecay(m);
  near(C.envAt(m, a / 2), 0.5);
  near(C.envAt(m, a), 1);
  assert.equal(C.envAt(m, a + d + 0.01), 0);
  assert.equal(C.envLook(Object.assign(C.freshMod(), { atk: 0.9 })), 'flare');
  assert.equal(C.envLook(Object.assign(C.freshMod(), { atk: 0, dec: 0.1 })), 'impact');
  assert.equal(C.envLook(Object.assign(C.freshMod(), { atk: 0, dec: 0.9 })), 'supernova');
});

test('modulation moves position, pitch, decay and single controls within range', () => {
  near(C.modulatePos({ x: 0.5, y: 0.5 }, 'x', 1).x, 1);
  const P = C.paramsAt(0.12, 0.10);
  near(C.modulateParams(P, 'pitch', 1).f, P.f * 2, 1e-9);
  near(C.modulateParams(P, 'decay', -1).tDec, P.tDec / 4, 1e-9);
  const sp = C.PARAM_BY_KEY.fold;
  assert.equal(C.modulateParams(P, 'fold', 1).fold, Math.min(sp.max, P.fold + 0.5));
  assert.equal(C.modulateParams(P, 'lp', 5).lp, C.PARAM_BY_KEY.lp.max);
});

test('targets: steps, drums and kit; toggling adds then removes', () => {
  const m = C.freshMod();
  assert.equal(C.toggleTarget(m, { kind: 'step', i: 3 }), true);
  assert.equal(C.modCovers(m, 3, 0), true);
  assert.equal(C.modCovers(m, 4, 0), false);
  C.toggleTarget(m, { kind: 'drum', a: 6 });
  assert.equal(C.modCovers(m, 9, 6), true);
  assert.equal(C.toggleTarget(m, { kind: 'step', i: 3 }), false);
  assert.equal(C.modCovers(m, 3, 0), false);
  C.toggleTarget(m, { kind: 'kit' });
  assert.equal(C.modCovers(m, 11, 2), true);
  assert.equal(C.nearestAnchor(0.12, 0.10), C.ANCHORS.findIndex((a) => a.name === 'kick'));
});

const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

test('random LFO: smooth 0 holds steps, smooth 1 eases between them', () => {
  const held = [0.01, 0.1, 0.2].map((p) => C.lfoAt('random', p, 0).x);
  near(held[0], held[1]); near(held[1], held[2]);
  const a = C.lfoAt('random', 0, 1).x, b = C.lfoAt('random', 0.25, 1).x, mid = C.lfoAt('random', 0.125, 1).x;
  near(mid, (a + b) / 2, 1e-6);
});

test('free LFOs run in Hz on their own clock; unipolar stays 0..1', () => {
  const m = Object.assign(C.freshMod(), { free: true, hz: 0, shape: 'saw' }); // 0.05 Hz
  near(C.modHz(m), 0.05);
  near(C.modCycles(m, 999, 10), 0.5);
  m.uni = true;
  for (let t = 0; t < 40; t += 0.7) { const v = C.modLfo(m, 0, t); assert.ok(v >= 0 && v <= 1); }
});

test('transport destinations are global and stay in range', () => {
  const m = Object.assign(C.freshMod(), { dest: 'bpm', targets: [{ kind: 'kit' }] });
  assert.equal(C.modCovers(m, 0, 0), false);
  near(C.modTempo(120, 1), 180); near(C.modTempo(120, -1), 80);
  assert.equal(C.modSwing(50, -1), 50); assert.equal(C.modSwing(70, 1), 75);
});

test('foldMix: no fold is dry, full fold is all wet', () => {
  const z = C.foldMix(0), f = C.foldMix(1);
  near(z.dry, 1); near(z.wet, 0); near(f.dry, 0); near(f.wet, 1);
});

test('randomizeSteps fills an empty pattern with 5..16 steps, never at the edges', () => {
  for (const st of [0.01, 0.5, 1]) for (let seed = 1; seed < 30; seed++) {
    const steps = Array.from({ length: 16 }, C.freshStep);
    C.randomizeSteps(steps, st, seeded(seed));
    const on = steps.filter((s) => s.on);
    assert.ok(on.length >= 5 && on.length <= 16, String(on.length));
    for (const s of on) assert.ok(s.x > 0.03 && s.x < 0.97 && s.y > 0.03 && s.y < 0.97);
    assert.ok(on.filter((s) => s.ratchets.length).length <= C.MAX_NEW_RATCHETS);
  }
  const lo = Array.from({ length: 16 }, C.freshStep); C.randomizeSteps(lo, 0, seeded(3));
  assert.equal(lo.filter((s) => s.on).length, 5);
  const hi = Array.from({ length: 16 }, C.freshStep); C.randomizeSteps(hi, 1, seeded(3));
  assert.equal(hi.filter((s) => s.on).length, 16);
});

test('randomizeSteps: low strength keeps the steps, high adds/removes and changes ratchets', () => {
  const make = () => { const st = Array.from({ length: 16 }, C.freshStep); for (const i of [0, 4, 8, 12]) Object.assign(st[i], { on: true, set: true, x: 0.5, y: 0.5 }); st[4].ratchets = C.evenRatchets(0.5, 0.5, 3); return st; };
  for (let seed = 1; seed < 20; seed++) {
    const st = C.randomizeSteps(make(), 0.3, seeded(seed));
    assert.deepEqual(st.map((s) => s.on), make().map((s) => s.on));
    assert.equal(st[4].ratchets.length, 2);
    for (const s of st) assert.ok(s.x >= 0 && s.x <= 1);
  }
  let changedOn = 0, changedRat = 0;
  for (let seed = 1; seed < 40; seed++) {
    const st = C.randomizeSteps(make(), 1, seeded(seed)), base = make();
    if (st.some((s, i) => s.on !== base[i].on)) changedOn++;
    if (st.some((s, i) => s.ratchets.length !== base[i].ratchets.length)) changedRat++;
    assert.ok(st.some((s) => s.on));
    const newR = st.filter((s, i) => s.ratchets.length && !base[i].ratchets.length).length;
    assert.ok(newR <= C.MAX_NEW_RATCHETS);
  }
  assert.ok(changedOn > 30 && changedRat > 10, `${changedOn} ${changedRat}`);
});

test('jitterParams keeps drive and fold mostly low', () => {
  let hi = 0, n = 0;
  for (let seed = 1; seed < 200; seed++) {
    const p = Object.assign({}, C.ANCHORS[0].p); C.jitterParams(p, 1, seeded(seed));
    for (const sp of C.PARAM_SPECS) assert.ok(p[sp.key] >= sp.min && p[sp.key] <= sp.max, sp.key);
    n++; if (p.fold > 0.5) hi++;
  }
  assert.ok(hi / n < 0.15, String(hi / n));
});

test('play modes visit every step', () => {
  for (const mode of ['fwd', 'back', 'pingpong']) {
    const seen = new Set(); for (let n = 0; n < 40; n++) seen.add(C.stepAt(mode, n));
    assert.equal(seen.size, 16, mode);
  }
  assert.deepEqual([0, 1, 14, 15, 16, 29, 30].map((n) => C.stepAt('pingpong', n)), [0, 1, 14, 15, 14, 1, 0]);
  assert.equal(C.stepAt('back', 0), 15);
});

test('crc32, wav header and stored zip', () => {
  near(C.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const w = C.encodeWav(new Float32Array([0, 1, -1]), 44100), v = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint32(24, true), 44100); assert.equal(v.getInt16(46, true), 32767); assert.equal(v.getInt16(48, true), -32767);
  const z = C.zipStore([{ name: 'a/b.wav', data: w }, { name: 'c.txt', data: new Uint8Array([104, 105]) }]), zv = new DataView(z.buffer);
  assert.equal(zv.getUint32(0, true), 0x04034b50);
  assert.equal(zv.getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(zv.getUint16(z.length - 12, true), 2);
});

test('erase deletes a step; held ones stay consumed so release does not revive them', () => {
  const s = new C.Sequence();
  s.steps[3].on = true; s.stepDown(3);
  s.erase(3, true);
  assert.equal(s.steps[3].on, false);
  s.stepUp(3);
  assert.equal(s.steps[3].on, false);
});

test('copying a step carries its ratchets and smooth gesture', () => {
  const s = new C.Sequence();
  s.recordStep(2, 0.3, 0.4, 3);
  s.steps[2].auto = Array.from({ length: C.AUTO_POINTS }, (_, k) => ({ x: k / 20, y: 0.4 }));
  s.stepDown(2); s.stepDown(9); s.stepUp(9); s.stepUp(2);
  assert.equal(s.steps[9].on, true);
  assert.equal(s.steps[9].ratchets.length, 2);
  assert.notEqual(s.steps[9].ratchets, s.steps[2].ratchets);
  assert.equal(s.steps[9].auto.length, C.AUTO_POINTS);
  assert.equal(s.steps[2].on, true);
});

test('transport destinations come last in the list', () => {
  const ids = C.MOD_DESTS.map((d) => d.id);
  assert.deepEqual(ids.slice(-2), ['bpm', 'swing']);
});
