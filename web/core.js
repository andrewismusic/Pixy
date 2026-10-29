
'use strict';

/* ==========================================================================
   Kit map: every point on the XY pad is a full set of drum-voice parameters.
   Anchors (named drums) sit at fixed positions; the parameters at any point
   are a soft blend of nearby anchors, so dragging morphs kick -> tom -> snare
   -> clap -> hats and so on.
   x: tonal (left) -> noisy and metallic (right)     y: low (bottom) -> high (top)
   ========================================================================== */

const N_STEPS = 16;
const SIGMA = 0.09;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function hsl2rgb(h, s, l) {
  h /= 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

/* Voice parameters
   f       body pitch after the sweep (Hz)          pEnv   sweep depth (octaves above f at hit)
   pDec    pitch sweep time (s)                     tone   body level        tDec  body decay (s)
   fm      FM crack on the body (0-1)
   noise   noise level  nDec  noise decay (s)      burst  clap-style re-triggers (0-1)
   metal   six-square metal bank level  mDec decay (s)  mPitch  bank pitch multiplier
   fmRatio FM modulator ratio to the body pitch (1.41 = the original crack; 3.5 = bell)
   res     resonator level: a struck modal bank (lightweight physical model)
   resF    resonator fundamental (Hz)   resDec  ring time (s, to -60 dB)
   resShape  mode spacing: 0 string/tube (harmonic) .. 0.5 drum skin .. 1 bar/bell
   hp lp   high-pass / low-pass on noise+metal (Hz)  q  resonance on the low-pass (dB)
   drive   saturation (0-1)   fold  wavefolder (0-1)   atk  attack (s)   lvl  output trim */
const BASE = {
  f: 200, pEnv: 0, pDec: 0.03, tone: 0, tDec: 0.1, fm: 0,
  noise: 0, nDec: 0.1, burst: 0, metal: 0, mDec: 0.1, mPitch: 1,
  hp: 200, lp: 12000, q: 0, drive: 0, atk: 0.001, lvl: 1,
  fmRatio: 1.41, fold: 0, res: 0, resF: 300, resDec: 0.4, resShape: 0.5,
};

const ANCHOR_DEFS = [
  { name: 'kick', x: 0.12, y: 0.10, hue: 252,
    p: { f: 48, pEnv: 2.4, pDec: 0.04, tone: 1, tDec: 0.33, noise: 0.18, nDec: 0.011, hp: 900, lp: 5500, drive: 0.4, lvl: 1.28 } },
  { name: 'sub', x: 0.31, y: 0.05, hue: 232,
    p: { f: 44, pEnv: 1.0, pDec: 0.12, tone: 1, tDec: 0.95, atk: 0.002, drive: 0.12, lvl: 1.1 } },
  { name: 'low tom', x: 0.14, y: 0.34, hue: 276,
    p: { f: 95, pEnv: 1.1, pDec: 0.08, tone: 1, tDec: 0.40, fm: 0.04, noise: 0.05, nDec: 0.03, hp: 400, lp: 3500, drive: 0.08, lvl: 1.05 } },
  { name: 'high tom', x: 0.14, y: 0.53, hue: 292,
    p: { f: 185, pEnv: 0.9, pDec: 0.06, tone: 1, tDec: 0.30, fm: 0.05, noise: 0.04, nDec: 0.03, hp: 600, lp: 5000, drive: 0.06, lvl: 0.95 } },
  { name: 'conga', x: 0.13, y: 0.75, hue: 214,
    p: { f: 330, pEnv: 0.55, pDec: 0.035, tone: 1, tDec: 0.20, fm: 0.25, noise: 0.05, nDec: 0.02, hp: 1500, lp: 6000, drive: 0.05, lvl: 0.9 } },
  { name: 'rim', x: 0.31, y: 0.87, hue: 42,
    p: { f: 1150, pEnv: 0.15, pDec: 0.01, tone: 0.9, tDec: 0.055, fm: 0.5, noise: 0.35, nDec: 0.025, hp: 2500, lp: 10000, q: 1, drive: 0.3, atk: 0.0005, lvl: 0.95 } },
  { name: 'snare', x: 0.45, y: 0.42, hue: 22,
    p: { f: 172, pEnv: 0.65, pDec: 0.04, tone: 0.82, tDec: 0.18, fm: 0.1, noise: 1, nDec: 0.25, hp: 900, lp: 9000, drive: 0.3, lvl: 1.12 } },
  { name: 'clap', x: 0.67, y: 0.30, hue: 346,
    p: { f: 260, tone: 0, noise: 1, nDec: 0.095, burst: 1, metal: 0.55, mDec: 0.11, mPitch: 1.7, hp: 1150, lp: 5200, q: 4, drive: 0.34, lvl: 1.0 } },
  { name: 'closed hat', x: 0.70, y: 0.86, hue: 176,
    p: { noise: 0.3, nDec: 0.045, metal: 0.8, mDec: 0.05, hp: 7000, lp: 16000, drive: 0.1, atk: 0.0005, lvl: 1.0 } },
  { name: 'open hat', x: 0.86, y: 0.72, hue: 188,
    p: { noise: 0.3, nDec: 0.32, metal: 0.8, mDec: 0.38, hp: 7000, lp: 16000, drive: 0.1, atk: 0.0005, lvl: 1.0 } },
  { name: 'cymbal', x: 0.92, y: 0.93, hue: 202,
    p: { noise: 0.4, nDec: 0.90, metal: 0.8, mDec: 1.0, mPitch: 0.9, hp: 5000, lp: 15000, atk: 0.001, lvl: 0.85 } },
  { name: 'cowbell', x: 0.55, y: 0.68, hue: 78,
    p: { metal: 1, mDec: 0.28, hp: 450, lp: 1100, q: 6, drive: 0.25, lvl: 0.55 } },
  { name: 'zap', x: 0.86, y: 0.14, hue: 318,
    p: { f: 170, pEnv: 4.2, pDec: 0.16, tone: 1, tDec: 0.35, fm: 0.9, noise: 0.05, nDec: 0.05, hp: 2000, lp: 9000, drive: 0.2, atk: 0.003, lvl: 0.55 } },
  { name: 'rumble', x: 0.58, y: 0.08, hue: 262,
    p: { noise: 1, nDec: 0.55, hp: 35, lp: 380, q: 8, drive: 0.1, atk: 0.004, lvl: 1.3 } },
  // resonator / FM / fold anchors: the expanded palette
  { name: 'tabla', x: 0.30, y: 0.24, hue: 30,
    p: { f: 150, pEnv: 0.7, pDec: 0.03, tone: 0.45, tDec: 0.1, res: 1, resF: 205, resDec: 0.6, resShape: 0.5, noise: 0.1, nDec: 0.012, hp: 900, lp: 7000, drive: 0.12, lvl: 1.05 } },
  { name: 'marimba', x: 0.33, y: 0.63, hue: 48,
    p: { res: 1, resF: 440, resDec: 0.75, resShape: 1, noise: 0.06, nDec: 0.006, hp: 1500, lp: 8000, atk: 0.0005, drive: 0.05, lvl: 1.1 } },
  { name: 'bell', x: 0.84, y: 0.46, hue: 196,
    p: { f: 620, tone: 0.8, tDec: 1.1, fm: 0.55, fmRatio: 3.5, res: 0.5, resF: 1240, resDec: 1.0, resShape: 1, atk: 0.0005, lvl: 0.6 } },
  { name: 'fuzz', x: 0.46, y: 0.20, hue: 4,
    p: { f: 68, pEnv: 1.6, pDec: 0.05, tone: 1, tDec: 0.3, fm: 0.1, noise: 0.12, nDec: 0.02, hp: 600, lp: 4000, drive: 0.45, fold: 0.6, lvl: 0.8 } },
];

const ANCHORS = ANCHOR_DEFS.map((d) => ({
  name: d.name, x: d.x, y: d.y,
  rgb: hsl2rgb(d.hue, 0.72, 0.58),
  p: Object.assign({}, BASE, d.p),
}));

function weightsAt(x, y) {
  let m = Infinity;
  const d2 = ANCHORS.map((a) => {
    const d = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
    if (d < m) m = d;
    return d;
  });
  let s = 0;
  const w = d2.map((d) => { const v = Math.exp(-(d - m) / (2 * SIGMA * SIGMA)); s += v; return v; });
  return w.map((v) => v / s);
}

const LOG_KEYS = new Set(['f', 'pDec', 'tDec', 'nDec', 'mDec', 'mPitch', 'hp', 'lp', 'atk', 'fmRatio', 'resF', 'resDec']);
const GROUPS = [
  [['f', 'pEnv', 'pDec', 'tDec', 'fm', 'fmRatio'], (p) => p.tone + 0.03],
  [['resF', 'resDec', 'resShape'], (p) => p.res + 0.03],
  [['nDec', 'burst'], (p) => p.noise + 0.03],
  [['mDec', 'mPitch'], (p) => p.metal + 0.03],
  [['hp', 'lp', 'q'], (p) => p.noise + p.metal + 0.03],
  [['tone', 'noise', 'metal', 'res', 'drive', 'fold', 'atk', 'lvl'], () => 1],
];

function paramsAt(x, y, w) {
  w = w || weightsAt(x, y);
  const out = {};
  for (const [keys, gate] of GROUPS) {
    for (const key of keys) {
      const lg = LOG_KEYS.has(key);
      let sw = 0, acc = 0;
      for (let i = 0; i < ANCHORS.length; i++) {
        const g = w[i] * gate(ANCHORS[i].p);
        const v = ANCHORS[i].p[key];
        acc += g * (lg ? Math.log(v) : v);
        sw += g;
      }
      const r = acc / sw;
      out[key] = lg ? Math.exp(r) : r;
    }
  }
  return out;
}

function colorAt(x, y, w) {
  w = w || weightsAt(x, y);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < ANCHORS.length; i++) {
    r += w[i] * ANCHORS[i].rgb[0]; g += w[i] * ANCHORS[i].rgb[1]; b += w[i] * ANCHORS[i].rgb[2];
  }
  return [r, g, b];
}

