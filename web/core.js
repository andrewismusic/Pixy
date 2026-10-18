
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

function playVoice(ctx, out, noiseBuf, P, trims, t, extraDecay) {
  const tune = Math.pow(2, trims.tune / 12);
  const dm = trims.decay * (extraDecay == null ? 1 : extraDecay);
  const drive = clamp(P.drive + trims.drive, 0, 1);
  const fold = clamp((P.fold || 0) + (trims.fold || 0), 0, 1);
  // kit-wide macro mixes: blend the whole kit's character without touching
  // any single drum's own tuning. 1 = unchanged.
  const toneMix = trims.toneMix == null ? 1 : trims.toneMix;
  const noiseMix = trims.noiseMix == null ? 1 : trims.noiseMix;
  const metalMix = trims.metalMix == null ? 1 : trims.metalMix;
  const punch = trims.punch == null ? 1 : trims.punch;
  const resMix = trims.resMix == null ? 1 : trims.resMix;
  P = Object.assign({}, BASE, P, {
    tone: clamp(P.tone * toneMix, 0, 2),
    noise: clamp(P.noise * noiseMix, 0, 2),
    metal: clamp(P.metal * metalMix, 0, 2),
    res: clamp((P.res || 0) * resMix, 0, 2),
    atk: Math.max(0.0002, P.atk * punch),
  });

  const pre = ctx.createGain(); pre.gain.value = 1 + drive * 5;
  const shp = ctx.createWaveShaper(); shp.curve = SHAPER_CURVE;
  const post = ctx.createGain(); post.gain.value = P.lvl * 0.9 / (1 + drive * 0.8);
  pre.connect(shp); shp.connect(post); post.connect(out);
  // every layer feeds `bus`: straight into the drive stage, or through the
  // wavefolder first when there's any fold
  let bus = pre;
  if (fold > 0.01) {
    // more fold also drives the folder harder, so it keeps biting into the tail
    bus = ctx.createGain(); bus.gain.value = 0.8 + fold * 2.4;
    const fs = ctx.createWaveShaper(); fs.curve = foldCurve(fold); fs.oversample = '2x';
    bus.connect(fs); fs.connect(pre);
  }

  let end = t;
  const stopAt = (node, time) => { node.stop(time); if (time > end) end = time; };

  if (P.tone > 0.02) {
    const f = P.f * tune, fs = f * Math.pow(2, P.pEnv), tau = Math.max(0.003, P.pDec / 3);
    const dur = P.tDec * dm;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(fs, t);
    osc.frequency.setTargetAtTime(f, t, tau);
    const g = ctx.createGain();
    ampEnv(g.gain, t, P.atk, P.tone, dur);
    if (P.fm > 0.02) {
      const mod = ctx.createOscillator(); mod.type = 'sine';
      mod.frequency.setValueAtTime(fs * P.fmRatio, t);
      mod.frequency.setTargetAtTime(f * P.fmRatio, t, tau);
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(P.fm * f * 4, t);
      mg.gain.setTargetAtTime(0, t, Math.max(0.008, dur * 0.25));
      mod.connect(mg); mg.connect(osc.frequency);
      mod.start(t); stopAt(mod, t + P.atk + dur + 0.05);
    }
    osc.connect(g); g.connect(bus);
    osc.start(t); stopAt(osc, t + P.atk + dur + 0.05);
  }

  const wantN = P.noise > 0.02, wantM = P.metal > 0.02;
  if (wantN || wantM) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
    hp.frequency.value = P.hp; hp.Q.value = -3;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = Math.min(Math.max(P.lp, P.hp * 1.2), ctx.sampleRate * 0.45);
    lp.Q.value = P.q;
    hp.connect(lp); lp.connect(bus);

    if (wantN) {
      const dur = P.nDec * dm;
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const ng = ctx.createGain();
      const lead = noiseEnv(ng.gain, t, P.atk, P.noise, dur, P.burst);
      src.connect(ng); ng.connect(hp);
      src.start(t, Math.random() * (noiseBuf.duration - 0.2));
      stopAt(src, t + lead + P.atk + dur + 0.05);
    }
    if (wantM) {
      const dur = P.mDec * dm;
      const mg = ctx.createGain();
      ampEnv(mg.gain, t, P.atk, P.metal * 0.35, dur);
      for (const r of METAL_RATIOS) {
        const o = ctx.createOscillator(); o.type = 'square';
        o.frequency.value = r * P.mPitch * tune;
        o.connect(mg);
        o.start(t); stopAt(o, t + P.atk + dur + 0.05);
      }
      mg.connect(hp);
    }
  }

  if (P.res > 0.02) {
    const sr = ctx.sampleRate, t60 = Math.min(4, P.resDec * dm);
    const src = ctx.createBufferSource(); src.buffer = clickBuf(ctx);
    const rg = ctx.createGain(); rg.gain.value = P.res * 0.45;
    rg.connect(bus);
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
    });
    src.start(t + P.atk);
    stopAt(src, t + P.atk + t60 + 0.02);
  }
  return end;
}

class Engine {
  constructor(ctx) {
    this.ctx = ctx;
    this.trims = { tune: 0, decay: 1, drive: 0 };
    this.noise = makeNoise(ctx);
    this.voices = [];
    this.mono = false;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.12;
    this.master.connect(comp); comp.connect(ctx.destination);
  }
  trigger(P, t, extraDecay) {
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
      for (const v of this.voices) {
        if (v.end > t) {
          try { v.out.gain.cancelScheduledValues(t); } catch (_) {}
          v.out.gain.setTargetAtTime(0, t, 0.006);
        }
      }
      this.voices = [];
    }
    while (this.voices.length >= 14) {
      const old = this.voices.shift();
      old.out.gain.setTargetAtTime(0, now, 0.01);
    }
    const out = ctx.createGain();
    out.connect(this.master);
    const end = playVoice(ctx, out, this.noise, P, this.trims, t, extraDecay);
    this.voices.push({ out, end });
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
        dst.x = src.x; dst.y = src.y; dst.on = true; dst.set = true;
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
    this.onChange();
  }
  /* setRatchetHits: the ratchet bar recorded on its own, re-cutting an
     existing step into `hits` even hits at its own sound */
  setRatchetHits(i, hits) {
    const s = this.steps[i];
    if (!s.on) return;
    s.ratchets = evenRatchets(s.x, s.y, hits);
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
  foldCurve, modeRatios, modeQ, playVoice, Engine,
  LANE_DEFAULTS, freshStep, RATCHET_VALUES, ratchetHits, RATCHET_CATCH, slotDuration, catchStep, swingOffset, Sequence, DEMO_BEAT,
};
