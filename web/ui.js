
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const pad = $('#pad'), pg = pad.getContext('2d');
  const laneCanvas = $('#laneCanvas'), lg = laneCanvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const mixc = (a, b, t) => [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
  const rgbs = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  /* knob geometry (see createKnob) */
  const KNOB_SWEEP = 270, KNOB_R = 22, KNOB_C = 26;
  function arcPath(a0, a1) {
    // angles in degrees, 0 = 12 o'clock, clockwise
    const pt = (a) => [KNOB_C + KNOB_R * Math.sin(a * Math.PI / 180), KNOB_C - KNOB_R * Math.cos(a * Math.PI / 180)];
    if (Math.abs(a1 - a0) < 0.5) a1 = a0 + 0.5;
    const [x0, y0] = pt(Math.min(a0, a1)), [x1, y1] = pt(Math.max(a0, a1));
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${KNOB_R} ${KNOB_R} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  /* ---------- state ---------- */
  let actx = null, engine = null;
  let dpr = 1;
  let dirty = true, stepsDirty = true, readoutDirty = true, headDirty = false, laneDirty = true;
  let tempo = 118, swing = 0;
  const trims = { tune: 0, decay: 1, drive: 0, fold: 0, toneMix: 1, noiseMix: 1, metalMix: 1, resMix: 1, punch: 1 };
  let cur = -1;
  let lastAud = { t: 0, x: 0, y: 0 };
  let lastT = 0;

  const seq = new Sequence(
    () => { dirty = stepsDirty = readoutDirty = laneDirty = true; },
    (x, y, kind) => audition(x, y, kind)
  );
  seq.load(DEMO_BEAT);

  /* ---------- audio ---------- */
  function ensureAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC({ latencyHint: 'interactive' });
      engine = new Engine(actx);
      engine.trims = trims;
      engine.mono = pendingMono;
    }
    if (actx.state === 'suspended') actx.resume();
  }

  /* plays a point and returns the parameters that made the sound, so the
     caller can also drive the matching visual burst from the same values.
     extraDecay (optional) scales this one hit's decay, on top of the
     global decay trim — used by the sequencer's per-step decay lane. */
  function playAt(x, y, t, extraDecay) {
    const P = paramsAt(x, y);
    if (engine) engine.trigger(P, t, extraDecay);
    return P;
  }

  /* quantize: governs both live pad-drag retriggering and recording
     resolution. 16 is the sequencer's native grid; finer values let you
     overdub ratchets (sub-hits within a single step box) while recording,
     and can be changed on the fly, including mid-recording, since the
     grid is recomputed fresh from the current tempo/anchor every time. */
  let quantizeN = 16;
  function setQuantize(n) {
    if (!QUANT_VALUES.includes(n)) return;
    quantizeN = n;
    if (padHoldTimer) startPadHold(); // re-arm at the new rate immediately, mid-gesture
  }

  /* the 16th-note grid anchor the live quantizer snaps against: while
     playing, phase-locked to the running scheduler (nextBase/stepIdx);
     otherwise a free-running grid from time zero is just as good, since
     there's no transport to lock to. */
  function gridAnchor() {
    const dur = 60 / tempo / 4;
    return { stepDur: dur, barStart: playing ? nextBase - stepIdx * dur : 0 };
  }

  /* a ratchet group must START on the 16th-note grid (a sequencer step),
     even though the finger that opened it landed slightly early or late;
     the whole group's timeline is anchored there, truncating or extending
     it by at most half a 16th so it always begins on-step. Later hits in
     the same held gesture are then quantized to the fine grid relative to
     that corrected anchor, not to raw touch time. */
  let recordGesture = null; // {stepIndex, anchorTime} while a recording gesture is open
  function recordQuantizedHit(x, y) {
    const dur16 = 60 / tempo / 4;
    const now = actx.currentTime;
    if (!recordGesture) {
      const { barStart } = gridAnchor();
      const snap16 = quantizedSlot(now, barStart, dur16, tempo, 16);
      recordGesture = { stepIndex: snap16.stepIndex, anchorTime: snap16.time };
      seq.liveWriteSlot(recordGesture.stepIndex, 0, x, y);
      return;
    }
    // never let a quick hit land "before" the corrected anchor: the start
    // was just truncated/extended forward onto the grid, so a touch that's
    // still earlier in real time than that anchor belongs right at it, not
    // wrapped back into the previous step.
    const safeNow = Math.max(now, recordGesture.anchorTime);
    const slot = quantizedSlot(safeNow, recordGesture.anchorTime, dur16, tempo, quantizeN);
    const absStep = (recordGesture.stepIndex + slot.stepIndex) % N_STEPS;
    seq.liveWriteSlot(absStep, slot.offset, x, y);
  }

  /* while the pad is held, trigger (and, if recording, write) at the
     quantize slider's rate, using whatever point the finger is on right
     now -- this covers both "moving across the pad" and "holding still",
     and works whether or not the sequence is playing. */
  let padHoldTimer = null;
  function triggerLive() {
    const { x, y } = seq.cursor;
    const P = playAt(x, y);
    spawnBurst(x, y, P, performance.now());
    if (recording && playing) recordQuantizedHit(x, y);
  }
  function startPadHold() {
    stopPadHold();
    padHoldTimer = setInterval(triggerLive, Math.max(30, slotDuration(tempo, quantizeN) * 1000));
  }
  function stopPadHold() {
    if (padHoldTimer) { clearInterval(padHoldTimer); padHoldTimer = null; }
    recordGesture = null;
  }

  function audition(x, y, kind) {
    const now = performance.now();
    ensureAudio();
    lastAud = { t: now, x, y };
    if (kind === 'move') return; // the pad-hold timer handles quantized retriggering while held
    if (kind === 'press') {
      stopPadHold();
      if (recording && playing) recordQuantizedHit(x, y);
      startPadHold();
    }
    const P = playAt(x, y);
    spawnBurst(x, y, P, now);
  }

  /* ---------- sequencer clock ---------- */
  let timer = null, nextBase = 0, stepIdx = 0, queue = [], playing = false, recording = false;

  function tick() {
    const dur = 60 / tempo / 4;
    while (nextBase < actx.currentTime + 0.12) {
      const i = stepIdx;
      const t = nextBase + (i % 2 === 1 ? swing * dur / 3 : 0);
      const r = seq.trial(i);
      const fired = r.fired, decMult = r.decMult;
      let P = null;
      if (fired) {
        P = playAt(r.x, r.y, t, decMult);
        const s = seq.steps[i];
        if (Array.isArray(s.ratchets) && s.ratchets.length) {
          for (const rr of s.ratchets) {
            const rt = t + rr.offset * dur;
            const rP = playAt(rr.x, rr.y, rt, decMult);
            queue.push({ i, t: rt, fired: true, x: rr.x, y: rr.y, P: rP, ratchet: true });
          }
        }
      }
      queue.push({ i, t, fired, x: r.x, y: r.y, P });
      nextBase += dur;
      stepIdx = (stepIdx + 1) % N_STEPS;
    }
  }

  function setPlaying(on) {
    const btn = $('#play');
    if (on === playing) return;
    if (on) {
      ensureAudio();
      stepIdx = 0; queue = [];
      nextBase = actx.currentTime + 0.06;
      tick();
      timer = setInterval(tick, 25);
    } else {
      clearInterval(timer); timer = null; queue = []; cur = -1; headDirty = true;
    }
    playing = on;
    btn.setAttribute('aria-label', on ? 'Stop' : 'Play');
    btn.title = on ? 'Stop' : 'Play';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setRecording(on) {
    recording = on;
    const btn = $('#record');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /* ==========================================================================
     Particle feedback: every hit spawns a small cluster whose colour, size,
     speed and behaviour come entirely from that hit's own synth parameters
     (via voiceSignature), not from any label. A sound that's mostly body
     tone reads as droplets; mostly noise reads as smoke; mostly metal reads
     as sparks. A sound can be any blend of the three at once.
     ========================================================================== */
  let particles = [];
  const PARTICLE_CAP = 260;

  const SPREAD = 2.6;     // particle speed multiplier: hits spread well past the finger
  const FINGER = 0.045;  // particles start this far out (pad units), clear of the fingertip
  function spawnBurst(x, y, P, now) {
    const sig = voiceSignature(P);
    const n = Math.round(8 + sig.level * 26);
    const nLiquid = Math.round(n * sig.tW);
    const nSmoke = Math.round(n * sig.nW);
    const nSpark = sig.mW > 0.04 ? Math.max(3, Math.round(n * sig.mW * 1.3)) : 0;
    for (let k = 0; k < nLiquid; k++) particles.push(makeLiquid(x, y, sig, now));
    for (let k = 0; k < nSmoke; k++) particles.push(makeSmoke(x, y, sig, now));
    for (let k = 0; k < nSpark; k++) particles.push(makeSpark(x, y, sig, now));
    particles.push(makeRing(x, y, sig, now));
    if (particles.length > PARTICLE_CAP) particles.splice(0, particles.length - PARTICLE_CAP);
    dirty = true;
  }

  function makeLiquid(x, y, sig, now) {
    const ang = Math.random() * Math.PI * 2;
    const spd = SPREAD * (0.11 + sig.t * 0.16) * (0.55 + Math.random() * 0.8) * (0.55 + sig.level * 0.65);
    x += Math.cos(ang) * FINGER; y += Math.sin(ang) * FINGER * 0.5;
    return {
      kind: 'liquid', x, y, px: x, py: y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd * 0.5,
      r: (0.011 + 0.018 * sig.level) * (1.25 - sig.t * 0.7) * (0.7 + Math.random() * 0.6),
      born: now, life: reduceMotion ? 140 : clamp(sig.dec * 1000 * 1.1, 200, 950),
      rgb: sig.rgb, drive: sig.drive,
    };
  }
  function updateLiquid(p, dt) {
    p.px = p.x; p.py = p.y;
    p.vy -= 0.22 * dt;
    p.vx *= Math.pow(0.93, dt * 60);
    if (p.drive > 0.1) { p.vx += (Math.random() - 0.5) * p.drive * 0.02; p.vy += (Math.random() - 0.5) * p.drive * 0.02; }
    p.x += p.vx * dt; p.y += p.vy * dt;
  }
  function drawLiquid(pg, p, age, px, py, u) {
    const a = Math.pow(1 - age, 0.75) * 0.85;
    const scale = Math.min(px(1) - px(0), 1e9);
    const r = p.r * (1 - 0.25 * age) * scale;
    // a short flat streak rather than a soft blob, so motion reads without any blur
    pg.strokeStyle = rgbs(p.rgb, a * 0.55);
    pg.lineWidth = Math.max(1 * u, r * 1.3);
    pg.beginPath(); pg.moveTo(px(p.px), py(p.py)); pg.lineTo(px(p.x), py(p.y)); pg.stroke();
    pg.fillStyle = rgbs(p.rgb, a);
    pg.beginPath(); pg.arc(px(p.x), py(p.y), r, 0, 6.283); pg.fill();
  }

  function makeSmoke(x, y, sig, now) {
    const ang = Math.random() * Math.PI * 2;
    const spd = SPREAD * (0.045 + Math.random() * 0.1) * (0.6 + sig.level * 0.6);
    x += Math.cos(ang) * FINGER; y += Math.abs(Math.sin(ang)) * FINGER;
    return {
      kind: 'smoke', x, y, vx: Math.cos(ang) * spd, vy: Math.abs(Math.sin(ang)) * spd * 0.55 + 0.02,
      r: (0.006 + 0.01 * sig.level) * (1.2 - sig.t * 0.4) * (0.7 + Math.random() * 0.6),
      born: now, life: reduceMotion ? 140 : clamp(sig.dec * 1000 * 1.5, 280, 1500),
      rgb: mixc(sig.rgb, [180, 182, 196], 0.35), drive: sig.drive,
    };
  }
  function updateSmoke(p, dt) {
    p.vx += (Math.random() - 0.5) * (0.02 + p.drive * 0.04) * dt * 60;
    p.vy *= Math.pow(0.996, dt * 60);
    p.x += p.vx * dt; p.y += p.vy * dt;
  }
  function drawSmoke(pg, p, age, px, py, u) {
    // many small flat specks scattering outward reads as dust, not a blurred cloud
    const a = Math.pow(1 - age, 1.1) * 0.55;
    const scale = Math.min(px(1) - px(0), 1e9);
    const r = p.r * (0.8 + 0.5 * age) * scale;
    pg.fillStyle = rgbs(p.rgb, a);
    pg.beginPath(); pg.arc(px(p.x), py(p.y), r, 0, 6.283); pg.fill();
  }

  function makeSpark(x, y, sig, now) {
    const ang = Math.random() * Math.PI * 2;
    const spd = SPREAD * 0.85 * (0.22 + sig.t * 0.34) * (0.6 + Math.random() * 0.8) * (0.55 + sig.level * 0.75);
    x += Math.cos(ang) * FINGER; y += Math.sin(ang) * FINGER;
    return {
      kind: 'spark', x, y, px: x, py: y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      r: (0.0024 + 0.0042 * sig.level) * (1.15 - sig.t * 0.35),
      born: now, life: reduceMotion ? 100 : clamp(sig.dec * 1000 * 0.75 + 50, 80, 420),
      rgb: mixc(sig.rgb, [255, 255, 255], 0.5), drive: sig.drive,
    };
  }
  function updateSpark(p, dt) {
    p.px = p.x; p.py = p.y;
    const drag = Math.pow(0.86, dt * 60);
    p.vx *= drag; p.vy *= drag; p.vy -= 0.06 * dt;
    if (p.drive > 0.08) { p.vx += (Math.random() - 0.5) * p.drive * 0.35 * dt; p.vy += (Math.random() - 0.5) * p.drive * 0.35 * dt; }
    p.x += p.vx * dt; p.y += p.vy * dt;
  }
  function drawSpark(pg, p, age, px, py, u) {
    const a = Math.pow(1 - age, 1.3);
    const scale = Math.min(px(1) - px(0), 1e9);
    pg.strokeStyle = rgbs(p.rgb, a * 0.85);
    pg.lineWidth = Math.max(1 * u, p.r * scale * 1.4);
    pg.beginPath(); pg.moveTo(px(p.px), py(p.py)); pg.lineTo(px(p.x), py(p.y)); pg.stroke();
    pg.fillStyle = rgbs([255, 255, 255], a * 0.95);
    pg.beginPath(); pg.arc(px(p.x), py(p.y), p.r * scale * 0.85, 0, 6.283); pg.fill();
  }

  /* ring: a thin pulse whose reach follows the decay, sized to clear a
     fingertip (about a tenth of the pad) even for the shortest hits */
  function makeRing(x, y, sig, now) {
    return { kind: 'ring', x, y, born: now, life: reduceMotion ? 120 : clamp(sig.dec * 1000 * 1.4, 320, 1400), r: 0.16 + 0.2 * clamp(sig.dec, 0, 1), rgb: sig.rgb };
  }
  function drawRing(pg, p, age, px, py, u) {
    const scale = px(1) - px(0), e = 1 - Math.pow(1 - age, 3);
    pg.strokeStyle = rgbs(mixc(p.rgb, [255, 255, 255], 0.5), (1 - age) * 0.7);
    pg.lineWidth = (2.5 - 1.5 * age) * u;
    pg.beginPath(); pg.arc(px(p.x), py(p.y), (0.03 + p.r * e) * scale, 0, 6.283); pg.stroke();
  }
  const noop = () => {};

  const UPDATE = { liquid: updateLiquid, smoke: updateSmoke, spark: updateSpark, ring: noop };
  const DRAW = { liquid: drawLiquid, smoke: drawSmoke, spark: drawSpark, ring: drawRing };

  function stepParticles(dt, now) {
    if (!particles.length) return;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (now - p.born >= p.life) { particles.splice(i, 1); continue; }
      UPDATE[p.kind](p, dt);
    }
  }

  /* ---------- abstract backdrop: a dark field with a soft sound-coloured
     wash. No labels, no icons, no named regions, no grid. */
  let field = document.createElement('canvas');
  function buildField(W, H) {
    const FW = 96, FH = 96;
    const off = document.createElement('canvas'); off.width = FW; off.height = FH;
    const og = off.getContext('2d');
    const img = og.createImageData(FW, FH);
    const base = [8, 9, 18];
    for (let j = 0; j < FH; j++) {
      const y = 1 - (j + 0.5) / FH;
      for (let i = 0; i < FW; i++) {
        const x = (i + 0.5) / FW;
        const sig = voiceSignature(paramsAt(x, y));
        const t = 0.1 + 0.07 * sig.level;
        const p = (j * FW + i) * 4;
        img.data[p] = base[0] * (1 - t) + sig.rgb[0] * t;
        img.data[p + 1] = base[1] * (1 - t) + sig.rgb[1] * t;
        img.data[p + 2] = base[2] * (1 - t) + sig.rgb[2] * t;
        img.data[p + 3] = 255;
      }
    }
    og.putImageData(img, 0, 0);

    const f = document.createElement('canvas'); f.width = W; f.height = H;
    const fg = f.getContext('2d');
    fg.imageSmoothingEnabled = true; fg.imageSmoothingQuality = 'high';
    fg.drawImage(off, 0, 0, W, H);
    return f;
  }

  /* ---------- pad drawing ---------- */
  function resizePad() {
    const r = pad.getBoundingClientRect();
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    pad.width = Math.max(2, Math.round(r.width * dpr));
    pad.height = Math.max(2, Math.round(r.height * dpr));
    field = buildField(pad.width, pad.height);
    dirty = true;
  }

  function drawPad(now) {
    const W = pad.width, H = pad.height, u = dpr;
    const font = cssVar('--font-ui') || 'system-ui, sans-serif';
    const px = (x) => x * W, py = (y) => (1 - y) * H;
    pg.clearRect(0, 0, W, H);
    pg.drawImage(field, 0, 0, W, H);

    for (const p of particles) {
      // timer-spawned particles can be born a few ms after this frame's timestamp
      const age = Math.max(0, (now - p.born) / p.life);
      if (age >= 1) continue;
      DRAW[p.kind](pg, p, age, px, py, u);
    }

    // step markers: filled with that step's own sound colour, fanned out
    // when several steps share one spot, so the pad also works as memory.
    const groups = new Map();
    seq.steps.forEach((s, i) => {
      if (!s.on) return;
      const key = Math.round(s.x * 200) + ':' + Math.round(s.y * 200);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    pg.textAlign = 'center'; pg.textBaseline = 'middle';
    for (const list of groups.values()) {
      const s0 = seq.steps[list[0]];
      const bx = px(s0.x), by = py(s0.y);
      const spots = list.map((_, k) => {
        if (k === 0) return [bx, by];
        const ring = k <= 6 ? 1 : 2;
        const n = ring === 1 ? Math.min(list.length - 1, 6) : list.length - 7;
        const idx = ring === 1 ? k - 1 : k - 7;
        const ang = -Math.PI / 2 + idx * 2 * Math.PI / Math.max(n, 1);
        const rr = (ring === 1 ? 20 : 36) * u;
        return [bx + Math.cos(ang) * rr, by + Math.sin(ang) * rr];
      });
      if (list.length > 1) {
        pg.strokeStyle = 'rgba(255,255,255,.4)'; pg.lineWidth = 1.5 * u;
        pg.beginPath();
        spots.forEach((p, k) => { if (k) { pg.moveTo(bx, by); pg.lineTo(p[0], p[1]); } });
        pg.stroke();
      }
      list.forEach((i, k) => {
        const [cx, cy] = spots[k];
        const s = seq.steps[i];
        const sig = voiceSignature(paramsAt(s.x, s.y));
        const isHeld = seq.held.has(i) || seq.latched.has(i);
        const isNow = i === cur;
        const rad = (isNow ? 10.5 : 8.5) * u;
        if (isNow) {
          pg.strokeStyle = cssVar('--now') || '#0E9F8E'; pg.lineWidth = 3.5 * u;
          pg.beginPath(); pg.arc(cx, cy, rad + 3 * u, 0, 6.283); pg.stroke();
        }
        if (isHeld) {
          pg.strokeStyle = cssVar('--hold') || '#F0B400'; pg.lineWidth = 3 * u;
          pg.beginPath(); pg.arc(cx, cy, rad + 4 * u, 0, 6.283); pg.stroke();
        }
        pg.fillStyle = 'rgba(5,7,12,.85)';
        pg.beginPath(); pg.arc(cx, cy, rad + 1.8 * u, 0, 6.283); pg.fill();
        pg.fillStyle = `rgb(${sig.rgb[0] | 0},${sig.rgb[1] | 0},${sig.rgb[2] | 0})`;
        pg.beginPath(); pg.arc(cx, cy, rad, 0, 6.283); pg.fill();
        pg.fillStyle = lum(sig.rgb) > 0.52 ? '#11132a' : '#f4f3fb';
        pg.font = `700 ${9 * u}px ${font}`;
        pg.fillText(String(i + 1), cx, cy + 0.5 * u);
      });
    }

    // cursor: a plain white dot, deliberately unthemed so it always reads
    // as "you". Touching grows it and adds a thin ring.
    const c = seq.cursor, cx = px(c.x), cy = py(c.y);
    const held = seq.padHeld();
    if (held) {
      pg.strokeStyle = 'rgba(255,255,255,.55)'; pg.lineWidth = 1.5 * u;
      pg.beginPath(); pg.arc(cx, cy, 15 * u, 0, 6.283); pg.stroke();
    }
    pg.fillStyle = 'rgba(5,7,12,.85)';
    pg.beginPath(); pg.arc(cx, cy, (held ? 8.5 : 6.5) * u, 0, 6.283); pg.fill();
    pg.fillStyle = '#fff';
    pg.beginPath(); pg.arc(cx, cy, (held ? 6 : 4.5) * u, 0, 6.283); pg.fill();
  }

  /* ---------- pad input ---------- */
  function toXY(e) {
    const r = pad.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / r.width, 0, 1),
      y: clamp(1 - (e.clientY - r.top) / r.height, 0, 1),
    };
  }
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault(); ensureAudio();
    try { pad.setPointerCapture(e.pointerId); } catch (_) {}
    pad.focus({ preventScroll: true });
    const p = toXY(e);
    lastAud = { t: 0, x: p.x, y: p.y };
    seq.padPress(e.pointerId, p.x, p.y);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!seq.padDown.has(e.pointerId)) return;
    const p = toXY(e);
    seq.padMove(p.x, p.y);
  });
  const padUp = (e) => { seq.padRelease(e.pointerId); if (!seq.padHeld()) stopPadHold(); history.commit(); };
  pad.addEventListener('pointerup', padUp);
  pad.addEventListener('pointercancel', padUp);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  pad.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const c = seq.cursor;
    let nx = c.x, ny = c.y;
    if (e.key === 'ArrowLeft') nx -= step;
    else if (e.key === 'ArrowRight') nx += step;
    else if (e.key === 'ArrowUp') ny += step;
    else if (e.key === 'ArrowDown') ny -= step;
    else if (e.key === 'Enter') { e.preventDefault(); lastAud.t = 0; seq.padPress('kb', c.x, c.y); seq.padRelease('kb'); return; }
    else return;
    e.preventDefault();
    seq.padMove(clamp(nx, 0, 1), clamp(ny, 0, 1));
  });

  /* ---------- step tiles ---------- */
  const stepsEl = $('#steps');
  const cells = [], tiles = [];
  for (let g = 0; g < 4; g++) {
    const grp = document.createElement('div');
    grp.className = 'grp';
    for (let k = 0; k < 4; k++) {
      const i = g * 4 + k;
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.innerHTML = '<i class="led" aria-hidden="true"></i><button type="button" class="step"><span class="n"></span><span class="dot"></span></button>';
      const btn = cell.querySelector('button');
      btn.querySelector('.n').textContent = String(i + 1);
      // A click that follows a pointer gesture was already handled by pointerdown/up;
      // only clicks with no preceding pointer gesture come from the keyboard.
      let viaPointer = false, clearTimer = null;
      const endPointer = () => { clearTimeout(clearTimer); clearTimer = setTimeout(() => { viaPointer = false; }, 600); };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); ensureAudio();
        viaPointer = true; clearTimeout(clearTimer);
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        seq.stepDown(i);
      });
      btn.addEventListener('pointerup', () => { seq.stepUp(i); endPointer(); history.commit(); });
      btn.addEventListener('pointercancel', () => { seq.stepCancel(i); endPointer(); });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (viaPointer) { viaPointer = false; return; }
        ensureAudio(); seq.stepDown(i); seq.stepUp(i); // keyboard activation (Enter / Space)
      });
      grp.appendChild(cell);
      cells.push(cell); tiles.push(btn);
    }
    stepsEl.appendChild(grp);
  }

  function renderSteps() {
    tiles.forEach((el, i) => {
      const s = seq.steps[i];
      const held = seq.held.has(i) || seq.latched.has(i);
      el.classList.toggle('on', s.on);
      el.classList.toggle('held', held);
      el.setAttribute('aria-pressed', s.on ? 'true' : 'false');
      if (s.on) {
        const w = weightsAt(s.x, s.y);
        const sig = voiceSignature(paramsAt(s.x, s.y, w));
        const c = mixc(sig.rgb, [20, 23, 46], 0.08);
        el.style.setProperty('--c', `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`);
        el.style.setProperty('--tc', lum(c) > 0.42 ? '#11132a' : '#ffffff');
        el.style.setProperty('--dx', s.x.toFixed(3));
        el.style.setProperty('--dy', s.y.toFixed(3));
        el.setAttribute('aria-label', `Step ${i + 1}, on, ${nearest(w, 1)[0].name}, ${Math.round(s.prob * 100)} percent chance`);
      } else {
        el.setAttribute('aria-label', `Step ${i + 1}, off`);
      }
    });
    updateHead();
  }
  function updateHead() { cells.forEach((c, i) => c.classList.toggle('now', i === cur)); }

  /* ---------- formatting helpers (still used by the drum engine editor) ---------- */
  const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' kHz' : Math.round(v) + ' Hz');
  const fmtT = (s) => (s >= 1 ? s.toFixed(2) + ' s' : s < 0.01 ? (s * 1000).toFixed(1) + ' ms' : Math.round(s * 1000) + ' ms');

  /* ==========================================================================
     Drum engine editor: every named drum is a control point the rest of the
     map blends toward (see core.js), so editing one here reshapes that part
     of the map, not just a single fixed sound. Edits apply immediately and
     last for the session; Reset this drum restores its shipped tuning.
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
  function fmtParam(unit, v) {
    if (unit === 'hz') return fmtHz(v);
    if (unit === 's') return fmtT(v);
    if (unit === 'oct') return v.toFixed(2) + ' oct';
    if (unit === 'x') return '\u00d7' + v.toFixed(2);
    if (unit === 'q') return v.toFixed(1);
    if (unit === 'shape') return v < 0.2 ? 'string' : v < 0.4 ? 'tube' : v < 0.6 ? 'skin' : v < 0.8 ? 'plate' : 'bar';
    return Math.round(v * 100) + '%';
  }

  const ORIGINAL_PARAMS = ANCHORS.map((a) => Object.assign({}, a.p));
  const engineSelect = $('#engineSelect'), engineParams = $('#engineParams');
  ANCHORS.forEach((a, i) => {
    const opt = document.createElement('option');
    opt.value = String(i); opt.textContent = a.name;
    engineSelect.appendChild(opt);
  });
  let fieldRefreshTimer = null, engineAuditionTimer = null;
  function scheduleFieldRefresh() {
    clearTimeout(fieldRefreshTimer);
    fieldRefreshTimer = setTimeout(() => { field = buildField(pad.width, pad.height); dirty = true; }, 90);
  }
  function auditionAnchorSoon(a) {
    clearTimeout(engineAuditionTimer);
    engineAuditionTimer = setTimeout(() => {
      ensureAudio();
      const P = playAt(a.x, a.y);
      spawnBurst(a.x, a.y, P, performance.now());
    }, 60);
  }
  /* while a slider is being dragged and the sequence isn't playing,
     retrigger the drum at the quantize-slider's rate as a live preview of
     the sound change. */
  let sliderPreviewTimer = null;
  function startSliderPreview(a) {
    stopSliderPreview();
    ensureAudio();
    const fire = () => { const P = playAt(a.x, a.y); spawnBurst(a.x, a.y, P, performance.now()); };
    fire();
    sliderPreviewTimer = setInterval(fire, slotDuration(tempo, quantizeN) * 1000);
  }
  function stopSliderPreview() {
    if (sliderPreviewTimer) { clearInterval(sliderPreviewTimer); sliderPreviewTimer = null; }
  }
  const moduleGrids = {};
  for (const m of MODULES) {
    const el = document.createElement('div');
    el.className = 'module'; el.style.setProperty('--accent', `var(${m.accent})`);
    el.innerHTML = '<h3></h3><div class="knobgrid"></div>';
    el.querySelector('h3').textContent = m.label;
    engineParams.appendChild(el);
    moduleGrids[m.id] = el.querySelector('.knobgrid');
  }
  const paramRows = PARAM_SPECS.map((spec) => {
    const container = document.createElement('div');
    moduleGrids[spec.mod].appendChild(container);
    const slider = createKnob(container, {
      min: spec.min, max: spec.max, step: spec.step, value: BASE[spec.key], log: spec.log,
      def: () => ORIGINAL_PARAMS[+engineSelect.value][spec.key],
      label: spec.label, fmt: (v) => fmtParam(spec.unit, v),
      onInput: (v) => {
        const a = ANCHORS[+engineSelect.value];
        a.p[spec.key] = v;
        scheduleFieldRefresh();
        stepsDirty = readoutDirty = laneDirty = true;
        if (playing) auditionAnchorSoon(a);
      },
      onPointerDown: () => { if (!playing) startSliderPreview(ANCHORS[+engineSelect.value]); },
      onPointerUp: stopSliderPreview,
      onChange: () => history.commit(),
    });
    return { spec, slider };
  });
  function loadAnchorIntoEditor() {
    const a = ANCHORS[+engineSelect.value];
    paramRows.forEach(({ spec, slider }) => slider.set(a.p[spec.key]));
  }
  engineSelect.addEventListener('change', loadAnchorIntoEditor);
  $('#engineReset').addEventListener('click', () => {
    const idx = +engineSelect.value;
    ANCHORS[idx].p = Object.assign({}, ORIGINAL_PARAMS[idx]);
    loadAnchorIntoEditor();
    scheduleFieldRefresh();
    stepsDirty = readoutDirty = laneDirty = true;
    history.commit();
  });
  loadAnchorIntoEditor();

  /* ==========================================================================
     Step lanes: probability, and X/Y deviation (chance + amount), one row
     of 16 mini-bars per lane. Drag up and down within a step's column to
     set a value; drag sideways to paint several steps in one sweep.
     ========================================================================== */
  const LANES = {
    prob: { rows: [{ key: 'prob', label: 'chance it plays' }] },
    devx: { rows: [{ key: 'devXChance', label: 'chance of an X jump' }, { key: 'devXAmount', label: 'how far it can jump' }] },
    devy: { rows: [{ key: 'devYChance', label: 'chance of a Y jump' }, { key: 'devYAmount', label: 'how far it can jump' }] },
    decay: { rows: [{ key: 'decay', label: 'base decay' }, { key: 'decDevChance', label: 'chance of a decay jump' }, { key: 'decDevAmount', label: 'how far it can jump' }] },
  };
  const LANE_HINT = {
    prob: 'Drag a bar up or down to set how often that step fires.',
    devx: 'Top band: chance that step\u2019s X nudges off its spot. Bottom band: how far.',
    devy: 'Top band: chance that step\u2019s Y nudges off its spot. Bottom band: how far.',
    decay: 'Top: that step\u2019s own decay length (middle = unchanged). Middle: chance it jumps. Bottom: how far.',
  };
  let laneMode = 'prob';

  function resizeLaneCanvas() {
    const r = laneCanvas.getBoundingClientRect();
    const d = Math.min(2.5, window.devicePixelRatio || 1);
    laneCanvas.width = Math.max(2, Math.round(r.width * d));
    laneCanvas.height = Math.max(2, Math.round(r.height * d));
    laneDirty = true;
  }

  function drawLanes() {
    const W = laneCanvas.width, H = laneCanvas.height, u = laneCanvas.width / laneCanvas.getBoundingClientRect().width || 1;
    lg.clearRect(0, 0, W, H);
    const rows = LANES[laneMode].rows;
    const colW = W / N_STEPS;
    const rowH = H / rows.length;
    const gap = Math.max(2, colW * 0.14);

    for (let i = 0; i < N_STEPS; i++) {
      const s = seq.steps[i];
      const on = s.on;
      const sig = voiceSignature(paramsAt(s.x, s.y));
      const base = px2(i, colW);
      if (i === cur) {
        lg.fillStyle = 'rgba(43,232,255,.14)';
        lg.fillRect(base, 0, colW, H);
      }
      rows.forEach((row, ri) => {
        const top = ri * rowH, h = rowH - gap;
        const v = clamp(s[row.key], 0, 1);
        lg.fillStyle = on ? 'rgba(255,255,255,.09)' : 'rgba(255,255,255,.04)';
        lg.fillRect(base + gap / 2, top + gap / 2, colW - gap, h - gap / 2);
        const barH = Math.max(2 * u, v * (h - gap / 2));
        const rgb = on ? sig.rgb : [90, 92, 112];
        const barTop = top + (h - gap / 2) - barH + gap / 2;
        lg.fillStyle = rgbs(rgb, on ? 0.95 : 0.5);
        lg.fillRect(base + gap / 2, barTop, colW - gap, barH);
        lg.fillStyle = on ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.25)';
        lg.fillRect(base + gap / 2, barTop, colW - gap, Math.min(barH, 3 * u));
        // a neutral mark at the middle of the decay row shows "no change"
        if (row.key === 'decay') {
          lg.fillStyle = 'rgba(255,255,255,.4)';
          lg.fillRect(base + gap / 2, top + (h - gap / 2) * 0.5, colW - gap, Math.max(1, u));
        }
      });
    }
    // a divider between stacked bands, so the eye (and the thumb) can tell
    // them apart before a drag ever starts
    if (rows.length > 1) {
      lg.strokeStyle = 'rgba(255,255,255,.14)'; lg.lineWidth = Math.max(1, u);
      lg.beginPath();
      for (let ri = 1; ri < rows.length; ri++) { lg.moveTo(0, ri * rowH); lg.lineTo(W, ri * rowH); }
      lg.stroke();
    }
  }
  function px2(i, colW) { return i * colW; }

  // A drag locks onto the row (band) it started in, at pointerdown, and
  // keeps editing that same row even if the finger drifts into another
  // band's area — only sideways movement (which column) still tracks live.
  function laneColAndY(e) {
    const r = laneCanvas.getBoundingClientRect();
    return {
      relX: clamp((e.clientX - r.left) / r.width, 0, 0.999999),
      relY: clamp((e.clientY - r.top) / r.height, 0, 0.999999),
    };
  }
  function rowValue(relY, rowIndex, rowCount) {
    const top = rowIndex / rowCount, h = 1 / rowCount;
    return clamp(1 - (relY - top) / h, 0, 1);
  }
  let laneDrag = null;
  function showLaneReadout(col, label, value) {
    const el = $('#laneReadout');
    if (!el) return;
    el.textContent = `Step ${col + 1}, ${label}: ${formatLaneValue(laneDrag ? LANES[laneMode].rows[laneDrag.rowIndex].key : '', value)}`;
  }
  function formatLaneValue(key, value) {
    if (key === 'decay') return '\u00d7' + decayMultiplier(value).toFixed(2);
    return Math.round(value * 100) + '%';
  }
  laneCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { laneCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    const { relX, relY } = laneColAndY(e);
    const rows = LANES[laneMode].rows;
    const rowIndex = Math.min(rows.length - 1, Math.floor(relY * rows.length));
    const col = Math.min(N_STEPS - 1, Math.floor(relX * N_STEPS));
    laneDrag = { pointerId: e.pointerId, rowIndex };
    const value = rowValue(relY, rowIndex, rows.length);
    seq.setLane(col, rows[rowIndex].key, value);
    showLaneReadout(col, rows[rowIndex].label, value);
  });
  laneCanvas.addEventListener('pointermove', (e) => {
    if (!laneDrag || laneDrag.pointerId !== e.pointerId) return;
    const { relX, relY } = laneColAndY(e);
    const rows = LANES[laneMode].rows;
    const col = Math.min(N_STEPS - 1, Math.floor(relX * N_STEPS));
    const value = rowValue(relY, laneDrag.rowIndex, rows.length);
    seq.setLane(col, rows[laneDrag.rowIndex].key, value);
    showLaneReadout(col, rows[laneDrag.rowIndex].label, value);
  });
  const laneUp = (e) => { if (laneDrag && laneDrag.pointerId === e.pointerId) { laneDrag = null; history.commit(); } };
  laneCanvas.addEventListener('pointerup', laneUp);
  laneCanvas.addEventListener('pointercancel', laneUp);
  laneCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.querySelectorAll('.lanetabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lanetabs .tab').forEach((b) => b.setAttribute('aria-selected', 'false'));
      btn.setAttribute('aria-selected', 'true');
      laneMode = btn.dataset.lane;
      $('#laneHint').textContent = LANE_HINT[laneMode];
      $('#laneReadout').textContent = '\u00a0';
      laneDirty = true;
    });
  });
  $('#laneReset').addEventListener('click', () => {
    const map = {
      prob: ['prob'], devx: ['devXChance', 'devXAmount'], devy: ['devYChance', 'devYAmount'],
      decay: ['decay', 'decDevChance', 'decDevAmount'],
    };
    seq.resetLane(map[laneMode]);
  });
  $('#laneHint').textContent = LANE_HINT.prob;

  /* ---------- knob: drag up/right to turn up, down/left to turn down
     (Shift for fine), double-tap to reset, arrow keys to nudge. A 270
     degree arc shows the value; bipolar knobs fill from 12 o'clock. log
     knobs move evenly in ratio (pitches, times), not in Hz or seconds.
     Same API the old hslider had: { value, set(v) }. ---------- */
  function createKnob(container, opts) {
    container.innerHTML = '<div class="knob" tabindex="0" role="slider"><div class="knob-dial">' +
      '<svg viewBox="0 0 52 52" aria-hidden="true"><path class="trk"/><path class="val"/></svg>' +
      '<div class="knob-cap"></div></div><span class="knob-value"></span><span class="knob-label"></span></div>';
    const el = container.querySelector('.knob');
    const valPath = el.querySelector('.val'), valueEl = el.querySelector('.knob-value');
    el.querySelector('.trk').setAttribute('d', arcPath(-KNOB_SWEEP / 2, KNOB_SWEEP / 2));
    el.querySelector('.knob-label').textContent = opts.label;
    el.setAttribute('aria-label', opts.ariaLabel || opts.label);
    el.setAttribute('aria-valuemin', opts.min);
    el.setAttribute('aria-valuemax', opts.max);
    const step = opts.step || 1;
    const initial = opts.value;
    let value = opts.value;
    const useLog = !!opts.log && opts.min > 0;
    const toPos = (v) => useLog ? Math.log(v / opts.min) / Math.log(opts.max / opts.min) : (v - opts.min) / (opts.max - opts.min);
    const fromPos = (p) => useLog ? opts.min * Math.pow(opts.max / opts.min, p) : opts.min + p * (opts.max - opts.min);
    const snap = (v) => {
      const q = Math.round((v - opts.min) / step) * step + opts.min;
      return Math.min(opts.max, Math.max(opts.min, +q.toFixed(6)));
    };
    function render() {
      const pos = clamp(toPos(value), 0, 1);
      const ang = -KNOB_SWEEP / 2 + pos * KNOB_SWEEP;
      const from = opts.bipolar ? 0 : -KNOB_SWEEP / 2;
      valPath.setAttribute('d', arcPath(from, ang));
      valPath.style.opacity = !opts.bipolar && pos < 0.004 ? 0 : 1;
      el.style.setProperty('--rot', ang + 'deg');
      valueEl.textContent = opts.fmt ? opts.fmt(value) : String(value);
      el.setAttribute('aria-valuenow', value);
      el.setAttribute('aria-valuetext', valueEl.textContent);
    }
    const emit = () => { if (opts.onInput) opts.onInput(value); };
    let drag = null, lastTap = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      el.focus({ preventScroll: true });
      const t = performance.now();
      if (t - lastTap < 320) {
        // double-tap: back to the default (for drums, their shipped tuning)
        lastTap = 0;
        value = snap(typeof opts.def === 'function' ? opts.def() : (opts.def != null ? opts.def : initial));
        render(); emit();
        if (opts.onChange) opts.onChange(value);
        return;
      }
      lastTap = t;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pos: clamp(toPos(value), 0, 1) };
      el.classList.add('active');
      if (opts.onPointerDown) opts.onPointerDown(value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const travel = e.shiftKey ? 800 : 200;
      const p = clamp(drag.pos + ((e.clientX - drag.x) - (e.clientY - drag.y)) / travel, 0, 1);
      const v = snap(fromPos(p));
      if (v !== value) { value = v; render(); emit(); }
    });
    const end = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      drag = null; el.classList.remove('active');
      if (opts.onPointerUp) opts.onPointerUp(value);
      if (opts.onChange) opts.onChange(value);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      let dir = 0;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') dir = -1;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') dir = 1;
      else return;
      e.preventDefault();
      const before = value;
      value = snap(fromPos(clamp(toPos(value) + dir * (e.shiftKey ? 0.1 : 0.01), 0, 1)));
      if (value === before) value = snap(value + dir * step); // coarse knobs: at least one step
      render(); emit();
      if (opts.onChange) opts.onChange(value);
    });
    render();
    return { get value() { return value; }, set(v) { value = snap(v); render(); } };
  }

  /* ---------- dice slider: a die at the left of a track; drag it right (or
     tap anywhere on the track) to choose a randomization strength 0..1 --
     releasing fires onRoll(strength) once, then the die eases back to the
     left on its own. ---------- */
  function createDiceSlider(container, label, onRoll) {
    container.innerHTML = '<div class="dicetrack" tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div><span class="label"></span><div class="die" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></div>';
    const el = container.querySelector('.dicetrack');
    el.setAttribute('aria-label', label);
    const fill = el.querySelector('.fill');
    const die = el.querySelector('.die');
    el.querySelector('.label').textContent = label;
    const trackInset = 5, dieW = 31;
    function place(strength) {
      const r = el.getBoundingClientRect();
      const travel = Math.max(0, r.width - dieW - trackInset * 2 - 4);
      die.style.left = (trackInset + strength * travel) + 'px';
      die.style.transform = `rotate(${strength * 720}deg)`;
      fill.style.width = (strength > 0 ? trackInset + strength * travel + dieW / 2 : 0) + 'px';
    }
    place(0);
    let dragging = false;
    function fromClientX(clientX) {
      const r = el.getBoundingClientRect();
      const travel = Math.max(1, r.width - dieW - trackInset * 2 - 4);
      const strength = Math.min(1, Math.max(0, (clientX - r.left - trackInset - dieW / 2) / travel));
      place(strength);
      return strength;
    }
    el.addEventListener('pointerdown', (e) => {
      dragging = true; el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      fromClientX(e.clientX);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) fromClientX(e.clientX); });
    const end = (e) => {
      if (!dragging) return;
      dragging = false; el.classList.remove('dragging');
      const strength = fromClientX(e.clientX);
      place(0);
      if (strength > 0.01) onRoll(strength);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // keyboard: Enter rolls at half strength, digits 1-9 roll at 10-90%
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRoll(0.5); }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); onRoll(+e.key / 10); }
    });
  }

  /* kit-wide Decay trim: deliberately a multiplier, not a plain percentage
     -- decay-time changes read as musically equal steps when they're
     multiplicative (halving vs. doubling feel like the same-size move no
     matter the drum's native decay), so a percent-of-one-fixed-range
     slider would bunch all its useful motion into a tiny arc. Floor is
     pulled well down (0.05x) so a kit roll that lands on long decays can
     still be dialed all the way into tight/snappy territory; ceiling
     stays at 4x to match the per-step decay lane's own range.
     Piecewise so 0 always means "unchanged" exactly, on both sides. */
  const KIT_DECAY_FLOOR = 0.05, KIT_DECAY_CEIL = 4;
  function kitDecayFromSlider(v) {
    return v >= 0 ? Math.pow(KIT_DECAY_CEIL, v / 100) : Math.pow(KIT_DECAY_FLOOR, -v / 100);
  }
  function kitDecaySliderFromValue(m) {
    return Math.round(m >= 1 ? 100 * Math.log(m) / Math.log(KIT_DECAY_CEIL) : -100 * Math.log(m) / Math.log(KIT_DECAY_FLOOR));
  }

  /* ---------- controls ---------- */
  const commit = () => history.commit();
  const tempoSlider = createKnob($('#tempoField'), { min: 60, max: 200, step: 1, value: tempo, label: 'Tempo', fmt: (v) => v + ' bpm', onInput: (v) => { tempo = v; readoutDirty = true; }, onChange: commit });
  const swingSlider = createKnob($('#swingField'), { min: 0, max: 100, step: 1, value: 0, label: 'Swing', fmt: (v) => v + '%', onInput: (v) => { swing = v / 100; readoutDirty = true; }, onChange: commit });
  const quantizeSlider = createKnob($('#quantizeField'), { min: 0, max: 5, step: 1, value: 0, label: 'Quantize', fmt: (v) => '1/' + QUANT_VALUES[v], onInput: (v) => setQuantize(QUANT_VALUES[v]), onChange: commit });

  /* kit-wide trims and macro mixes: shift every drum on the map at once,
     independent of any single drum's own tuning. */
  const kitEl = $('#kitKnobs');
  const kitKnob = (o) => { const d = document.createElement('div'); kitEl.appendChild(d); return createKnob(d, Object.assign({ onChange: commit }, o)); };
  const pct = (v) => v + '%';
  const tuneSlider = kitKnob({ min: -12, max: 12, step: 1, value: 0, bipolar: true, label: 'Tune', fmt: (v) => (v > 0 ? '+' : '') + v + ' st', onInput: (v) => { trims.tune = v; } });
  const decaySlider = kitKnob({ min: -100, max: 100, step: 1, value: 0, bipolar: true, label: 'Decay', fmt: (v) => '\u00d7' + kitDecayFromSlider(v).toFixed(2), onInput: (v) => { trims.decay = kitDecayFromSlider(v); } });
  const macroPunchSlider = kitKnob({ min: 0, max: 300, step: 1, value: 100, label: 'Punch', ariaLabel: 'Punch (attack)', fmt: pct, onInput: (v) => { trims.punch = v / 100; } });
  const driveSlider = kitKnob({ min: 0, max: 100, step: 1, value: 0, label: 'Drive', fmt: pct, onInput: (v) => { trims.drive = v / 100; } });
  const foldSlider = kitKnob({ min: 0, max: 100, step: 1, value: 0, label: 'Fold', fmt: pct, onInput: (v) => { trims.fold = v / 100; } });
  const macroToneSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, label: 'Body', ariaLabel: 'Body mix', fmt: pct, onInput: (v) => { trims.toneMix = v / 100; } });
  const macroNoiseSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, label: 'Noise', ariaLabel: 'Noise mix', fmt: pct, onInput: (v) => { trims.noiseMix = v / 100; } });
  const macroMetalSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, label: 'Metal', ariaLabel: 'Metal mix', fmt: pct, onInput: (v) => { trims.metalMix = v / 100; } });
  const macroResSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, label: 'Resonator', ariaLabel: 'Resonator mix', fmt: pct, onInput: (v) => { trims.resMix = v / 100; } });

  $('#play').addEventListener('click', () => setPlaying(!playing));
  $('#record').addEventListener('click', () => setRecording(!recording));
  $('#clear').addEventListener('click', () => { seq.clear(); history.commit(); });
  const selBtn = $('#select');
  selBtn.addEventListener('click', () => {
    const v = selBtn.getAttribute('aria-pressed') !== 'true';
    selBtn.setAttribute('aria-pressed', v); seq.setSelect(v);
  });

  const monoBtn = $('#mono');
  monoBtn.addEventListener('click', () => {
    const v = monoBtn.getAttribute('aria-pressed') !== 'true';
    monoBtn.setAttribute('aria-pressed', String(v));
    if (engine) engine.mono = v;
    pendingMono = v;
    history.commit();
  });
  let pendingMono = false; // applied to `engine` once it's created (ensureAudio runs lazily)

  /* ---------- undo / redo ---------- */
  const history = {
    stack: [], index: -1,
    snapshot() {
      return {
        steps: JSON.parse(JSON.stringify(seq.steps)),
        anchors: ANCHORS.map((a) => ({ ...a.p })),
        trims: { ...trims }, tempo, swing, quantizeN, mono: pendingMono,
      };
    },
    restore(s) {
      seq.steps = JSON.parse(JSON.stringify(s.steps));
      s.anchors.forEach((p, i) => { ANCHORS[i].p = { ...p }; });
      Object.assign(trims, { fold: 0, resMix: 1 }, s.trims);
      tempo = s.tempo; swing = s.swing; quantizeN = s.quantizeN;
      pendingMono = s.mono; if (engine) engine.mono = s.mono;
      tempoSlider.set(tempo);
      swingSlider.set(Math.round(swing * 100));
      monoBtn.setAttribute('aria-pressed', String(s.mono));
      const qi = QUANT_VALUES.indexOf(quantizeN);
      if (qi >= 0) quantizeSlider.set(qi);
      tuneSlider.set(trims.tune);
      decaySlider.set(kitDecaySliderFromValue(trims.decay));
      driveSlider.set(Math.round(trims.drive * 100));
      foldSlider.set(Math.round((trims.fold || 0) * 100));
      macroResSlider.set(Math.round((trims.resMix == null ? 1 : trims.resMix) * 100));
      macroPunchSlider.set(Math.round(trims.punch * 100));
      macroToneSlider.set(Math.round(trims.toneMix * 100));
      macroNoiseSlider.set(Math.round(trims.noiseMix * 100));
      macroMetalSlider.set(Math.round(trims.metalMix * 100));
      dirty = stepsDirty = readoutDirty = laneDirty = true;
      scheduleFieldRefresh(); loadAnchorIntoEditor();
      seq.onChange();
    },
    commit() {
      const snap = this.snapshot();
      const top = this.stack[this.index];
      if (top && JSON.stringify(top) === JSON.stringify(snap)) return;
      this.stack = this.stack.slice(0, this.index + 1);
      this.stack.push(snap);
      if (this.stack.length > 60) this.stack.shift(); else this.index++;
      this.index = this.stack.length - 1;
    },
    undo() { if (this.index > 0) { this.index--; this.restore(this.stack[this.index]); } },
    redo() { if (this.index < this.stack.length - 1) { this.index++; this.restore(this.stack[this.index]); } },
  };
  /* ---------- randomizer dice: strength 0..1 (how far right the die was
     dragged) scales how much gets perturbed. ---------- */
  function jitterAnchorParams(a, strength) {
    PARAM_SPECS.forEach((spec) => {
      const span = spec.max - spec.min;
      a.p[spec.key] = clamp(a.p[spec.key] + (Math.random() * 2 - 1) * strength * span * 0.75, spec.min, spec.max);
    });
  }
  function randomizeSequence(strength) {
    seq.steps.forEach((s) => {
      if (!s.on) return;
      s.x = clamp(s.x + (Math.random() * 2 - 1) * strength * 0.9, 0, 1);
      s.y = clamp(s.y + (Math.random() * 2 - 1) * strength * 0.9, 0, 1);
    });
    seq.onChange();
    history.commit();
  }
  function randomizeDrum(strength) {
    jitterAnchorParams(ANCHORS[+engineSelect.value], strength);
    loadAnchorIntoEditor(); scheduleFieldRefresh();
    stepsDirty = readoutDirty = laneDirty = true;
    history.commit();
  }
  function randomizeKit(strength) {
    // every drum gets jittered at the same strength as a single-drum roll
    // (not damped down), so a full-strength kit roll is a real reshuffle.
    ANCHORS.forEach((a) => jitterAnchorParams(a, strength));
    loadAnchorIntoEditor(); scheduleFieldRefresh();
    stepsDirty = readoutDirty = laneDirty = true;
    history.commit();
  }
  createDiceSlider($('#seqDiceField'), 'Randomize sequence', randomizeSequence);
  createDiceSlider($('#drumDiceField'), 'Randomize this drum', randomizeDrum);
  createDiceSlider($('#kitDiceField'), 'Randomize kit', randomizeKit);

  history.commit(); // baseline
  $('#undo').addEventListener('click', () => history.undo());
  $('#redo').addEventListener('click', () => history.redo());
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.code !== 'KeyZ') return;
    e.preventDefault();
    if (e.shiftKey) history.redo(); else history.undo();
  });

  /* ---------- keyboard: keys hold steps ---------- */
  const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8',
    'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI'];
  const keyHeld = new Set();
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setPlaying(!playing); return; }
    const i = KEYS.indexOf(e.code);
    if (i < 0 || e.repeat) return;
    e.preventDefault(); ensureAudio();
    keyHeld.add(i); seq.stepDown(i);
  });
  document.addEventListener('keyup', (e) => {
    const i = KEYS.indexOf(e.code);
    if (i >= 0 && keyHeld.has(i)) { keyHeld.delete(i); seq.stepUp(i); }
  });
  window.addEventListener('blur', () => { keyHeld.clear(); seq.releaseAll(); });

  /* ---------- frame loop ---------- */
  function frame(now) {
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
    lastT = now;

    if (actx && queue.length) {
      const ct = actx.currentTime;
      while (queue.length && queue[0].t <= ct) {
        const q = queue.shift();
        cur = q.i;
        if (q.fired) spawnBurst(q.x, q.y, q.P, now);
        headDirty = dirty = laneDirty = true;
      }
    }
    stepParticles(dt, now);
    if (particles.length) dirty = true;

    if (headDirty) { updateHead(); headDirty = false; }
    if (stepsDirty) { renderSteps(); stepsDirty = false; }
    readoutDirty = false; // nothing displays a voice readout anymore
    if (laneDirty) { drawLanes(); laneDirty = false; }
    if (dirty) { drawPad(now); dirty = false; }
    requestAnimationFrame(frame);
  }

  /* ---------- pages: icon nav + swipe between pad/lanes/kit/engine/info ---------- */
  const PAGE_ORDER = ['pad', 'lanes', 'kit', 'engine', 'info'];
  let currentPage = 'pad';
  let slide = null; // the page transition in flight, if any
  function settleSlide() {
    if (!slide) return;
    const { from, anims, timer } = slide;
    slide = null;
    clearTimeout(timer);
    anims.forEach((an) => { try { an.cancel(); } catch (_) {} });
    from.classList.remove('active', 'leaving');
  }
  function setPage(page) {
    if (!PAGE_ORDER.includes(page) || page === currentPage) return;
    settleSlide();
    const from = document.querySelector(`.page[data-page="${currentPage}"]`);
    const to = document.querySelector(`.page[data-page="${page}"]`);
    const dir = PAGE_ORDER.indexOf(page) > PAGE_ORDER.indexOf(currentPage) ? 1 : -1;
    currentPage = page;
    document.querySelectorAll('.navbtn').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.page === page)));
    to.classList.add('active');
    // canvases inside a page that was display:none have stale/zero size;
    // force a resize+redraw now that the page is actually visible.
    if (page === 'pad') { resizePad(); dirty = true; }
    if (page === 'lanes') { resizeLaneCanvas(); laneDirty = true; }
    if (reduceMotion || !to.animate) { from.classList.remove('active'); return; }
    // the old page leaves as the new one arrives, side by side like a strip;
    // no fill mode, so once the animations end (or are cancelled) both pages
    // are back to an untransformed resting state whatever happened
    from.classList.add('leaving');
    const opts = { duration: 380, easing: 'cubic-bezier(.65, 0, .35, 1)' };
    const off = (sign) => `translateX(calc(${sign} * (100% + 24px)))`;
    const anims = [
      from.animate([{ transform: 'translateX(0)' }, { transform: off(-dir) }], opts),
      to.animate([{ transform: off(dir) }, { transform: 'translateX(0)' }], opts),
    ];
    const timer = setTimeout(settleSlide, opts.duration + 200); // in case finish never fires
    slide = { from, anims, timer };
    anims[1].onfinish = () => { if (slide && slide.anims === anims) settleSlide(); };
  }
  function initPages() {
    document.querySelectorAll('.navbtn').forEach((btn) => {
      btn.addEventListener('click', () => setPage(btn.dataset.page));
    });
    const pages = $('#pages');
    const INTERACTIVE = '#pad, .step, .knob, .dicetrack, #laneCanvas, button, select, input, .tab';
    let sw = null; // {x, y, pointerId}
    pages.addEventListener('pointerdown', (e) => {
      if (e.target.closest(INTERACTIVE)) { sw = null; return; }
      sw = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      try { pages.setPointerCapture(e.pointerId); } catch (_) {}
    });
    pages.addEventListener('pointerup', (e) => {
      if (!sw || sw.pointerId !== e.pointerId) return;
      const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
      sw = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const i = PAGE_ORDER.indexOf(currentPage);
      if (dx < 0 && i < PAGE_ORDER.length - 1) setPage(PAGE_ORDER[i + 1]);
      else if (dx > 0 && i > 0) setPage(PAGE_ORDER[i - 1]);
    });
    pages.addEventListener('pointercancel', () => { sw = null; });
  }

  new ResizeObserver(resizePad).observe(pad);
  new ResizeObserver(resizeLaneCanvas).observe(laneCanvas);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { dirty = true; });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { dirty = true; });
  resizePad(); resizeLaneCanvas();
  requestAnimationFrame(frame);
  initPages();
})();