/* maps a 0..1 slider value to a decay-length multiplier: 0.25x .. 4x,
   with 0.5 landing exactly on 1x (no change) */
function decayMultiplier(v) { return Math.pow(4, 2 * clamp(v, 0, 1) - 1); }

function nearest(w, n) {
  return w.map((v, i) => ({ name: ANCHORS[i].name, w: v })).sort((a, b) => b.w - a.w).slice(0, n);
}

/* voiceSignature: maps a voice's own parameters to a visual identity, so a
   point's look always follows its sound rather than a label.
   t      0 (low/tonal) .. 1 (high/noisy) on a log-frequency scale
   hue    30 (orange, low) .. 335 (pink) .. 280 (violet, high); kept clear of
          the UI's indicator yellow and playhead cyan
   tW/nW/mW  body / noise / metal share of the sound (sums to 1), used to mix
             liquid / smoke / spark behaviour
   level  rough loudness, drives particle count and size
   dec    a single representative decay time (s), drives particle lifetime */
function voiceSignature(P) {
  const body = clamp(P.tone, 0, 1), res = clamp(P.res || 0, 0, 1);
  const tone = clamp(body + res, 0, 1), noise = clamp(P.noise, 0, 1), metal = clamp(P.metal, 0, 1);
  const total = tone + noise + metal;
  const norm = total > 0.001 ? total : 1;
  const tW = tone / norm, nW = noise / norm, mW = metal / norm;
  const bodyN = body + res > 0.001 ? body + res : 1;
  const toneF = (body * P.f + res * (P.resF || P.f)) / bodyN;
  const toneDec = (body * P.tDec + res * (P.resDec || P.tDec)) / bodyN;
  const dec = (tone * toneDec + noise * P.nDec + metal * P.mDec) / norm;
  const noiseF = Math.sqrt(Math.max(P.hp, 20) * Math.min(Math.max(P.lp, P.hp * 1.2), 18000));
  const freq = clamp((tone * toneF + (noise + metal) * noiseF) / norm, 25, 18000);
  const t = clamp((Math.log(freq) - Math.log(28)) / (Math.log(15000) - Math.log(28)), 0, 1);
  const hue = (30 - 110 * t + 360) % 360;
  const level = clamp(total * 0.65 + P.drive * 0.35, 0.08, 1.4);
  const sat = clamp(0.55 + nW * 0.15 + tW * 0.12, 0, 0.92);
  const light = clamp(0.4 + mW * 0.22 + level * 0.08, 0, 0.8);
  return { t, hue, tW, nW, mW, freq, level, dec, drive: clamp(P.drive + (P.fold || 0), 0, 1), rgb: hsl2rgb(hue, sat, light) };
}

/* ==========================================================================
   Drum voice (Web Audio). One call = one hit.
   body: sine + pitch envelope (+ FM, any ratio)  noise: white noise, optional clap bursts
   metal: six detuned squares (808 hat ratios)   noise+metal -> high-pass -> low-pass
   resonator: a mallet click into five tuned band-passes (modal synthesis)
   all layers -> wavefolder (sine) -> drive (tanh) -> output. Short exponential amp envelopes.
   ========================================================================== */

const METAL_RATIOS = [205.3, 304.4, 369.6, 522.7, 540, 800];
const BURST_GAP = 0.0105;
const SHAPER_CURVE = (() => {
  const n = 2048, c = new Float32Array(n), k = 1.5, d = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh((i / (n - 1) * 2 - 1) * k) / d;
  return c;
})();

/* wavefolder: a sine fold, crossfaded in from dry so small amounts are
   gentle. Curves are cached per 1/50th of the fold amount. */
const FOLD_CURVES = new Map();
function foldCurve(amount) {
  const key = Math.round(clamp(amount, 0, 1) * 50);
  let c = FOLD_CURVES.get(key);
  if (!c) {
    const a = key / 50, n = 2048, k = 1 + 7 * a, m = Math.min(1, a * 4);
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * 2 - 1;
      c[i] = (1 - m) * x + m * Math.sin(x * k * Math.PI / 2);
    }
    FOLD_CURVES.set(key, c);
  }
  return c;
}

/* the glide voice's folder: one fixed sine fold, k = 8, with the amount
   set by how hard it's driven and how much of it is mixed in. Close to
   foldCurve(amount) behind its input gain, and it can move mid-note. */
const GLIDE_FOLD = (() => {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.sin((i / (n - 1) * 2 - 1) * 4 * Math.PI);
  return c;
})();
function foldMix(amount) {
  const a = clamp(amount, 0, 1), g = 1 + 2.2 * a, m = Math.min(1, a * 4);
  return { dry: (1 - m) * g, drive: g * (1 + 7 * a) / 8, wet: m };
}

/* resonator mode ratios. resShape morphs (log domain) between three
   idealized bodies: a string/tube (harmonic), a circular membrane, and a
   free bar (marimba, bell-ish). */
const MODE_SETS = [
  [1, 2, 3, 4, 5],
  [1, 1.594, 2.136, 2.296, 2.653],
  [1, 2.756, 5.404, 8.933, 13.344],
];
const MODE_AMPS = [1, 0.62, 0.46, 0.36, 0.28];
function modeRatios(shape) {
  const s = clamp(shape, 0, 1) * 2;
  const i = Math.min(1, Math.floor(s)), f = s - i;
  return MODE_SETS[0].map((_, k) => Math.exp(Math.log(MODE_SETS[i][k]) * (1 - f) + Math.log(MODE_SETS[i + 1][k]) * f));
}
/* Q that makes a band-pass ring for `t60` seconds at `freq`: a two-pole
   resonator's envelope falls as exp(-pi f t / Q), and -60 dB is ln(1000). */
function modeQ(freq, t60) { return clamp(Math.PI * freq * t60 / Math.log(1000), 0.5, 4000); }

/* a short half-sine "mallet" pulse; its area is what the resonator gain
   compensation divides by. One buffer per context. The buffer runs on in
   silence for 4 s: Chromium stops processing a biquad ~0.28 s after its
   source ends (tail-time cap), so the source has to outlive the ring. */
const CLICK_BUFS = new WeakMap();
const CLICK_LEN = 12;
const CLICK_AREA = (() => { let s = 0; for (let i = 0; i < CLICK_LEN; i++) s += Math.sin(Math.PI * (i + 0.5) / CLICK_LEN); return s; })();
function clickBuf(ctx) {
  let b = CLICK_BUFS.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 4.05), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < CLICK_LEN; i++) d[i] = Math.sin(Math.PI * (i + 0.5) / CLICK_LEN);
    CLICK_BUFS.set(ctx, b);
  }
  return b;
}

function ampEnv(param, t, atk, level, dec) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(level, t + atk);
  param.exponentialRampToValueAtTime(0.0008, t + atk + dec);
}

/* noise envelope; returns the lead time taken by pre-bursts */
function noiseEnv(param, t, atk, level, dec, burst) {
  param.setValueAtTime(0, t);
  let tt = t;
  if (burst > 0.03) {
    for (let i = 0; i < 3; i++) {
      param.linearRampToValueAtTime(level * burst, tt + 0.0008);
      param.exponentialRampToValueAtTime(level * burst * 0.08 + 0.0005, tt + BURST_GAP * 0.9);
      tt += BURST_GAP;
    }
  }
  param.linearRampToValueAtTime(level, tt + atk);
  param.exponentialRampToValueAtTime(0.0008, tt + atk + dec);
  return tt - t;
}

function makeNoise(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/* the kit-wide macro mixes applied to one voice's parameters; 1 = unchanged */
function mixedParams(P, trims) {
  const m = (k) => (trims[k] == null ? 1 : trims[k]);
  return Object.assign({}, BASE, P, {
    tone: clamp(P.tone * m('toneMix'), 0, 2),
    noise: clamp(P.noise * m('noiseMix'), 0, 2),
    metal: clamp(P.metal * m('metalMix'), 0, 2),
    res: clamp((P.res || 0) * m('resMix'), 0, 2),
    atk: Math.max(0.0002, P.atk * m('punch')),
  });
}

/* playVoice: one hit. Returns {end, srcs} or, with opts.glide, a handle whose
   glide(P2, at) steers the still-ringing voice toward another point on the
   map: pitch, filters, the balance of its layers and its level move; its
   envelopes and decays stay as they were struck. A glide voice builds every
   layer (silent ones at zero) so a layer can fade in mid-note, which costs
   more nodes, so only smooth-mode hits ask for it. */
const GLIDE_TAU = 0.012;
function playVoice(ctx, out, noiseBuf, P, trims, t, extraDecay, opts) {
  const glide = !!(opts && opts.glide);
  const tune = Math.pow(2, trims.tune / 12);
  const dm = trims.decay * (extraDecay == null ? 1 : extraDecay);
  const drive = clamp(P.drive + trims.drive, 0, 1);
  const fold = clamp((P.fold || 0) + (trims.fold || 0), 0, 1);
  P = mixedParams(P, trims);

  const pre = ctx.createGain(); pre.gain.value = 1 + drive * 5;
  const shp = ctx.createWaveShaper(); shp.curve = SHAPER_CURVE;
  const post = ctx.createGain(); post.gain.value = P.lvl * 0.9 / (1 + drive * 0.8);
  pre.connect(shp); shp.connect(post); post.connect(out);
  // every layer feeds `bus`: straight into the drive stage, or through the
  // wavefolder first when there's any fold
  let bus = pre, foldNodes = null;
  if (glide) {
    // glide voices always carry a folder so a glide can fade fold in: a
    // dry path and a sine fold path, crossfaded (see foldMix)
    bus = ctx.createGain();
    const dry = ctx.createGain(), fin = ctx.createGain(), wet = ctx.createGain();
    const fs = ctx.createWaveShaper(); fs.curve = GLIDE_FOLD; fs.oversample = '2x';
    bus.connect(dry); dry.connect(pre); bus.connect(fin); fin.connect(fs); fs.connect(wet); wet.connect(pre);
    const fm = foldMix(fold);
    dry.gain.value = fm.dry; fin.gain.value = fm.drive; wet.gain.value = fm.wet;
    foldNodes = { dry, fin, wet };
  } else if (fold > 0.01) {
    // more fold also drives the folder harder, so it keeps biting into the tail
    bus = ctx.createGain(); bus.gain.value = 0.8 + fold * 2.4;
    const fs = ctx.createWaveShaper(); fs.curve = foldCurve(fold); fs.oversample = '2x';
    bus.connect(fs); fs.connect(pre);
  }

  let end = t;
  const srcs = []; // every source, so a stolen voice can be stopped outright
  const stopAt = (node, time) => { node.stop(time); srcs.push(node); if (time > end) end = time; };
  // glide voices: each layer's envelope runs at full scale into a mix gain
  // that carries the layer's level, so the level can move later
  const G = {};
  const mixInto = (level, dest) => { const m = ctx.createGain(); m.gain.value = level; m.connect(dest); return m; };
  // a layer that's silent when struck rings as long as the voice's longest
  // layer, so a later glide can still fade it in
  const on = (lvl) => lvl > 0.02;
  const longest = Math.max(on(P.tone) ? P.tDec : 0, on(P.noise) ? P.nDec : 0, on(P.metal) ? P.mDec : 0, on(P.res) ? P.resDec : 0, 0.05);
  const decOf = (lvl, d) => (glide && !on(lvl) ? longest : d);

  if (P.tone > 0.02 || glide) {
    const f = P.f * tune, fs = f * Math.pow(2, P.pEnv), tau = Math.max(0.003, P.pDec / 3);
    const dur = decOf(P.tone, P.tDec) * dm;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(fs, t);
    osc.frequency.setTargetAtTime(f, t, tau);
    const g = ctx.createGain();
    ampEnv(g.gain, t, P.atk, glide ? 1 : P.tone, dur);
    if (P.fm > 0.02 || glide) {
      const mod = ctx.createOscillator(); mod.type = 'sine';
      mod.frequency.setValueAtTime(fs * P.fmRatio, t);
      mod.frequency.setTargetAtTime(f * P.fmRatio, t, tau);
      const mg = ctx.createGain();
      // glide voices: the envelope runs at unit depth into a gain that
      // carries the FM amount, so the amount can move later
      mg.gain.setValueAtTime((glide ? 1 : P.fm) * f * 4, t);
      mg.gain.setTargetAtTime(0, t, Math.max(0.008, dur * 0.25));
      mod.connect(mg);
      if (glide) { G.fmAmt = ctx.createGain(); G.fmAmt.gain.value = P.fm; mg.connect(G.fmAmt); G.fmAmt.connect(osc.frequency); }
      else mg.connect(osc.frequency);
      mod.start(t); stopAt(mod, t + P.atk + dur + 0.05);
      G.mod = mod;
    }
    osc.connect(g);
    if (glide) { G.tone = mixInto(P.tone, bus); g.connect(G.tone); G.osc = osc; G.sweepEnd = t + P.pDec; }
    else g.connect(bus);
    osc.start(t); stopAt(osc, t + P.atk + dur + 0.05);
  }

  const wantN = P.noise > 0.02 || glide, wantM = P.metal > 0.02 || glide;
  if (wantN || wantM) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
    hp.frequency.value = P.hp; hp.Q.value = -3;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = Math.min(Math.max(P.lp, P.hp * 1.2), ctx.sampleRate * 0.45);
    lp.Q.value = P.q;
    hp.connect(lp); lp.connect(bus);
    if (glide) { G.hp = hp; G.lp = lp; }

    if (wantN) {
      const dur = decOf(P.noise, P.nDec) * dm;
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const ng = ctx.createGain();
      const lead = noiseEnv(ng.gain, t, P.atk, glide ? 1 : P.noise, dur, P.burst);
      src.connect(ng);
      if (glide) { G.noise = mixInto(P.noise, hp); ng.connect(G.noise); } else ng.connect(hp);
      src.start(t, Math.random() * (noiseBuf.duration - 0.2));
      stopAt(src, t + lead + P.atk + dur + 0.05);
    }
    if (wantM) {
      const dur = decOf(P.metal, P.mDec) * dm;
      const mg = ctx.createGain();
      ampEnv(mg.gain, t, P.atk, (glide ? 1 : P.metal) * 0.35, dur);
      if (glide) G.metalOsc = [];
      for (const r of METAL_RATIOS) {
        const o = ctx.createOscillator(); o.type = 'square';
        o.frequency.value = r * P.mPitch * tune;
        o.connect(mg);
        o.start(t); stopAt(o, t + P.atk + dur + 0.05);
        if (glide) G.metalOsc.push([o, r]);
      }
      if (glide) { G.metal = mixInto(P.metal, hp); mg.connect(G.metal); } else mg.connect(hp);
    }
  }

  if (P.res > 0.02 || glide) {
    const sr = ctx.sampleRate, t60 = Math.min(4, decOf(P.res, P.resDec) * dm);
    const src = ctx.createBufferSource(); src.buffer = clickBuf(ctx);
    const rg = ctx.createGain(); rg.gain.value = P.res * 0.45;
    rg.connect(bus);
    if (glide) { G.res = rg; G.modes = []; }
    modeRatios(P.resShape).forEach((r, k) => {
      const fr = P.resF * tune * r;
      if (fr > sr * 0.45) return;
      const Q = modeQ(fr, t60), w0 = 2 * Math.PI * fr / sr;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = fr; bp.Q.value = Q;
      // a band-pass hit by a unit impulse rings at ~sin(w0)/Q; undo that
      // so every mode starts at MODE_AMPS[k] whatever its pitch and ring
      const g = ctx.createGain(); g.gain.value = MODE_AMPS[k] * Q / (Math.sin(w0) * CLICK_AREA);
      src.connect(bp); bp.connect(g); g.connect(rg);
      if (glide) G.modes.push([bp, k]);
    });
    src.start(t + P.atk);
    stopAt(src, t + P.atk + t60 + 0.02);
  }
  if (!glide) return { end, srcs };

  return {
    end, srcs,
    glide(P2, at) {
      at = Math.max(at, t);
      const Q = mixedParams(P2, trims), to = (param, v) => param.setTargetAtTime(v, at, GLIDE_TAU);
      // the body's pitch sweep keeps running; a glide during it retargets
      // where the sweep lands
      const f = Q.f * tune, when = Math.max(at, G.sweepEnd || at);
      if (G.osc) G.osc.frequency.setTargetAtTime(f, when, GLIDE_TAU);
      if (G.mod) G.mod.frequency.setTargetAtTime(f * Q.fmRatio, when, GLIDE_TAU);
      if (G.fmAmt) to(G.fmAmt.gain, Q.fm);
      if (G.tone) to(G.tone.gain, Q.tone);
      if (G.noise) to(G.noise.gain, Q.noise);
      if (G.metal) to(G.metal.gain, Q.metal);
      if (G.metalOsc) for (const [o, r] of G.metalOsc) to(o.frequency, r * Q.mPitch * tune);
      if (G.hp) { to(G.hp.frequency, Q.hp); to(G.lp.frequency, Math.min(Math.max(Q.lp, Q.hp * 1.2), ctx.sampleRate * 0.45)); to(G.lp.Q, Q.q); }
      if (G.res) {
        to(G.res.gain, Q.res * 0.45);
        const rr = modeRatios(Q.resShape);
        for (const [bp, k] of G.modes) to(bp.frequency, Math.min(Q.resF * tune * rr[k], ctx.sampleRate * 0.45));
      }
      const d2 = clamp(P2.drive + trims.drive, 0, 1), fm2 = foldMix(clamp((P2.fold || 0) + (trims.fold || 0), 0, 1));
      to(pre.gain, 1 + d2 * 5);
      to(post.gain, Q.lvl * 0.9 / (1 + d2 * 0.8));
      to(foldNodes.dry.gain, fm2.dry); to(foldNodes.fin.gain, fm2.drive); to(foldNodes.wet.gain, fm2.wet);
    },
  };
}

/* autoAt: a smooth-recorded step's position at offset o (0..1 through the
   step), linearly between its evenly spaced automation points */
function autoAt(auto, o) {
  const p = clamp(o, 0, 1) * (auto.length - 1), i = Math.min(auto.length - 2, Math.floor(p)), f = p - i;
  return { x: auto[i].x + (auto[i + 1].x - auto[i].x) * f, y: auto[i].y + (auto[i + 1].y - auto[i].y) * f };
}
const AUTO_POINTS = 16; // automation points recorded per step in smooth mode (as Slicefield)

const MAX_VOICES = 14;
class Engine {
  /* opts.dry: no master compressor (stems for export) */
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.trims = { tune: 0, decay: 1, drive: 0 };
    this.noise = makeNoise(ctx);
    this.voices = [];
    this.mono = false;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.12;
    if (opts && opts.dry) this.master.connect(ctx.destination);
    else { this.master.connect(comp); comp.connect(ctx.destination); }
  }
  /* stop a voice: a short fade, then its sources are stopped outright so a
     stolen voice stops costing CPU (fading alone left every oscillator
     running to its natural end, hundreds of them under dense ratchets) */
  silence(v, at) {
    try { v.out.gain.cancelScheduledValues(at); } catch (_) {}
    v.out.gain.setTargetAtTime(0, at, 0.006);
    for (const n of v.srcs) { try { n.stop(at + 0.04); } catch (_) {} }
  }
  trigger(P, t, extraDecay, opts) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (t === undefined || t < now) t = now;
    this.voices = this.voices.filter((v) => v.end > now);
    if (this.mono) {
      // voice-stealing: silence whatever's still sounding, but scheduled at
      // this new hit's own start time `t` (which the lookahead scheduler
      // often sets a little into the future) -- not at `now`, which would
      // choke every voice the instant it's merely scheduled, well before
      // its turn actually arrives.
      for (const v of this.voices) if (v.end > t) this.silence(v, t);
      this.voices = [];
    }
    while (this.voices.length >= MAX_VOICES) this.silence(this.voices.shift(), Math.max(now, t - 0.002));
    const out = ctx.createGain();
    out.connect(this.master);
    const r = playVoice(ctx, out, this.noise, P, this.trims, t, extraDecay, opts);
    const v = { out, t, end: r.end, srcs: r.srcs, glide: r.glide };
    this.voices.push(v);
    // once every source has ended, unhook the voice so its nodes can be
    // collected; Safari holds on to finished nodes that stay connected
    let left = r.srcs.length;
    const done = () => { if (--left === 0) { try { out.disconnect(); } catch (_) {} } };
    for (const n of r.srcs) n.addEventListener('ended', done, { once: true });
    return v; // v.glide(P2, at) exists for glide voices
  }
}

/* ==========================================================================
   Sequence: 16 steps, each step owns a point on the map.
   Gestures
     tap step                     switch it on or off
     hold pad + tap step          step takes the point under the pad
     hold step(s) + touch/drag pad  held steps follow the pad
   Mouse helpers: pin (pad counts as held), select (steps latch as held).
   ========================================================================== */

/* Per-step lanes beyond on/off and position:
   prob          chance the step fires at all when the playhead reaches it
   devXChance    chance that, when it fires, its X is nudged away from s.x
   devXAmount    how far that nudge can reach (fraction of pad width, +/-)
   devYChance/devYAmount        the same for Y
   decay         base decay multiplier for this step, 0..1 slider -> 0.25x..4x (see decayMultiplier)
   decDevChance  chance that, when it fires, decay is nudged away from s.decay
   decDevAmount  how far that nudge can reach, in the same 0..1 slider space */
const LANE_DEFAULTS = {
  prob: 1,
  devXChance: 0, devXAmount: 0.2,
  devYChance: 0, devYAmount: 0.2,
  decay: 0.5, decDevChance: 0, decDevAmount: 0.25,
};
const freshStep = () => Object.assign({ on: false, x: 0.5, y: 0.5, set: false, ratchets: [] }, LANE_DEFAULTS);

/* Ratchet bar: the vertical bar beside the pad. It rests at 1/16 and
   springs back when let go. Every setting fits a whole number of hits into
   one 16th step, because a recorded setting applies to the whole step. */
const RATCHET_VALUES = [16, 32, 48, 64, 96];
const ratchetHits = (n) => Math.max(1, Math.round(n / 16));
function slotDuration(tempo, quantN) {
  return (60 / tempo) * (4 / quantN);
}
/* Catch window: a move made in the first RATCHET_CATCH of a step counts
   for that step; a later one is held for the next. catchStep returns the
   (unwrapped) step index a move at time t is written to. With 0.5 this is
   rounding to the nearest 16th. */
const RATCHET_CATCH = 0.5;
function catchStep(t, barStart, stepDur, catchFrac) {
  const c = catchFrac == null ? RATCHET_CATCH : catchFrac;
  return Math.floor((t - barStart) / stepDur + (1 - c) + 1e-9);
}
/* swing as a percentage, 50 (straight) .. 75: the off-beat 16th sits that
   far through each pair of 16ths, so 75% delays it by half a step. */
function swingOffset(stepIndex, swingPct, stepDur) {
  return stepIndex % 2 === 1 ? clamp(2 * swingPct / 100 - 1, 0, 1) * stepDur : 0;
}
const evenRatchets = (x, y, hits) => Array.from({ length: hits - 1 }, (_, k) => ({ offset: (k + 1) / hits, x, y }));

class Sequence {
  constructor(onChange, onAudition) {
    this.steps = Array.from({ length: N_STEPS }, freshStep);
    this.cursor = { x: 0.45, y: 0.42 };
    this.padDown = new Set();
    this.held = new Set();
    this.latched = new Set();
    this.consumed = new Set();
    this.pin = false;
    this.select = false;
    this.onChange = onChange || (() => {});
    this.onAudition = onAudition || (() => {});
  }
  padHeld() { return this.padDown.size > 0 || this.pin; }
  targets() { return new Set([...this.held, ...this.latched]); }
  assign(i) {
    const s = this.steps[i];
    s.x = this.cursor.x; s.y = this.cursor.y; s.on = true; s.set = true;
  }
  assignTargets() {
    for (const i of this.targets()) {
      this.assign(i);
      if (this.held.has(i)) this.consumed.add(i);
    }
  }
  padPress(id, x, y) {
    this.padDown.add(id);
    this.cursor = { x, y };
    this.assignTargets();
    this.onAudition(x, y, 'press');
    this.onChange();
  }
  padMove(x, y) {
    this.cursor = { x, y };
    this.assignTargets();
    this.onAudition(x, y, 'move');
    this.onChange();
  }
  padRelease(id) { this.padDown.delete(id); this.onChange(); }
  stepDown(i) {
    if (this.select) {
      if (this.latched.has(i)) this.latched.delete(i); else this.latched.add(i);
      this.onChange();
      return;
    }
    // hold exactly one other step and tap this one: copy that step's sound here
    if (!this.padHeld()) {
      const others = [...this.held].filter((h) => h !== i);
      if (others.length === 1) {
        const srcIndex = others[0];
        const src = this.steps[srcIndex], dst = this.steps[i];
        // the copy carries the source's ratchets and smooth gesture too
        dst.x = src.x; dst.y = src.y; dst.on = true; dst.set = true;
        dst.ratchets = src.ratchets.map((r) => ({ ...r }));
        dst.auto = src.auto ? src.auto.map((q) => ({ ...q })) : null;
        this.held.add(i);
        this.consumed.add(i);
        // the source step was just used as a copy source: it shouldn't
        // toggle off/delete when the hold on it is released either.
        this.consumed.add(srcIndex);
        this.onAudition(src.x, src.y, 'copy');
        this.onChange();
        return;
      }
    }
    this.held.add(i);
    this.consumed.delete(i);
    if (this.padHeld()) {
      this.assign(i);
      this.consumed.add(i);
      this.onAudition(this.cursor.x, this.cursor.y, 'assign');
    }
    this.onChange();
  }
  stepUp(i) {
    if (!this.held.has(i)) return;
    this.held.delete(i);
    if (!this.consumed.has(i)) this.toggle(i);
    this.consumed.delete(i);
    this.onChange();
  }
  /* erase: delete a step outright (the trash key). keepHeld: it's still
     held, so its release mustn't toggle it back on */
  erase(i, keepHeld) {
    this.steps[i] = freshStep();
    if (keepHeld && this.held.has(i)) this.consumed.add(i);
    else { this.held.delete(i); this.consumed.delete(i); }
    this.onChange();
  }
  stepCancel(i) { this.held.delete(i); this.consumed.delete(i); this.onChange(); }
  toggle(i) {
    const s = this.steps[i];
    if (s.on) {
      // a full delete, not just an off switch: clears position, ratchets
      // and lanes too, so tapping it back on starts fresh rather than
      // reviving whatever used to be there (undo still covers an accident).
      this.steps[i] = freshStep();
      return;
    }
    s.on = true;
    if (!s.set) { s.x = this.cursor.x; s.y = this.cursor.y; s.set = true; }
  }
  setSelect(v) { this.select = v; if (!v) this.latched.clear(); this.onChange(); }
  setPin(v) { this.pin = v; this.onChange(); }
  releaseAll() {
    this.padDown.clear(); this.held.clear(); this.consumed.clear(); this.onChange();
  }
  focus() {
    const t = [...this.targets()];
    if (t.length === 1) {
      const s = this.steps[t[0]];
      return { kind: 'step', index: t[0], x: s.x, y: s.y };
    }
    return { kind: 'cursor', x: this.cursor.x, y: this.cursor.y };
  }
  clear() {
    this.steps = this.steps.map(freshStep);
    this.onChange();
  }
  load(list) {
    this.clear();
    for (const [i, x, y] of list) Object.assign(this.steps[i], { on: true, x, y, set: true });
    this.onChange();
  }
  /* trial: resolves one step's trigger for a scheduled hit, returning
     {fired, x, y, decMult} without mutating anything (deviation, like
     probability, is rolled fresh for each occurrence). */
  trial(i) {
    const s = this.steps[i];
    if (!s.on || Math.random() >= s.prob) return { fired: false, x: s.x, y: s.y, decMult: decayMultiplier(s.decay) };
    let x = s.x, y = s.y;
    if (s.devXChance > 0 && Math.random() < s.devXChance) {
      x = clamp(x + (Math.random() * 2 - 1) * s.devXAmount, 0, 1);
    }
    if (s.devYChance > 0 && Math.random() < s.devYChance) {
      y = clamp(y + (Math.random() * 2 - 1) * s.devYAmount, 0, 1);
    }
    let dv = s.decay;
    if (s.decDevChance > 0 && Math.random() < s.decDevChance) {
      dv = clamp(dv + (Math.random() * 2 - 1) * s.decDevAmount, 0, 1);
    }
    return { fired: true, x, y, decMult: decayMultiplier(dv) };
  }
  /* liveWrite: used while recording. Writes a point straight into a step
     (on, set, position) and notifies, same as any other mutation. */
  liveWrite(i, x, y) {
    const s = this.steps[i];
    s.x = x; s.y = y; s.on = true; s.set = true;
    this.onChange();
  }
  /* liveWriteSlot: event-driven recording write, quantized to any grid.
     offset===0 writes/refreshes the step's primary hit (and clears any
     stale ratchets, since a fresh primary hit starts a new gesture at
     this step). offset>0 upserts a ratchet sub-hit at that offset
     (replacing one already at ~the same offset so re-touching the same
     slot doesn't pile up duplicates). */
  liveWriteSlot(stepIndex, offset, x, y) {
    const s = this.steps[stepIndex];
    if (offset <= 0) {
      s.x = x; s.y = y; s.on = true; s.set = true;
      s.ratchets = [];
    } else {
      if (!Array.isArray(s.ratchets)) s.ratchets = [];
      const EPS = 0.02;
      const existing = s.ratchets.find((r) => Math.abs(r.offset - offset) < EPS);
      if (existing) { existing.offset = offset; existing.x = x; existing.y = y; }
      else s.ratchets.push({ offset, x, y });
      s.ratchets.sort((a, b) => a.offset - b.offset);
    }
    this.onChange();
  }
  /* recordStep: a recorded pad hit for one whole step, played `hits`
     times evenly through it (1 = no ratchet) */
  recordStep(i, x, y, hits) {
    const s = this.steps[i];
    s.x = x; s.y = y; s.on = true; s.set = true;
    s.ratchets = evenRatchets(x, y, hits);
    s.auto = null;
    this.onChange();
  }
  /* setAuto: a smooth-recorded gesture for one step, AUTO_POINTS evenly
     spaced {x, y} through it. The step's own position becomes its start. */
  setAuto(i, auto) {
    const s = this.steps[i];
    if (!s.on || !auto || auto.length < 2) return;
    s.auto = auto.map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }));
    s.x = s.auto[0].x; s.y = s.auto[0].y;
    for (const r of s.ratchets) { const q = autoAt(s.auto, r.offset); r.x = q.x; r.y = q.y; }
    this.onChange();
  }
  setLane(i, key, value) {
    if (!(key in LANE_DEFAULTS)) return;
    this.steps[i][key] = clamp(value, 0, 1);
    this.onChange();
  }
  resetLane(keys) {
    for (const s of this.steps) for (const k of keys) s[k] = LANE_DEFAULTS[k];
    this.onChange();
  }
}

/* ==========================================================================
   Engine parameters: the drum-engine knobs, grouped by layer. Also the
   ranges modulation works within.
   ========================================================================== */
const MODULES = [
  { id: 'body', label: 'Body', accent: '--m-body' },
  { id: 'noise', label: 'Noise', accent: '--m-noise' },
  { id: 'metal', label: 'Metal', accent: '--m-metal' },
  { id: 'res', label: 'Resonator', accent: '--m-res' },
  { id: 'filter', label: 'Filter', accent: '--m-filter' },
  { id: 'out', label: 'Shape & out', accent: '--m-out' },
];
const PARAM_SPECS = [
  { key: 'tone', mod: 'body', label: 'Level', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'f', mod: 'body', label: 'Pitch', min: 20, max: 2000, step: 1, unit: 'hz', log: true },
  { key: 'tDec', mod: 'body', label: 'Decay', min: 0.02, max: 1.2, step: 0.005, unit: 's', log: true },
  { key: 'pEnv', mod: 'body', label: 'Sweep', min: 0, max: 5, step: 0.05, unit: 'oct' },
  { key: 'pDec', mod: 'body', label: 'Sweep time', min: 0.005, max: 0.3, step: 0.001, unit: 's', log: true },
  { key: 'fm', mod: 'body', label: 'FM', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'fmRatio', mod: 'body', label: 'FM ratio', min: 0.5, max: 8, step: 0.01, unit: 'x', log: true },
  { key: 'noise', mod: 'noise', label: 'Level', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'nDec', mod: 'noise', label: 'Decay', min: 0.01, max: 1.2, step: 0.005, unit: 's', log: true },
  { key: 'burst', mod: 'noise', label: 'Clap', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'metal', mod: 'metal', label: 'Level', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'mDec', mod: 'metal', label: 'Decay', min: 0.02, max: 1.2, step: 0.005, unit: 's', log: true },
  { key: 'mPitch', mod: 'metal', label: 'Pitch', min: 0.3, max: 2.5, step: 0.01, unit: 'x', log: true },
  { key: 'res', mod: 'res', label: 'Level', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'resF', mod: 'res', label: 'Pitch', min: 40, max: 4000, step: 1, unit: 'hz', log: true },
  { key: 'resDec', mod: 'res', label: 'Ring', min: 0.03, max: 3, step: 0.005, unit: 's', log: true },
  { key: 'resShape', mod: 'res', label: 'Body', min: 0, max: 1, step: 0.01, unit: 'shape' },
  { key: 'hp', mod: 'filter', label: 'High-pass', min: 20, max: 10000, step: 10, unit: 'hz', log: true },
  { key: 'lp', mod: 'filter', label: 'Low-pass', min: 200, max: 18000, step: 10, unit: 'hz', log: true },
  { key: 'q', mod: 'filter', label: 'Reso', min: 0, max: 10, step: 0.1, unit: 'q' },
  { key: 'fold', mod: 'out', label: 'Fold', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'drive', mod: 'out', label: 'Drive', min: 0, max: 1, step: 0.01, unit: 'frac' },
  { key: 'atk', mod: 'out', label: 'Attack', min: 0, max: 0.02, step: 0.0005, unit: 's' },
  { key: 'lvl', mod: 'out', label: 'Level', min: 0.2, max: 2, step: 0.01, unit: 'x' },
];
const PARAM_BY_KEY = Object.fromEntries(PARAM_SPECS.map((p) => [p.key, p]));

/* ==========================================================================
   Modulation: MOD_COUNT modulators. Each is an LFO (standard or orbital
   shape) or a one-shot envelope, with one destination, applied to any
   number of targets: a step, a drum (every hit whose main voice is that
   anchor) or the whole kit. An LFO is read at the moment of each hit; an
   envelope runs through the hit (the voice glides along it).
   ========================================================================== */
const MOD_COUNT = 6;
const MOD_RATES = [
  { name: '4 bars', beats: 16 }, { name: '2 bars', beats: 8 }, { name: '1 bar', beats: 4 },
  { name: '1/2', beats: 2 }, { name: '1/4', beats: 1 }, { name: '1/8', beats: 0.5 }, { name: '1/16', beats: 0.25 },
];
/* ctl: what the shape's own knob does, and the range it maps 0..1 onto */
const MOD_SHAPES = [
  { id: 'sine', name: 'Sine' }, { id: 'triangle', name: 'Triangle' }, { id: 'saw', name: 'Saw' },
  { id: 'square', name: 'Square' }, { id: 'random', name: 'Random', ctl: ['Smooth', 0, 1] },
  { id: 'kepler', name: 'Kepler', orbit: true, ctl: ['Eccentric', 0, 0.9] },
  { id: 'precession', name: 'Precession', orbit: true, ctl: ['Precess', 0.02, 0.3] },
  { id: 'halo', name: 'Halo', orbit: true, ctl: ['Detune', 0.01, 0.25] },
  { id: 'retrograde', name: 'Retrograde', orbit: true, ctl: ['Ratio', 1.3, 3] },
  { id: 'resonance', name: 'Resonance', orbit: true, ctl: ['Balance', 0, 1] },
  { id: 'figure8', name: 'Figure-eight', orbit: true },
  { id: 'env', name: 'Envelope', env: true },
];
const SHAPE_BY_ID = Object.fromEntries(MOD_SHAPES.map((s) => [s.id, s]));

function kepler(M, e) { // solve E - e sin E = M
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}
/* the Chenciner-Montgomery three-body figure-eight, integrated once */
let FIG8 = null;
function fig8At(ph) {
  if (!FIG8) {
    const Tp = 6.32591398, n = 2000, dt = Tp / n;
    let p = [[0.97000436, -0.24308753], [-0.97000436, 0.24308753], [0, 0]];
    const v3 = [-0.93240737, -0.86473146];
    let v = [[-v3[0] / 2, -v3[1] / 2], [-v3[0] / 2, -v3[1] / 2], [v3[0], v3[1]]];
    const acc = (q) => q.map((qi, i) => {
      let ax = 0, ay = 0;
      q.forEach((qj, j) => { if (i === j) return; const dx = qj[0] - qi[0], dy = qj[1] - qi[1], r3 = Math.pow(dx * dx + dy * dy, 1.5); ax += dx / r3; ay += dy / r3; });
      return [ax, ay];
    });
    FIG8 = []; let a = acc(p);
    for (let s = 0; s <= n; s++) {
      FIG8.push([p[0][0], p[0][1]]);
      v = v.map((vi, i) => [vi[0] + a[i][0] * dt / 2, vi[1] + a[i][1] * dt / 2]);
      p = p.map((pi, i) => [pi[0] + v[i][0] * dt, pi[1] + v[i][1] * dt]);
      a = acc(p);
      v = v.map((vi, i) => [vi[0] + a[i][0] * dt / 2, vi[1] + a[i][1] * dt / 2]);
    }
  }
  const q = FIG8[Math.floor((((ph % 1) + 1) % 1) * (FIG8.length - 1))];
  return { x: q[0] / 1.1, y: q[1] / 1.1 };
}
const hash01 = (n) => { const x = Math.sin(n * 91.7 + 13.1) * 43758.5453; return x - Math.floor(x); };
/* lfoAt: an LFO's position at p cycles (p may run past 1). x is the output,
   roughly -1..1; y is only for drawing the body in orbit. */
function lfoAt(shape, p, ctl) {
  const sh = SHAPE_BY_ID[shape] || SHAPE_BY_ID.sine;
  const c = sh.ctl ? sh.ctl[1] + clamp(ctl, 0, 1) * (sh.ctl[2] - sh.ctl[1]) : 0;
  const a = 2 * Math.PI * p, f = ((p % 1) + 1) % 1;
  switch (shape) {
    case 'triangle': return { x: 1 - 4 * Math.abs(((f + 0.25) % 1) - 0.5), y: 0 };
    case 'saw': return { x: 2 * f - 1, y: 0 };
    case 'square': return { x: f < 0.5 ? 1 : -1, y: 0 };
    case 'random': {
      // four values a cycle; Smooth eases each one into the next over that
      // share of its step (0 = held steps)
      const q = p * 4, n = Math.floor(q), u = q - n, a0 = hash01(n), a1 = hash01(n + 1);
      const w = c > 0.001 ? 0.5 - 0.5 * Math.cos(Math.PI * clamp((u - (1 - c)) / c, 0, 1)) : 0;
      return { x: 2 * (a0 + (a1 - a0) * w) - 1, y: 0 };
    }
    case 'kepler': { const E = kepler(a, c), b = Math.sqrt(1 - c * c); return { x: (Math.cos(E) - c) / (1 + c), y: b * Math.sin(E) / (1 + c) }; }
    case 'precession': {
      const e = 0.5, E = kepler(a, e), b = Math.sqrt(1 - e * e), x0 = (Math.cos(E) - e) / 1.5, y0 = b * Math.sin(E) / 1.5, w = c * a;
      return { x: x0 * Math.cos(w) - y0 * Math.sin(w), y: x0 * Math.sin(w) + y0 * Math.cos(w) };
    }
    case 'halo': return { x: Math.sin(a), y: 0.85 * Math.sin(a * (1 + c) + 0.6) };
    case 'retrograde': return { x: (1.52 * Math.cos(a) - Math.cos(a * c)) / 2.6, y: (1.52 * Math.sin(a) - Math.sin(a * c)) / 2.6 };
    case 'resonance': return { x: (1 - c) * Math.cos(a) + c * Math.cos(2 * a), y: (1 - c) * Math.sin(a) + c * Math.sin(2 * a) };
    case 'figure8': return fig8At(p);
    default: return { x: Math.sin(a), y: Math.cos(a) };
  }
}
/* the envelope: attack 1 ms..1 s, decay 10 ms..2 s, both on a log scale */
const envAttack = (m) => 0.001 * Math.pow(1000, clamp(m.atk, 0, 1));
const envDecay = (m) => 0.01 * Math.pow(200, clamp(m.dec, 0, 1));
function envAt(m, t) {
  const a = envAttack(m), d = envDecay(m);
  if (t <= 0) return 0;
  if (t < a) return t / a;
  return Math.pow(Math.max(0, 1 - (t - a) / d), 2);
}
/* how an envelope reads, for drawing: a slow attack swells like a flare, a
   fast one strikes like an impact, and a fast one with a long tail blows
   out like a supernova */
function envLook(m) {
  if (envAttack(m) > 0.06) return 'flare';
  return envDecay(m) > 0.5 ? 'supernova' : 'impact';
}
/* free: the LFO runs on its own clock in Hz (0.05..20, log), even with the
   transport stopped; synced, it runs at MOD_RATES in beats of the song.
   uni: unipolar, 0..1 instead of -1..1 (envelopes are always 0..1). */
function freshMod() {
  return { shape: 'sine', rate: 2, free: false, hz: 0.45, uni: false, depth: 0.5, ctl: 0.5, phase: 0, atk: 0.2, dec: 0.45, dest: 'pitch', targets: [] };
}
const modHz = (m) => 0.05 * Math.pow(400, clamp(m.hz == null ? 0.45 : m.hz, 0, 1));
/* the LFO's phase in cycles, from the song position in beats or (free)
   seconds of the audio clock */
const modCycles = (m, beats, secs) => (m.free ? secs * modHz(m) : beats / MOD_RATES[clamp(m.rate, 0, MOD_RATES.length - 1)].beats) + m.phase;
/* its output, -1..1 (or 0..1 unipolar) */
function modLfo(m, beats, secs) {
  const x = lfoAt(m.shape, modCycles(m, beats, secs || 0), m.ctl).x;
  return m.uni ? (x + 1) / 2 : x;
}

/* destinations: the hit's position on the map, pitch and decay across every
   layer, or any one engine control */
const MOD_DESTS = [
  { id: 'x', name: 'X position', group: 'Position' }, { id: 'y', name: 'Y position', group: 'Position' },
  { id: 'pitch', name: 'Pitch', group: 'Whole voice' }, { id: 'decay', name: 'Decay', group: 'Whole voice' },
  // engine controls carry their layer's name: there's a body decay and a noise decay
  ...PARAM_SPECS.map((p) => {
    const layer = MODULES.find((m) => m.id === p.mod).label;
    const low = /^[A-Z]{2}/.test(p.label) ? p.label : p.label.toLowerCase(); // keep "FM"
    const name = p.key === 'lvl' ? 'Output level' : p.key === 'q' ? 'Filter resonance' : p.mod === 'out' || p.mod === 'filter' ? p.label : `${layer} ${low}`;
    return { id: p.key, name, group: layer };
  }),
  // transport, last: global, so a modulator sent here needs no targets (LFOs only)
  { id: 'bpm', name: 'Tempo', group: 'Transport', global: true }, { id: 'swing', name: 'Swing', group: 'Transport', global: true },
];
const GLOBAL_DESTS = new Set(MOD_DESTS.filter((d) => d.global).map((d) => d.id));
/* transport destinations: tempo moves by up to x1.5 either way, swing by
   up to 25 points (it stays within 50..75) */
const modTempo = (bpm, amt) => clamp(bpm * Math.pow(1.5, amt), 30, 300);
const modSwing = (sw, amt) => clamp(sw + amt * 25, 50, 75);
function modulatePos(pos, dest, amt) {
  if (dest === 'x') return { x: clamp(pos.x + amt * 0.5, 0, 1), y: pos.y };
  if (dest === 'y') return { x: pos.x, y: clamp(pos.y + amt * 0.5, 0, 1) };
  return pos;
}
function modulateParams(P, dest, amt) {
  if (!amt || dest === 'x' || dest === 'y') return P;
  const Q = Object.assign({}, P);
  if (dest === 'pitch') { const k = Math.pow(2, amt); Q.f *= k; Q.resF *= k; Q.mPitch *= k; return Q; }
  if (dest === 'decay') { const k = Math.pow(4, amt); Q.tDec *= k; Q.nDec *= k; Q.mDec *= k; Q.resDec *= k; return Q; }
  const sp = PARAM_BY_KEY[dest];
  if (!sp) return P;
  // half the knob's travel either way at full depth, in the knob's own scale
  Q[dest] = sp.log && sp.min > 0
    ? clamp(P[dest] * Math.pow(sp.max / sp.min, amt * 0.5), sp.min, sp.max)
    : clamp(P[dest] + amt * (sp.max - sp.min) * 0.5, sp.min, sp.max);
  return Q;
}
/* does a target cover this hit? step: that step; drum: hits whose nearest
   anchor is that drum; kit: every hit */
function modCovers(m, stepIndex, anchor) {
  if (GLOBAL_DESTS.has(m.dest)) return false; // the transport, not hits
  return m.targets.some((g) => g.kind === 'kit' || (g.kind === 'step' && g.i === stepIndex) || (g.kind === 'drum' && g.a === anchor));
}
/* toggle a target in or out of a modulator's list */
function toggleTarget(m, g) {
  const same = (h) => h.kind === g.kind && h.i === g.i && h.a === g.a;
  const k = m.targets.findIndex(same);
  if (k >= 0) m.targets.splice(k, 1); else m.targets.push(g);
  return k < 0;
}
const nearestAnchor = (x, y) => { const w = weightsAt(x, y); return w.indexOf(Math.max(...w)); };

/* ==========================================================================
   Randomizing. rng() is 0..1 (Math.random, or seeded in tests).
   ========================================================================== */
/* bounce off the edges instead of piling up against them */
const reflect01 = (v) => { v = ((v % 2) + 2) % 2; return v > 1 ? 2 - v : v; };
const MAX_NEW_RATCHETS = 6;
/* randomizeSteps: an empty pattern gets 5..16 new steps (more with
   strength); an existing one has its stars moved, and from halfway up
   steps may be added (often) or removed (less often), and ratchets added
   or removed, never more than MAX_NEW_RATCHETS newly ratcheted steps */
function randomizeSteps(steps, strength, rng) {
  rng = rng || Math.random;
  const s01 = clamp(strength, 0, 1), pick = (a) => a[Math.floor(rng() * a.length)];
  const hitsChoices = RATCHET_VALUES.slice(1).map(ratchetHits);
  const place = (s) => { s.on = true; s.set = true; s.x = 0.04 + rng() * 0.92; s.y = 0.04 + rng() * 0.92; };
  let newRatchets = 0;
  const maybeRatchet = (s, chance) => {
    if (newRatchets < MAX_NEW_RATCHETS && rng() < chance) { s.ratchets = evenRatchets(s.x, s.y, pick(hitsChoices)); newRatchets++; }
  };
  const on = steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);
  if (!on.length) {
    const n = Math.round(5 + s01 * 11), free = steps.map((_, i) => i);
    for (let k = 0; k < n; k++) {
      const i = free.splice(Math.floor(rng() * free.length), 1)[0];
      steps[i] = freshStep(); place(steps[i]);
      maybeRatchet(steps[i], s01 >= 0.5 ? (s01 - 0.4) * 0.3 : 0);
    }
    return steps;
  }
  const reach = s01 * 0.6;
  for (const i of on) {
    const s = steps[i], nx = reflect01(s.x + (rng() * 2 - 1) * reach), ny = reflect01(s.y + (rng() * 2 - 1) * reach), dx = nx - s.x, dy = ny - s.y;
    s.x = nx; s.y = ny;
    if (s.auto) s.auto = s.auto.map((q) => ({ x: reflect01(q.x + dx), y: reflect01(q.y + dy) }));
    for (const r of s.ratchets) { r.x = reflect01(r.x + dx); r.y = reflect01(r.y + dy); }
  }
  if (s01 > 0.5) {
    const over = (s01 - 0.5) * 2; // 0..1 over the top half
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].on && rng() < 0.12 + 0.3 * over) { steps[i] = freshStep(); place(steps[i]); }
    }
    let left = steps.filter((s) => s.on).length;
    for (const i of on) if (left > 1 && rng() < 0.06 + 0.16 * over) { steps[i] = freshStep(); left--; }
  }
  if (s01 >= 0.45) {
    const r = (s01 - 0.4) / 0.6; // 0.1..1
    for (const s of steps) {
      if (!s.on) continue;
      if (s.ratchets.length) { if (rng() < 0.35 * r) s.ratchets = []; }
      else maybeRatchet(s, 0.2 * r);
    }
  }
  return steps;
}
/* jitterParams: one drum's engine controls. Pitches and times move in
   ratio (log), the rest linearly; drive and fold lean low, since a little
   of either takes over a sound quickly */
function jitterParams(p, strength, rng) {
  rng = rng || Math.random;
  const s01 = clamp(strength, 0, 1);
  for (const spec of PARAM_SPECS) {
    const v = p[spec.key];
    if (spec.key === 'drive' || spec.key === 'fold') {
      const target = Math.pow(rng(), 3) * (spec.key === 'fold' ? 0.6 : 0.7);
      p[spec.key] = clamp(v + (target - v) * s01 * 0.8, spec.min, spec.max);
    } else if (spec.log && spec.min > 0) {
      p[spec.key] = clamp(v * Math.pow(spec.max / spec.min, (rng() * 2 - 1) * s01 * 0.3), spec.min, spec.max);
    } else {
      p[spec.key] = clamp(v + (rng() * 2 - 1) * s01 * (spec.max - spec.min) * 0.5, spec.min, spec.max);
    }
  }
  return p;
}

/* play modes: which step plays at position n of the run (n counts every
   step since play) */
const PLAY_MODES = [
  { id: 'fwd', name: 'Forward' }, { id: 'back', name: 'Backward' },
  { id: 'pingpong', name: 'Ping-pong' }, { id: 'random', name: 'Random' },
];
function stepAt(mode, n, rng) {
  const L = N_STEPS;
  if (mode === 'back') return L - 1 - (n % L);
  if (mode === 'pingpong') { const m = n % (2 * L - 2); return m < L ? m : 2 * L - 2 - m; }
  if (mode === 'random') return Math.floor((rng || Math.random)() * L);
  return n % L;
}

/* ==========================================================================
   Export files: 16-bit WAV, and a zip that stores (doesn't compress) them.
   ========================================================================== */
function encodeWav(samples, sampleRate) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(clamp(samples[i], -1, 1) * 32767), true);
  return new Uint8Array(buf);
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
/* files: [{name, data: Uint8Array}] -> one zip (method 0, stored) */
function zipStore(files) {
  const enc = (t) => Array.from(unescape(encodeURIComponent(t)), (ch) => ch.charCodeAt(0));
  const parts = [], central = [];
  let off = 0;
  const u16 = (a, v) => a.push(v & 255, (v >>> 8) & 255), u32 = (a, v) => a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  for (const f of files) {
    const name = enc(f.name), crc = crc32(f.data), h = [];
    u32(h, 0x04034b50); u16(h, 20); u16(h, 0x0800); u16(h, 0); u16(h, 0); u16(h, 0x21);
    u32(h, crc); u32(h, f.data.length); u32(h, f.data.length); u16(h, name.length); u16(h, 0); h.push(...name);
    parts.push(new Uint8Array(h), f.data);
    const c = [];
    u32(c, 0x02014b50); u16(c, 20); u16(c, 20); u16(c, 0x0800); u16(c, 0); u16(c, 0); u16(c, 0x21);
    u32(c, crc); u32(c, f.data.length); u32(c, f.data.length); u16(c, name.length); u16(c, 0); u16(c, 0); u16(c, 0); u16(c, 0); u32(c, 0); u32(c, off);
    c.push(...name); central.push(new Uint8Array(c));
    off += h.length + f.data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0), e = [];
  u32(e, 0x06054b50); u16(e, 0); u16(e, 0); u16(e, files.length); u16(e, files.length); u32(e, cdSize); u32(e, off); u16(e, 0);
  const all = [...parts, ...central, new Uint8Array(e)], out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

const DEMO_BEAT = [
  [0, 0.12, 0.10], [2, 0.70, 0.86], [3, 0.31, 0.87], [4, 0.45, 0.42],
  [6, 0.70, 0.86], [7, 0.86, 0.72], [8, 0.12, 0.10], [10, 0.70, 0.86],
  [11, 0.16, 0.14], [12, 0.55, 0.36], [13, 0.13, 0.72], [14, 0.70, 0.86],
  [15, 0.14, 0.34],
];



// --- Node export (stripped by build.py) ---
if (typeof module !== "undefined") module.exports = {
  N_STEPS, SIGMA, clamp, BASE, ANCHOR_DEFS, ANCHORS, weightsAt, LOG_KEYS, GROUPS, paramsAt,
  colorAt, decayMultiplier, nearest, voiceSignature, METAL_RATIOS, BURST_GAP, SHAPER_CURVE,
  foldCurve, modeRatios, modeQ, playVoice, mixedParams, autoAt, AUTO_POINTS, Engine,
  PARAM_SPECS, PARAM_BY_KEY, MOD_COUNT, MOD_RATES, MOD_SHAPES, SHAPE_BY_ID, MOD_DESTS, lfoAt, envAt, envAttack, envDecay, envLook,
  freshMod, modLfo, modHz, modCycles, GLOBAL_DESTS, modTempo, modSwing, foldMix, GLIDE_FOLD,
  encodeWav, crc32, zipStore, reflect01, randomizeSteps, MAX_NEW_RATCHETS, jitterParams, PLAY_MODES, stepAt, evenRatchets, modulatePos, modulateParams, modCovers, toggleTarget, nearestAnchor, kepler,
  LANE_DEFAULTS, freshStep, RATCHET_VALUES, ratchetHits, RATCHET_CATCH, slotDuration, catchStep, swingOffset, Sequence, DEMO_BEAT,
};
