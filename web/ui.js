
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

  /* ---------- star colours: a sound's colour follows its stellar class.
     voiceSignature's t runs 0 (deep, low) .. 1 (bright, high); deep sounds
     glow like cool red M stars, bright ones burn blue-white like B stars.
     Step tiles use a stronger version so neighbours read apart. ---------- */
  const hexRGB = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const ramp = (stops) => { const cs = stops.map(hexRGB); return (t) => {
    t = clamp(t, 0, 1) * (cs.length - 1);
    const i = Math.min(cs.length - 2, Math.floor(t)), f = t - i;
    return mixc(cs[i], cs[i + 1], f);
  }; };
  const STAR_NIGHT = ramp(['#FF6A3D', '#FF9A4A', '#FFD9A8', '#F4F1FF', '#BFCBFF', '#8EA4FF']);
  const STAR_DAY = ramp(['#E0461F', '#E8731C', '#D9A23A', '#9D93C8', '#5E78E6', '#3C55D9']); // inked for paper
  const TILE = ramp(['#FF4A2E', '#FF8424', '#FFBE3D', '#C6A8FF', '#8D9CFF', '#5B6EFF']);
  let theme = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    theme = { sky: hexRGB(v('--sky') || '#03050A'), line: v('--sky-line'), star: v('--sky-star'), now: v('--now'), hold: v('--hold'), ink: v('--ink'), muted: v('--muted') };
    theme.dark = lum(theme.sky) < 0.5;
    theme.glint = theme.dark ? [255, 255, 255] : [16, 21, 33];
  }
  const starRGB = (t) => (theme.dark ? STAR_NIGHT : STAR_DAY)(t);
  /* the six modulators' own colours: none of them yellow, cyan or red */
  const MOD_COL = ['#FF6B91', '#FFAA3D', '#A98BFF', '#7F9BFF', '#5FD39A', '#C4BFDD'];
  const MOD_COL_DAY = ['#D9466F', '#C77A12', '#7C5CE6', '#4F6FE0', '#2E9E68', '#6F7A92'];
  const modCol = (k) => (theme.dark ? MOD_COL : MOD_COL_DAY)[k];

  /* knob geometry (see createKnob) */
  const KNOB_SWEEP = 270, KNOB_R = 22, KNOB_C = 26;
  function arcPath(a0, a1, R = KNOB_R) {
    // angles in degrees, 0 = 12 o'clock, clockwise
    const pt = (a) => [KNOB_C + R * Math.sin(a * Math.PI / 180), KNOB_C - R * Math.cos(a * Math.PI / 180)];
    if (Math.abs(a1 - a0) < 0.5) a1 = a0 + 0.5;
    const [x0, y0] = pt(Math.min(a0, a1)), [x1, y1] = pt(Math.max(a0, a1));
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  /* ---------- state ---------- */
  let actx = null, engine = null;
  let trash = null; // the trash key while it's held: {id, used, steps}
  const randTargets = new WeakMap(); // element -> roll(strength), for hold-the-die-and-tap
  let morph = null; // the sky resizing between the pad and modulation pages
  /* preferences, kept in this browser */
  const prefs = { diceAssign: false, theme: 'auto' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('pixy.prefs') || '{}')); } catch (_) {}
  const savePrefs = () => { try { localStorage.setItem('pixy.prefs', JSON.stringify(prefs)); } catch (_) {} };
  if (prefs.theme !== 'auto') document.documentElement.dataset.theme = prefs.theme;
  let dpr = 1;
  let dirty = true, stepsDirty = true, readoutDirty = true, headDirty = false, laneDirty = true;
  let tempo = 118, swing = 50; // swing in percent: 50 straight .. 75
  const trims = { tune: 0, decay: 1, drive: 0, fold: 0, toneMix: 1, noiseMix: 1, metalMix: 1, resMix: 1, punch: 1 };
  let cur = -1;
  let lastAud = { t: 0, x: 0, y: 0 };
  let lastT = 0;

  readTheme();
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

  /* stepped / smooth (the key beside record, as in Slicefield). Stepped:
     a touch is one position per hit. Smooth: hits from the pad are glide
     voices that follow the finger while they ring, and recording keeps
     the whole gesture (AUTO_POINTS per step). It only changes new touches;
     steps already recorded keep how they were made. */
  let smooth = false;
  let liveVoices = []; // glide handles of live pad hits still ringing
  function playLive(x, y, t) {
    if (!engine) return paramsAt(x, y);
    const when = t == null ? actx.currentTime : t;
    const h = strike(-1, x, y, when, undefined, smooth);
    if (h.v.glide && smooth) liveVoices.push(h.v);
    return h.P;
  }
  function glideLive(x, y) {
    if (!smooth || !actx || !liveVoices.length) return;
    const now = actx.currentTime, P = soundAt(-1, x, y, now, null);
    liveVoices = liveVoices.filter((h) => h.end > now);
    for (const h of liveVoices) h.glide(P, now);
  }

  /* ---------- modulation at the moment of a hit ----------
     soundAt: the parameters for a hit at (x, y) on step i (-1 = a live
     touch), struck at time t, envT seconds into the hit (null = the strike
     itself, envelopes at zero). LFOs are read once at the strike; an
     envelope moves pitch, filters, levels, position, FM, fold and drive
     through the hit (the voice glides), and anything fixed at the strike
     (decays, attack, sweep, clap) takes the envelope's peak. */
  const mods = Array.from({ length: MOD_COUNT }, freshMod);
  // a starting set: two at work on the demo beat, the rest ready to assign
  const anchorNamed = (n) => ANCHORS.findIndex((a) => a.name === n);
  Object.assign(mods[0], { shape: 'kepler', rate: 2, depth: 0.35, ctl: 0.6, dest: 'decay', targets: [{ kind: 'drum', a: anchorNamed('snare') }] });
  Object.assign(mods[1], { shape: 'env', atk: 0.05, dec: 0.35, depth: 0.45, dest: 'mPitch', targets: [{ kind: 'drum', a: anchorNamed('closed hat') }] });
  Object.assign(mods[2], { shape: 'halo', rate: 1, depth: 0.3, ctl: 0.4, dest: 'x' });
  Object.assign(mods[3], { shape: 'saw', rate: 3, depth: -0.4, dest: 'lp' });
  Object.assign(mods[4], { shape: 'random', rate: 5, depth: 0.3, dest: 'fold' });
  Object.assign(mods[5], { shape: 'figure8', rate: 1, depth: 0.25, dest: 'y' });
  const knobMods = [], knobRefreshers = []; // knob source pickers (kit and engine pages)
  // what an envelope moves through the whole hit; the rest (decays, attack,
  // sweep, clap) are fixed when the voice is struck, so they take its peak
  const GLIDE_DESTS = new Set(['x', 'y', 'pitch', 'f', 'fm', 'fmRatio', 'tone', 'noise', 'metal', 'mPitch', 'res', 'resF', 'resShape', 'hp', 'lp', 'q', 'lvl', 'drive', 'fold']);
  /* the song clock. Synced LFOs read beats from the steps actually
     scheduled (each mark is one step: its time, its beat, its length), so
     a modulated tempo keeps them in step; stopped, they rest at beat 0.
     Free LFOs read seconds of the audio clock and never stop. */
  let beatMarks = [];
  function beatsAt(t) {
    if (!playing || !beatMarks.length) return 0;
    let m = beatMarks[0];
    for (let k = beatMarks.length - 1; k >= 0; k--) if (beatMarks[k].t <= t) { m = beatMarks[k]; break; }
    return m.beat + (t - m.t) / m.dur * 0.25;
  }
  const clockNow = () => (actx ? actx.currentTime : performance.now() / 1000);
  function activeMods(i, x, y) {
    const a = nearestAnchor(x, y), out = [];
    for (const m of mods) if (m.targets.length && modCovers(m, i, a)) out.push(m);
    return out;
  }
  const isEnv = (m) => m.shape === 'env';
  function soundAt(i, x, y, t, envT, act) {
    act = act || activeMods(i, x, y);
    if (!act.length) return paramsAt(x, y);
    const beats = beatsAt(t);
    const amt = (m) => isEnv(m)
      ? m.depth * (GLIDE_DESTS.has(m.dest) ? (envT == null ? 0 : envAt(m, envT)) : 1)
      : m.depth * modLfo(m, beats, t);
    let pos = { x, y };
    for (const m of act) pos = modulatePos(pos, m.dest, amt(m));
    let P = paramsAt(pos.x, pos.y);
    for (const m of act) P = modulateParams(P, m.dest, amt(m));
    return P;
  }
  /* strike: one hit, with any envelope's glide scheduled through it */
  const ENV_POINTS = 10;
  function strike(i, x, y, t, decMult, glide) {
    const act = activeMods(i, x, y), envs = act.filter((m) => isEnv(m) && GLIDE_DESTS.has(m.dest));
    const P = soundAt(i, x, y, t, envs.length ? 0 : null, act);
    const v = engine.trigger(P, t, decMult, glide || envs.length ? { glide: true } : undefined);
    if (envs.length && v.glide) {
      const span = Math.min(2, Math.max(...envs.map((m) => envAttack(m) + envDecay(m))));
      for (let k = 1; k <= ENV_POINTS; k++) { const tau = span * k / ENV_POINTS; v.glide(soundAt(i, x, y, t, tau, act), t + tau); }
    }
    if (envs.length) for (const m of envs) envFires.push({ k: mods.indexOf(m), i, x, y, t });
    return { P, v };
  }
  let envFires = []; // recent envelope firings, for drawing them on the pad

  /* the pad's recent path, for smooth recording: one id per gesture so a
     step only ever samples the gesture that wrote it */
  let gestureLog = [], gestureId = 0;
  function logGesture(x, y) {
    if (!actx) return;
    const now = actx.currentTime;
    gestureLog.push({ t: now, x, y, id: gestureId });
    while (gestureLog.length && gestureLog[0].t < now - 4) gestureLog.shift();
  }
  function sampleGesture(id, start, dur) {
    const pts = gestureLog.filter((g) => g.id === id);
    if (!pts.length) return null;
    return Array.from({ length: AUTO_POINTS }, (_, k) => {
      const t = start + dur * k / (AUTO_POINTS - 1);
      let q = pts[0];
      for (const g of pts) { if (g.t <= t) q = g; else break; }
      return { x: q.x, y: q.y };
    });
  }

  /* ratchet bar: rests at 1/16 and springs back when let go. Its value
     cuts each step into ratchetHits(n) even hits, both for live pad hits
     and, while recording, for what gets written into each step. */
  let ratchetN = 16, ratchetHeld = false;
  function setRatchet(n, held) {
    ratchetN = n; ratchetHeld = held;
    if (padHoldTimer) startPadHold(); // stopped: re-arm the retrigger at the new rate
  }

  /* the 16th-note grid the live clock locks to: while playing, phase-locked
     to the running scheduler (nextBase/runPos); otherwise free-running from
     time zero, since there's no transport to lock to. */
  function gridAnchor() {
    const dur = 60 / tempo / 4;
    return { stepDur: playing ? curDur : dur, barStart: playing ? nextBase - (runPos % N_STEPS) * curDur : 0 };
  }

  /* stopped: holding the pad retriggers at the bar's rate, free-running */
  let padHoldTimer = null;
  function triggerLive() {
    const { x, y } = seq.cursor;
    const P = playLive(x, y);
  }
  function startPadHold() {
    stopPadHold();
    if (playing) return;
    padHoldTimer = setInterval(triggerLive, Math.max(30, slotDuration(tempo, ratchetN) * 1000));
  }
  function stopPadHold() {
    if (padHoldTimer) { clearInterval(padHoldTimer); padHoldTimer = null; }
  }

  /* playing: while the pad is held, hits land on the grid, each step cut by
     the bar's current value (swung steps are cut within their shortened
     span). They're scheduled only ~35 ms ahead, so lifting a finger stops
     them promptly and bar moves are heard at once. */
  const LIVE_AHEAD = 0.035;
  let liveNext = 0;
  function nextGridHit(T) {
    const { barStart, stepDur } = gridAnchor();
    const n = ratchetHits(ratchetN);
    let st = Math.floor((T - barStart) / stepDur);
    for (let k = 0; k < 3; k++, st++) {
      const start = barStart + st * stepDur, sw = swingOffset(((st % N_STEPS) + N_STEPS) % N_STEPS, swing, stepDur);
      for (let j = 0; j < n; j++) {
        const h = start + sw + j * (stepDur - sw) / n;
        if (h >= T - 1e-6) return h;
      }
    }
    return T + stepDur;
  }
  function tickLive() {
    if (!seq.padHeld()) { liveNext = 0; return; }
    const now = actx.currentTime;
    // the first grid hit after a press keeps clear of the press's own hit
    if (!liveNext) liveNext = nextGridHit(now + 0.6 * slotDuration(tempo, ratchetN));
    while (liveNext < now + LIVE_AHEAD) {
      if (liveNext > now - 0.03) {
        const t = Math.max(liveNext, now), { x, y } = seq.cursor;
        playLive(x, y, t);
      }
      liveNext = nextGridHit(liveNext + 1e-4);
    }
  }

  /* recording: each step is written once, at its catch point
     (RATCHET_CATCH of the way through it), from whatever is true then: the
     pad if it's held or was tapped since the last catch point, and the
     ratchet bar's value. A move made after a step's catch point lands on
     the next step. */
  /* replace while recording: a step that's being recorded over doesn't
     also play what it held before, so you hear what you're writing */
  let storedVoices = [];
  function silenceStored(i) {
    const now = actx.currentTime;
    storedVoices = storedVoices.filter((s) => s.v.end > now);
    for (const s of storedVoices) if (s.i === i) engine.silence(s.v, now);
  }

  /* Gestures have a start and an end, and each gets the catch window: a
     gesture covers a step if it began before that step's catch point and
     was still held at it. A tap that starts and ends before one catch point
     (pendingPress / pendingBar) still counts for that step. */
  let locks = [], finals = [], pendingPress = null, pendingBar = null;
  function lockStep(L) {
    const i = L.i;
    if (!recording) { pendingPress = pendingBar = null; return; }
    const barN = ratchetHeld ? ratchetN : pendingBar ? pendingBar.n : 16;
    const hits = ratchetHits(barN);
    const pad = seq.padHeld() ? { x: seq.cursor.x, y: seq.cursor.y, id: gestureId, smooth } : pendingPress;
    // only pad recordings write; the ratchet bar sets how many hits, and
    // whatever it reads replaces the step's old ratchets (1/16 clears them)
    if (pad) {
      seq.recordStep(i, pad.x, pad.y, hits);
      // smooth: the step's automation is sampled once the step has passed
      if (pad.smooth) finals.push({ i, t: L.S + L.dur, S: L.S, dur: L.dur, id: pad.id });
    }
    pendingPress = pendingBar = null;
  }
  function finalizeStep(F) {
    const auto = sampleGesture(F.id, F.S, F.dur);
    if (auto && auto.some((q) => q.x !== auto[0].x || q.y !== auto[0].y)) seq.setAuto(F.i, auto);
  }
  function tickLocks() {
    const now = actx.currentTime;
    while (locks.length && locks[0].t <= now) lockStep(locks.shift());
    while (finals.length && finals[0].t <= now) finalizeStep(finals.shift());
  }

  function audition(x, y, kind) {
    const now = performance.now();
    ensureAudio();
    lastAud = { t: now, x, y };
    if (kind === 'move') { logGesture(x, y); glideLive(x, y); return; } // the live clock handles retriggering
    if (kind === 'press') {
      gestureId++; logGesture(x, y);
      if (playing) {
        liveNext = 0;
        if (recording) {
          pendingPress = { x, y, id: gestureId, smooth };
          const next = locks.find((L) => L.t > actx.currentTime);
          if (next) silenceStored(next.i);
        }
      }
      else startPadHold();
    }
    playLive(x, y);
  }

  /* ---------- sequencer clock ---------- */
  let timer = null, nextBase = 0, runPos = 0, curDur = 0.125, queue = [], playing = false, recording = false;
  let playMode = 'fwd';
  /* which step plays at run position n. Random modes are rolled ahead
     and remembered, so the playhead knows where it's going next. */
  let rollAhead = new Map();
  function stepFor(n) {
    if (playMode !== 'random') return stepAt(playMode, n);
    if (!rollAhead.has(n)) rollAhead.set(n, stepAt('random', n));
    return rollAhead.get(n);
  }
  /* the transport's own modulation: tempo and swing at one moment */
  function transportAt(beat, t) {
    let bpm = tempo, sw = swing;
    for (const m of mods) {
      if (m.dest === 'bpm' && !isEnv(m)) bpm = modTempo(bpm, m.depth * modLfo(m, beat, t));
      else if (m.dest === 'swing' && !isEnv(m)) sw = modSwing(sw, m.depth * modLfo(m, beat, t));
    }
    return { bpm, sw };
  }

  function tick() {
    while (nextBase < actx.currentTime + 0.12) {
      const beat = runPos * 0.25, tp = transportAt(beat, nextBase), dur = 60 / tp.bpm / 4;
      curDur = dur;
      const i = stepFor(runPos);
      beatMarks.push({ t: nextBase, beat, dur });
      if (beatMarks.length > 64) beatMarks.shift();
      for (const k of rollAhead.keys()) if (k < runPos - 40) rollAhead.delete(k);
      const sw = swingOffset(runPos % N_STEPS, tp.sw, dur), t = nextBase + sw;
      const r = seq.trial(i);
      const fired = r.fired, decMult = r.decMult;
      let P = null;
      const s = seq.steps[i];
      const replacing = recording && seq.padHeld(); // the live pad stands in for this step
      if (fired && replacing) {
        P = null;
      } else if (fired && s.auto) {
        P = playAuto(s, i, r, t, dur - sw, decMult);
      } else if (fired) {
        P = playStored(i, r.x, r.y, t, decMult);
        if (Array.isArray(s.ratchets) && s.ratchets.length) {
          for (const rr of s.ratchets) {
            const rt = t + rr.offset * (dur - sw); // ratchets fit inside a swung step
            const rP = playStored(i, rr.x, rr.y, rt, decMult);
            queue.push({ i, t: rt, fired: true, x: rr.x, y: rr.y, P: rP, ratchet: true });
          }
        }
      }
      queue.push({ i, n: runPos, t, fired: fired && !!P, x: r.x, y: r.y, P });
      locks.push({ i, t: nextBase + RATCHET_CATCH * dur, S: nextBase, dur });
      nextBase += dur;
      runPos++;
    }
    tickLocks();
    tickLive();
  }

  function playStored(i, x, y, t, decMult) {
    if (!engine) return paramsAt(x, y);
    const h = strike(i, x, y, t, decMult, false);
    storedVoices.push({ i, v: h.v });
    return h.P;
  }

  /* a smooth-recorded step: each hit (the primary and every ratchet) is a
     glide voice that follows the recorded gesture until the next hit. A
     drift roll from the lanes shifts the whole gesture. */
  function playAuto(s, i, r, t, span, decMult) {
    const dx = r.x - s.x, dy = r.y - s.y;
    const at = (o) => { const q = autoAt(s.auto, o); return { x: clamp(q.x + dx, 0, 1), y: clamp(q.y + dy, 0, 1) }; };
    const offs = [0, ...s.ratchets.map((rr) => rr.offset)];
    let P0 = null;
    offs.forEach((o, k) => {
      const o2 = k + 1 < offs.length ? offs[k + 1] : 1, ht = t + o * span, q = at(o), P = soundAt(i, q.x, q.y, ht, 0);
      const h = engine ? engine.trigger(P, ht, decMult, { glide: true }) : null;
      if (h) storedVoices.push({ i, v: h });
      if (h && h.glide) for (let j = 1; j < AUTO_POINTS; j++) {
        const oo = j / (AUTO_POINTS - 1);
        if (oo > o && oo <= o2) { const qq = at(oo); h.glide(soundAt(i, qq.x, qq.y, ht, (oo - o) * span), t + oo * span); }
      }
      if (k) queue.push({ i, t: ht, fired: true, x: q.x, y: q.y, P, ratchet: true });
      else P0 = P;
    });
    return P0;
  }

  function setPlaying(on) {
    const btn = $('#play');
    if (on === playing) return;
    if (on) {
      ensureAudio();
      stopPadHold();
      runPos = 0; queue = []; locks = []; finals = []; beatMarks = []; rollAhead = new Map(); liveNext = 0; pendingPress = pendingBar = null;
      nextBase = actx.currentTime + 0.06;
      playing = true;
      tick();
      timer = setInterval(tick, 25);
    } else {
      clearInterval(timer); timer = null; queue = []; locks = []; finals = []; cur = -1; curN = -1; headDirty = true;
      playing = false;
      if (recording) setRecording(false); // stop disarms record
      if (seq.padHeld()) startPadHold();
    }
    btn.setAttribute('aria-label', on ? 'Stop' : 'Play');
    btn.title = on ? 'Stop' : 'Play';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setRecording(on) {
    recording = on;
    const btn = $('#record');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /* ---------- the sky: a plain field with a faint nebula of the sound map
     and a scatter of background stars. No labels and no grid. ---------- */
  const BG_STARS = (() => { let q = 7; const r = () => (q = (q * 16807) % 2147483647) / 2147483647; return Array.from({ length: 150 }, () => [r(), r(), r() ** 3]); })();
  function buildSky(W, H) {
    const N = 64, off = document.createElement('canvas'); off.width = N; off.height = N;
    const og = off.getContext('2d'), img = og.createImageData(N, N), base = theme.sky, k = theme.dark ? 0.12 : 0.13;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const c = starRGB(voiceSignature(paramsAt((i + 0.5) / N, 1 - (j + 0.5) / N)).t), q = (j * N + i) * 4;
      img.data[q] = base[0] + (c[0] - base[0]) * k; img.data[q + 1] = base[1] + (c[1] - base[1]) * k; img.data[q + 2] = base[2] + (c[2] - base[2]) * k; img.data[q + 3] = 255;
    }
    og.putImageData(img, 0, 0);
    const f = document.createElement('canvas'); f.width = W; f.height = H;
    const fg = f.getContext('2d'), u = Math.min(W, H) / 400;
    fg.imageSmoothingEnabled = true; fg.imageSmoothingQuality = 'high';
    fg.drawImage(off, 0, 0, W, H);
    fg.fillStyle = theme.star;
    for (const [x, y, b] of BG_STARS) { fg.globalAlpha = 0.15 + b * 0.7; fg.beginPath(); fg.arc(x * W, y * H, (0.4 + b * 1.1) * u, 0, 6.283); fg.fill(); }
    fg.globalAlpha = 1;
    return f;
  }
  let field = document.createElement('canvas');

  /* ---------- pad drawing ---------- */
  function resizePad() {
    const r = pad.getBoundingClientRect();
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    pad.width = Math.max(2, Math.round(r.width * dpr));
    pad.height = Math.max(2, Math.round(r.height * dpr));
    // while the sky is resizing between pages, stretch the old field
    if (!morph || !field.width) field = buildSky(pad.width, pad.height);
    dirty = true;
  }

  /* steps that share one spot on the map make one star */
  function starGroups() {
    const groups = new Map();
    seq.steps.forEach((s, i) => {
      if (!s.on) return;
      const key = Math.round(s.x * 200) + ':' + Math.round(s.y * 200);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    return [...groups.values()];
  }
  let curT = 0, curN = -1; // when the current step started sounding (audio clock), and its run position
  /* the constellation, the playhead travelling along it, the stars and the
     moons of every modulator orbiting the steps it moves */
  function drawStarChart(g, W, H, u, now, opts) {
    const P = (s) => [s.x * W, (1 - s.y) * H];
    const order = seq.steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);
    if (order.length > 1) {
      g.lineWidth = 1 * u; g.strokeStyle = theme.line;
      g.beginPath(); order.forEach((i, k) => { const [x, y] = P(seq.steps[i]); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); g.stroke();
    }
    const frac = playing && actx ? clamp((actx.currentTime - curT) / curDur, 0, 1) : 0;
    // the playhead runs from the star that last played to the next one
    // due, in whatever order the play mode visits them
    let ends = null;
    if (playing && curN >= 0 && order.length > 1 && opts.playhead) {
      const isOn = (n) => n >= 0 && seq.steps[stepFor(n)].on;
      let a = -1, b = -1;
      for (let n = curN; n >= Math.max(0, curN - 32); n--) if (isOn(n)) { a = n; break; }
      for (let n = curN + 1; n <= curN + 32; n++) if (isOn(n)) { b = n; break; }
      if (a >= 0 && b > a && stepFor(a) !== stepFor(b)) ends = { a, b };
    }
    if (ends) {
      const sa = stepFor(ends.a), sb = stepFor(ends.b), prog = clamp((curN - ends.a + frac) / (ends.b - ends.a), 0, 1);
      const [x0, y0] = P(seq.steps[sa]), [x1, y1] = P(seq.steps[sb]), hx = x0 + (x1 - x0) * prog, hy = y0 + (y1 - y0) * prog;
      const grad = g.createLinearGradient(x0, y0, hx, hy); grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, theme.now);
      g.strokeStyle = grad; g.lineWidth = 2 * u; g.beginPath(); g.moveTo(x0, y0); g.lineTo(hx, hy); g.stroke();
      g.fillStyle = theme.now; g.beginPath(); g.arc(hx, hy, 2.4 * u, 0, 6.283); g.fill();
    }
    const groups = starGroups(), font = cssVar('--font-mono') || 'monospace';
    for (const list of groups) {
      const s = seq.steps[list[0]], [x, y] = P(s), sig = voiceSignature(paramsAt(s.x, s.y)), c = starRGB(sig.t);
      // long-ringing sounds make bigger stars, short ones smaller (and the
      // step's own decay lane counts too)
      const ring = sig.dec * decayMultiplier(s.decay), big = clamp(1 + 0.22 * Math.log2(ring / 0.25), 0.7, 1.5);
      const lit = list.includes(cur) && playing && !opts.thumb, age = lit ? frac : 1, R = (4.2 + Math.min(list.length, 4) * 0.8) * u * big;
      const glow = g.createRadialGradient(x, y, 0, x, y, R * (lit ? 5 - 2 * age : 3));
      glow.addColorStop(0, rgbs(c, theme.dark ? (lit ? 0.55 : 0.28) : (lit ? 0.35 : 0.18))); glow.addColorStop(1, rgbs(c, 0));
      g.fillStyle = glow; g.beginPath(); g.arc(x, y, R * 5, 0, 6.283); g.fill();
      g.strokeStyle = rgbs(c, lit ? 0.85 : 0.45); g.lineWidth = 1 * u;
      const L = R * (lit ? 3.4 - age : 2.2);
      g.beginPath(); g.moveTo(x - L, y); g.lineTo(x + L, y); g.moveTo(x, y - L); g.lineTo(x, y + L); g.stroke();
      g.fillStyle = rgbs(c, 1); g.beginPath(); g.arc(x, y, R * 0.62, 0, 6.283); g.fill();
      if (theme.dark) { g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(x, y, R * 0.26, 0, 6.283); g.fill(); }
      else { g.strokeStyle = 'rgba(16,21,33,.55)'; g.lineWidth = 0.8 * u; g.beginPath(); g.arc(x, y, R * 0.62, 0, 6.283); g.stroke(); }
      if (lit) { g.strokeStyle = theme.now; g.lineWidth = 1.6 * u; g.beginPath(); g.arc(x, y, R * 1.7, 0, 6.283); g.stroke(); }
      if (opts.thumb) continue;
      if (list.some((i) => seq.held.has(i) || seq.latched.has(i))) { g.strokeStyle = theme.hold; g.lineWidth = 2.4 * u; g.beginPath(); g.arc(x, y, R * 2.2, 0, 6.283); g.stroke(); }
      if (opts.mark && opts.mark(list)) { g.strokeStyle = theme.hold; g.lineWidth = 2 * u; g.setLineDash(opts.mark(list) === 'drum' ? [3 * u, 3 * u] : []); g.beginPath(); g.arc(x, y, R * 2.6, 0, 6.283); g.stroke(); g.setLineDash([]); }
      g.fillStyle = theme.muted; g.font = `500 ${8.5 * u}px ${font}`; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(list.map((i) => i + 1).join(' '), x + R * 1.5 + 2 * u, y - R * 1.4);
    }
    if (!opts.thumb) drawMoons(g, W, H, u, now, groups);
  }
  /* moons: one per modulator around every star it moves. An LFO's moon
     follows its real path (an ellipse for Kepler, a figure-eight for the
     three-body orbit); an envelope shows when its step fires, as a flare,
     an impact or a supernova depending on its attack and decay. */
  function drawMoons(g, W, H, u, now, groups) {
    const T = clockNow(), beats = beatsAt(T);
    mods.forEach((m, k) => {
      if (!m.targets.length) return;
      const col = modCol(k), env = isEnv(m), sh = SHAPE_BY_ID[m.shape];
      for (const list of groups) {
        const s = seq.steps[list[0]];
        if (!list.some((i) => modCovers(m, i, nearestAnchor(s.x, s.y)))) continue;
        const cx = s.x * W, cy = (1 - s.y) * H, R = (15 + k * 4.5) * u;
        if (env) {
          const fire = envFires.filter((f) => f.k === k && list.includes(f.i)).pop();
          const look = envLook(m), span = envAttack(m) + envDecay(m);
          const age = fire && actx ? (actx.currentTime - fire.t) / Math.max(0.15, span) : 2;
          g.strokeStyle = col; g.lineWidth = 1 * u; g.globalAlpha = 0.35;
          g.beginPath(); g.arc(cx, cy, R * 0.55, 0, 6.283); g.stroke(); g.globalAlpha = 1;
          if (age >= 0 && age < 1) {
            const e = envAt(m, age * span);
            if (look === 'flare') {
              const gl = g.createRadialGradient(cx, cy, 0, cx, cy, R * (0.5 + 0.8 * e));
              gl.addColorStop(0, col); gl.addColorStop(1, 'rgba(0,0,0,0)');
              g.globalAlpha = 0.25 + 0.5 * e; g.fillStyle = gl; g.beginPath(); g.arc(cx, cy, R * 1.4, 0, 6.283); g.fill();
            } else {
              const shells = look === 'supernova' ? 3 : 1;
              for (let q = 0; q < shells; q++) {
                g.globalAlpha = Math.max(0, (1 - age) * (0.9 - q * 0.25));
                g.lineWidth = (2.2 - q * 0.5) * u;
                g.beginPath(); g.arc(cx, cy, R * (0.4 + (1.2 - q * 0.25) * Math.pow(age, look === 'impact' ? 0.4 : 0.6)), 0, 6.283); g.stroke();
              }
            }
            g.globalAlpha = 1;
          }
          continue;
        }
        const p = modCycles(m, beats, T), q = lfoAt(m.shape, p, m.ctl);
        let mx, my;
        if (sh && sh.orbit) { mx = cx + q.x * R; my = cy - q.y * R; }
        else { const a = 2 * Math.PI * p; mx = cx + Math.cos(a) * R; my = cy + Math.sin(a) * R; }
        g.strokeStyle = theme.line; g.lineWidth = 1 * u; g.setLineDash([2 * u, 3 * u]);
        g.beginPath(); g.arc(cx, cy, R, 0, 6.283); g.stroke(); g.setLineDash([]);
        g.fillStyle = col; g.beginPath(); g.arc(mx, my, 2.8 * u, 0, 6.283); g.fill();
        g.strokeStyle = rgbs(theme.sky, 1); g.lineWidth = 1 * u; g.stroke();
      }
    });
  }

  function drawPad(now) {
    const W = pad.width, H = pad.height, u = dpr;
    const px = (x) => x * W, py = (y) => (1 - y) * H;
    pg.clearRect(0, 0, W, H);
    pg.drawImage(field, 0, 0, W, H);
    drawStarChart(pg, W, H, u, now, { playhead: true });
    // cursor: a plain dot, deliberately unthemed so it always reads as
    // "you". Touching grows it and adds a thin ring.
    const c = seq.cursor, cx = px(c.x), cy = py(c.y);
    const held = seq.padHeld();
    if (held) {
      pg.strokeStyle = rgbs(theme.glint, 0.55); pg.lineWidth = 1.5 * u;
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
  const padUp = (e) => { seq.padRelease(e.pointerId); if (!seq.padHeld()) { stopPadHold(); liveNext = 0; } history.commit(); };
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
      cell.innerHTML = '<i class="led" aria-hidden="true"></i><button type="button" class="step"><span class="n"></span><span class="dot"></span><span class="hits" aria-hidden="true"></span></button>';
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
        // trash held: this step is deleted when it's let go
        if (trash) { trash.used = true; trash.steps.add(i); btn.classList.add('doomed'); return; }
        seq.stepDown(i);
      });
      btn.addEventListener('pointerup', () => {
        btn.classList.remove('doomed');
        if (trash && trash.steps.has(i)) { trash.steps.delete(i); seq.erase(i); }
        else seq.stepUp(i);
        endPointer(); history.commit();
      });
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
        const c = TILE(voiceSignature(paramsAt(s.x, s.y, w)).t);
        el.style.setProperty('--c', `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`);
        el.style.setProperty('--tc', lum(c) > 0.5 ? '#11132a' : '#ffffff');
        el.style.setProperty('--dx', s.x.toFixed(3));
        el.style.setProperty('--dy', s.y.toFixed(3));
        const hits = 1 + (Array.isArray(s.ratchets) ? s.ratchets.length : 0);
        el.querySelector('.hits').textContent = hits > 1 ? '\u2022'.repeat(hits) : '';
        el.setAttribute('aria-label', `Step ${i + 1}, on, ${nearest(w, 1)[0].name}${s.auto ? ', smooth' : ''}${hits > 1 ? `, ${hits} hits` : ''}, ${Math.round(s.prob * 100)} percent chance`);
      } else {
        el.querySelector('.hits').textContent = '';
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
  const engineParams = $('#engineParams');
  let engineIdx = 0; // the drum being edited
  const engineMenu = createMenu($('#engineSelect'), {
    label: 'Drum to edit', cls: 'two', minWidth: 260,
    items: () => ANCHORS.map((a, i) => ({ value: i, label: a.name, icon: `<i class="dot" style="background:${rgbs(starRGB(voiceSignature(a.p).t), 1)}"></i>` })),
    value: () => engineIdx,
    onPick: (i) => { engineIdx = i; loadAnchorIntoEditor(); },
  });
  let fieldRefreshTimer = null, engineAuditionTimer = null;
  function scheduleFieldRefresh() {
    clearTimeout(fieldRefreshTimer);
    fieldRefreshTimer = setTimeout(() => { field = buildSky(pad.width, pad.height); modField = null; dirty = true; }, 90);
  }
  function auditionAnchorSoon(a) {
    clearTimeout(engineAuditionTimer);
    engineAuditionTimer = setTimeout(() => {
      ensureAudio();
      const P = playAt(a.x, a.y);
    }, 60);
  }
  /* while a slider is being dragged and the sequence isn't playing,
     retrigger the drum at the quantize-slider's rate as a live preview of
     the sound change. */
  let sliderPreviewTimer = null;
  function startSliderPreview(a) {
    stopSliderPreview();
    ensureAudio();
    const fire = () => playAt(a.x, a.y);
    fire();
    sliderPreviewTimer = setInterval(fire, slotDuration(tempo, 8) * 1000); // eighth notes
  }
  function stopSliderPreview() {
    if (sliderPreviewTimer) { clearInterval(sliderPreviewTimer); sliderPreviewTimer = null; }
  }
  const moduleGrids = {};
  for (const m of MODULES) {
    const el = document.createElement('div');
    el.className = 'module'; el.style.setProperty('--accent', `var(${m.accent})`);
    el.innerHTML = '<h3></h3><div class="knobgrid"></div>';
    el.dataset.mod = m.id;
    el.style.setProperty('--n', PARAM_SPECS.filter((p) => p.mod === m.id).length);
    el.querySelector('h3').textContent = m.label;
    engineParams.appendChild(el);
    moduleGrids[m.id] = el.querySelector('.knobgrid');
    // hold the die and tap a section's name: roll just that section
    randTargets.set(el.querySelector('h3'), (st) => {
      const a = ANCHORS[engineIdx], q = jitterParams(Object.assign({}, a.p), st);
      for (const p of PARAM_SPECS) if (p.mod === m.id) a.p[p.key] = q[p.key];
      loadAnchorIntoEditor(); scheduleFieldRefresh();
    });
  }
  const paramRows = PARAM_SPECS.map((spec) => {
    const container = document.createElement('div');
    moduleGrids[spec.mod].appendChild(container);
    const slider = createKnob(container, {
      min: spec.min, max: spec.max, step: spec.step, value: BASE[spec.key], log: spec.log,
      def: () => ORIGINAL_PARAMS[engineIdx][spec.key],
      label: spec.label, fmt: (v) => fmtParam(spec.unit, v),
      onInput: (v) => {
        const a = ANCHORS[engineIdx];
        a.p[spec.key] = v;
        scheduleFieldRefresh();
        stepsDirty = readoutDirty = laneDirty = true;
        if (playing) auditionAnchorSoon(a);
      },
      onPointerDown: () => { if (!playing) startSliderPreview(ANCHORS[engineIdx]); },
      onPointerUp: stopSliderPreview,
      onChange: () => history.commit(),
      mod: knobMod(spec.key, () => ({ kind: 'drum', a: engineIdx })),
    });
    return { spec, slider };
  });
  function loadAnchorIntoEditor() {
    const a = ANCHORS[engineIdx];
    engineMenu.paint();
    paramRows.forEach(({ spec, slider }) => { slider.set(a.p[spec.key]); slider.refreshMod(); });
  }
  $('#engineReset').addEventListener('click', () => {
    const idx = engineIdx;
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
      const tc = TILE(voiceSignature(paramsAt(s.x, s.y)).t);
      const base = px2(i, colW);
      if (i === cur) {
        lg.fillStyle = theme.now; lg.globalAlpha = 0.16;
        lg.fillRect(base, 0, colW, H); lg.globalAlpha = 1;
      }
      rows.forEach((row, ri) => {
        const top = ri * rowH, h = rowH - gap;
        const v = clamp(s[row.key], 0, 1);
        lg.fillStyle = rgbs(theme.glint, on ? 0.08 : 0.04);
        lg.fillRect(base + gap / 2, top + gap / 2, colW - gap, h - gap / 2);
        const barH = Math.max(2 * u, v * (h - gap / 2));
        const rgb = on ? tc : [120, 126, 144];
        const barTop = top + (h - gap / 2) - barH + gap / 2;
        lg.fillStyle = rgbs(rgb, on ? 0.95 : 0.45);
        lg.fillRect(base + gap / 2, barTop, colW - gap, barH);
        lg.fillStyle = rgbs(theme.glint, on ? 0.6 : 0.2);
        lg.fillRect(base + gap / 2, barTop, colW - gap, Math.min(barH, 3 * u));
        // a neutral mark at the middle of the decay row shows "no change"
        if (row.key === 'decay') {
          lg.fillStyle = rgbs(theme.glint, 0.4);
          lg.fillRect(base + gap / 2, top + (h - gap / 2) * 0.5, colW - gap, Math.max(1, u));
        }
      });
    }
    // a divider between stacked bands, so the eye (and the thumb) can tell
    // them apart before a drag ever starts
    if (rows.length > 1) {
      lg.strokeStyle = rgbs(theme.glint, 0.14); lg.lineWidth = Math.max(1, u);
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

  /* ---------- knob: drag up/right to turn up, down/left to turn down
     (Shift for fine), double-tap to reset, arrow keys to nudge. A 270
     degree arc shows the value; bipolar knobs fill from 12 o'clock. log
     knobs move evenly in ratio (pitches, times), not in Hz or seconds.
     Same API the old hslider had: { value, set(v) }. ---------- */
  function createKnob(container, opts) {
    container.style.display = 'grid'; container.style.justifyItems = 'center'; container.style.gap = '4px';
    container.innerHTML = '<div class="knob" tabindex="0" role="slider"><div class="knob-dial">' +
      '<svg viewBox="0 0 52 52" aria-hidden="true"><path class="trk"/><path class="val"/><path class="mring"/></svg>' +
      '<div class="knob-cap"><i class="knob-ptr"></i></div></div><span class="knob-value"></span><span class="knob-label"></span></div>';
    const el = container.querySelector('.knob');
    const valPath = el.querySelector('.val'), valueEl = el.querySelector('.knob-value'), ringPath = el.querySelector('.mring');
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
      drawRing(ang);
    }
    /* a modulated knob gets a ring in its modulator's colour: how far the
       modulation reaches either side of the value (one side if unipolar or
       an envelope). Drag the ring to set the depth. */
    const srcK = () => (opts.mod ? opts.mod.current() : -1);
    function drawRing(ang) {
      const k = srcK();
      if (k < 0) { ringPath.style.display = 'none'; return; }
      const m = mods[k], span = Math.abs(m.depth) * 0.5 * KNOB_SWEEP, lim = KNOB_SWEEP / 2;
      const one = m.uni || isEnv(m), sgn = m.depth < 0 ? -1 : 1;
      const a0 = clamp(one ? ang : ang - span, -lim, lim), a1 = clamp(one ? ang + sgn * span : ang + span, -lim, lim);
      ringPath.setAttribute('d', arcPath(Math.min(a0, a1), Math.max(a0, a1), KNOB_R + 5.5));
      ringPath.style.display = ''; ringPath.style.stroke = modCol(k);
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
      // on the ring (outside the cap) of a modulated knob: set the depth
      const dial = el.querySelector('.knob-dial').getBoundingClientRect(), k = srcK();
      if (k >= 0 && Math.hypot(e.clientX - (dial.left + dial.width / 2), e.clientY - (dial.top + dial.height / 2)) > dial.width * 0.34) {
        drag.depth = { k, d0: mods[k].depth };
        lastTap = 0;
        valueEl.textContent = `M${k + 1} ${Math.round(mods[k].depth * 100)}%`;
      }
      el.classList.add('active');
      if (opts.onPointerDown) opts.onPointerDown(value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      if (drag.depth) {
        const m = mods[drag.depth.k];
        m.depth = Math.round(clamp(drag.depth.d0 + ((e.clientX - drag.x) - (e.clientY - drag.y)) / 160, -1, 1) * 100) / 100;
        drawRing(-KNOB_SWEEP / 2 + clamp(toPos(value), 0, 1) * KNOB_SWEEP);
        valueEl.textContent = `M${drag.depth.k + 1} ${m.depth > 0 ? '+' : ''}${Math.round(m.depth * 100)}%`;
        return;
      }
      const travel = e.shiftKey ? 800 : 200;
      const p = clamp(drag.pos + ((e.clientX - drag.x) - (e.clientY - drag.y)) / travel, 0, 1);
      const v = snap(fromPos(p));
      if (v !== value) { value = v; render(); emit(); }
    });
    const end = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      if (drag.depth) { drag = null; el.classList.remove('active'); render(); refreshKnobMods(); renderMods(); history.commit(); return; }
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
    // hold the die and tap the knob: a new value, further away with strength
    randTargets.set(el, (st) => {
      const p = clamp(toPos(value), 0, 1), q = st > 0.9 ? Math.random() : clamp(p + (Math.random() * 2 - 1) * st, 0, 1);
      value = snap(fromPos(q)); render(); emit(); if (opts.onChange) opts.onChange(value);
    });
    // a modulation source picker under the knob (kit and engine pages)
    let src = null;
    if (opts.mod) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'modsel';
      container.appendChild(b);
      const name = opts.ariaLabel || opts.label;
      src = createMenu(b, {
        label: `Modulation for ${name}`, cls: 'tiny', minWidth: 180,
        items: () => [{ value: -1, label: 'None', short: '\u00b7' }, ...mods.map((m, k) => ({
          value: k, short: `M${k + 1}`, icon: `<i class="dot" style="background:${modCol(k)}"></i>`,
          label: `M${k + 1} ${SHAPE_BY_ID[m.shape].name}` + (m.dest === opts.mod.dest ? '' : ` \u00b7 now ${MOD_DESTS.find((d) => d.id === m.dest)?.name || m.dest}`),
        }))],
        value: () => opts.mod.current(),
        onPick: (k) => opts.mod.pick(k),
        paint: (btn, it) => { const k = it ? it.value : -1; btn.classList.toggle('set', k >= 0); btn.style.background = k >= 0 ? modCol(k) : ''; },
      });
    }
    const refreshMod = () => { if (!src) return; src.paint(); render(); };
    if (src) knobRefreshers.push(refreshMod);
    return { get value() { return value; }, set(v) { value = snap(v); render(); }, refreshMod };
  }

  /* ---------- dice slider: a die at the left of a track; drag it right (or
     tap anywhere on the track) to choose a randomization strength 0..1 --
     releasing fires onRoll(strength) once, then the die eases back to the
     left on its own. ---------- */
  function createDiceSlider(container, label, onRoll) {
    container.innerHTML = '<div class="dicetrack" tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div><div class="die" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></div>';
    const el = container.querySelector('.dicetrack');
    el.setAttribute('aria-label', label);
    el.title = label;
    const fill = el.querySelector('.fill');
    const die = el.querySelector('.die');
    const dieW = () => die.offsetWidth || 36;
    function place(strength) {
      const r = el.getBoundingClientRect();
      const travel = Math.max(0, el.clientWidth - dieW());
      die.style.left = (strength * travel) + 'px';
      die.style.transform = `rotate(${strength * 450}deg)`;
      fill.style.width = (strength > 0 ? strength * travel + dieW() / 2 : 0) + 'px';
    }
    place(0);
    let dragging = false;
    function fromClientX(clientX) {
      const r = el.getBoundingClientRect();
      const travel = Math.max(1, el.clientWidth - dieW());
      const strength = Math.min(1, Math.max(0, (clientX - r.left - dieW() / 2) / travel));
      place(strength);
      return strength;
    }
    el.addEventListener('pointerdown', (e) => {
      dragging = true; el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      dieHold = { strength: fromClientX(e.clientX), used: false };
      updateDice(dieHold.strength);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) { dieHold.strength = fromClientX(e.clientX); updateDice(dieHold.strength); } });
    const end = (e) => {
      if (!dragging) return;
      dragging = false; el.classList.remove('dragging');
      const strength = fromClientX(e.clientX), used = dieHold && dieHold.used;
      dieHold = null;
      place(0); updateDice();
      if (!used && strength > 0.01) onRoll(strength);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // keyboard: Enter rolls at half strength, digits 1-9 roll at 10-90%
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRoll(0.5); }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); onRoll(+e.key / 10); }
    });
    return el;
  }

  /* ---------- ratchet bar widget: drag up for more hits per step; it
     springs back to 1/16 the moment it's let go. Arrow up/down move it
     while the key is held. ---------- */
  function createRatchetBar(el) {
    const thumb = el.querySelector('.rthumb');
    const PAD = 24, last = RATCHET_VALUES.length - 1;
    const yFor = (i) => { const h = el.clientHeight; return PAD + (h - PAD * 2) * (i / last); };
    function layout() {
      el.querySelectorAll('.rstop').forEach((t) => t.remove());
      RATCHET_VALUES.forEach((v, i) => {
        const t = document.createElement('div'); t.className = 'rstop'; t.style.bottom = yFor(i) + 'px';
        t.innerHTML = `<span>${v}</span><i></i>`; el.appendChild(t);
      });
      show(RATCHET_VALUES.indexOf(ratchetN));
    }
    function show(i) {
      thumb.style.bottom = yFor(i) + 'px';
      thumb.textContent = RATCHET_VALUES[i];
      el.setAttribute('aria-valuenow', RATCHET_VALUES[i]);
      el.setAttribute('aria-valuetext', '1/' + RATCHET_VALUES[i]);
    }
    function set(i, held) {
      i = clamp(i, 0, last);
      el.classList.toggle('held', held);
      if (RATCHET_VALUES[i] !== ratchetN || held !== ratchetHeld) setRatchet(RATCHET_VALUES[i], held);
      // while a quick hold is pending, remember the highest value it reached
      if (held && pendingBar) pendingBar.n = Math.max(pendingBar.n, RATCHET_VALUES[i]);
      show(i);
    }
    const fromY = (e) => { const r = el.getBoundingClientRect(); return Math.round(clamp((r.bottom - e.clientY - PAD) / (r.height - PAD * 2), 0, 1) * last); };
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); ensureAudio();
      drag = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      // a gesture starts: if it's let go before the next catch point it still counts
      pendingBar = { n: 16 };
      set(fromY(e), true);
    });
    el.addEventListener('pointermove', (e) => { if (drag === e.pointerId) set(fromY(e), true); });
    const end = (e) => { if (drag !== e.pointerId) return; drag = null; set(0, false); history.commit(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      if (!ratchetHeld) pendingBar = { n: 16 };
      set(RATCHET_VALUES.indexOf(ratchetN) + (e.key === 'ArrowUp' ? 1 : -1), true);
    });
    el.addEventListener('keyup', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { set(0, false); history.commit(); } });
    el.addEventListener('blur', () => { if (ratchetHeld && drag === null) set(0, false); });
    new ResizeObserver(layout).observe(el);
    layout();
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
  const swingSlider = createKnob($('#swingField'), { min: 50, max: 75, step: 1, value: 50, label: 'Swing', fmt: (v) => v + '%', onInput: (v) => { swing = v; readoutDirty = true; }, onChange: commit });
  createRatchetBar($('#ratchet'));

  /* kit-wide trims and macro mixes: shift every drum on the map at once,
     independent of any single drum's own tuning. */
  const kitEl = $('#kitKnobs');
  const kitKnob = (o) => { const d = document.createElement('div'); kitEl.appendChild(d); return createKnob(d, Object.assign({ onChange: commit, mod: o.dest ? knobMod(o.dest, () => ({ kind: 'kit' })) : null }, o)); };
  const pct = (v) => v + '%';
  const tuneSlider = kitKnob({ min: -12, max: 12, step: 1, value: 0, bipolar: true, dest: 'pitch', label: 'Tune', fmt: (v) => (v > 0 ? '+' : '') + v + ' st', onInput: (v) => { trims.tune = v; } });
  const decaySlider = kitKnob({ min: -100, max: 100, step: 1, value: 0, bipolar: true, dest: 'decay', label: 'Decay', fmt: (v) => '\u00d7' + kitDecayFromSlider(v).toFixed(2), onInput: (v) => { trims.decay = kitDecayFromSlider(v); } });
  const macroPunchSlider = kitKnob({ min: 0, max: 300, step: 1, value: 100, dest: 'atk', label: 'Punch', ariaLabel: 'Punch (attack)', fmt: pct, onInput: (v) => { trims.punch = v / 100; } });
  const driveSlider = kitKnob({ min: 0, max: 100, step: 1, value: 0, dest: 'drive', label: 'Drive', fmt: pct, onInput: (v) => { trims.drive = v / 100; } });
  const foldSlider = kitKnob({ min: 0, max: 100, step: 1, value: 0, dest: 'fold', label: 'Fold', fmt: pct, onInput: (v) => { trims.fold = v / 100; } });
  const macroToneSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, dest: 'tone', label: 'Body', ariaLabel: 'Body mix', fmt: pct, onInput: (v) => { trims.toneMix = v / 100; } });
  const macroNoiseSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, dest: 'noise', label: 'Noise', ariaLabel: 'Noise mix', fmt: pct, onInput: (v) => { trims.noiseMix = v / 100; } });
  const macroMetalSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, dest: 'metal', label: 'Metal', ariaLabel: 'Metal mix', fmt: pct, onInput: (v) => { trims.metalMix = v / 100; } });
  const macroResSlider = kitKnob({ min: 0, max: 200, step: 1, value: 100, dest: 'res', label: 'Resonator', ariaLabel: 'Resonator mix', fmt: pct, onInput: (v) => { trims.resMix = v / 100; } });

  /* press: act on touch-down. iOS sends no click for a tap made while
     another finger is down (holding the pad or the ratchet bar), and an
     instrument's transport should answer the moment it's touched anyway.
     Keyboard activation still comes through click. */
  function press(el, fn) {
    let viaPointer = false;
    el.addEventListener('pointerdown', (e) => { if (e.button > 0) return; e.preventDefault(); viaPointer = true; fn(); });
    el.addEventListener('click', () => { if (viaPointer) { viaPointer = false; return; } fn(); });
  }
  press($('#play'), () => setPlaying(!playing));
  const MODE_ICON = {
    fwd: '<path d="M4 12h14M13 7l5 5-5 5"/>', back: '<path d="M20 12H6M11 7l-5 5 5 5"/>',
    pingpong: '<path d="M3 9h15M15 6l3 3-3 3M21 15H6M9 12l-3 3 3 3"/>', random: '<path d="M3 7h3c5 0 7 10 12 10h3M3 17h3c2 0 3-2 4-4M14 11c1-2 2-4 4-4h3M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  };
  const modeIcon = (id) => `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${MODE_ICON[id]}</svg>`;
  const playModeMenu = createMenu($('#playMode'), {
    label: 'Play mode', minWidth: 170,
    items: () => PLAY_MODES.map((m) => ({ value: m.id, label: m.name, icon: modeIcon(m.id) })),
    value: () => playMode,
    onPick: (v) => { playMode = v; rollAhead = new Map(); history.commit(); },
  });
  const smoothBtn = $('#smooth');
  const SMOOTH_ICON = {
    stepped: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 15H6V9H10V12H14V5H18"/></svg>',
    smooth: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 15C4.5 15 4.5 9 7 9S9.5 12 12 12S13.5 5 18 5"/></svg>',
  };
  function paintSmooth() {
    smoothBtn.innerHTML = SMOOTH_ICON[smooth ? 'smooth' : 'stepped'];
    smoothBtn.setAttribute('aria-label', smooth ? 'Smooth: touches glide' : 'Stepped: one position per hit');
    smoothBtn.title = smooth ? 'Smooth: the sound follows your finger, and recording keeps the whole gesture' : 'Stepped: each hit takes one position';
  }
  press(smoothBtn, () => { smooth = !smooth; paintSmooth(); });
  paintSmooth();
  press($('#record'), () => setRecording(!recording));
  const clearBtn = $('#clear');
  clearBtn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    try { clearBtn.setPointerCapture(e.pointerId); } catch (_) {}
    trash = { id: e.pointerId, used: seq.held.size > 0, steps: new Set() };
    clearBtn.classList.add('pressed');
  });
  const trashUp = (e) => {
    if (!trash || trash.id !== e.pointerId) return;
    const t = trash; trash = null; clearBtn.classList.remove('pressed');
    if (e.type === 'pointercancel') return;
    const held = [...seq.held].filter((i) => !t.steps.has(i));
    if (held.length) held.forEach((i) => seq.erase(i, true));
    else if (!t.used) seq.clear();
    history.commit();
  };
  clearBtn.addEventListener('pointerup', trashUp);
  clearBtn.addEventListener('pointercancel', trashUp);
  clearBtn.addEventListener('click', (e) => { if (e.detail === 0) { seq.clear(); history.commit(); } }); // keyboard
  const selBtn = $('#select');
  press(selBtn, () => {
    const v = selBtn.getAttribute('aria-pressed') !== 'true';
    selBtn.setAttribute('aria-pressed', v); seq.setSelect(v);
  });

  const monoBtn = $('#mono');
  press(monoBtn, () => {
    const v = monoBtn.getAttribute('aria-pressed') !== 'true';
    monoBtn.setAttribute('aria-pressed', String(v));
    if (engine) engine.mono = v;
    pendingMono = v;
    history.commit();
  });
  let pendingMono = false; // applied to `engine` once it's created (ensureAudio runs lazily)

  /* ---------- dropdown: a key showing the current choice; pressing it
     opens a list in the app's own style, not the system picker. It opens
     on touch-down, and nothing stays lit once a choice is made. ---------- */
  const menuEl = document.createElement('div');
  menuEl.className = 'menu'; menuEl.hidden = true; menuEl.setAttribute('role', 'listbox');
  document.body.appendChild(menuEl);
  let menuOwner = null;
  function closeMenu() {
    if (!menuOwner) return;
    menuEl.hidden = true; menuOwner.btn.setAttribute('aria-expanded', 'false'); menuOwner = null;
  }
  /* o: items() -> [{value, label, short?, icon?, group?}], value() -> current,
     onPick(value), cls (extra class for the list), paint(btn, item) */
  function createMenu(btn, o) {
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const paint = () => {
      const it = o.items().find((x) => x.value === o.value());
      btn.innerHTML = (it && it.icon ? it.icon : '') + `<span>${it ? (it.short || it.label) : ''}</span>`;
      if (o.label) btn.setAttribute('aria-label', `${o.label}: ${it ? it.label : ''}`);
      if (o.paint) o.paint(btn, it);
    };
    const open = () => {
      if (menuOwner && menuOwner.btn === btn) { closeMenu(); return; }
      closeMenu();
      const items = o.items(), cur = o.value();
      let html = '', grp = null;
      items.forEach((it, n) => {
        if (it.group && it.group !== grp) { grp = it.group; html += `<div class="grouplabel">${grp}</div>`; }
        html += `<button type="button" role="option" data-n="${n}" aria-selected="${it.value === cur}">${it.icon || ''}<span>${it.label}</span></button>`;
      });
      menuEl.innerHTML = html;
      menuEl.className = 'menu' + (o.cls ? ' ' + o.cls : '');
      menuEl.hidden = false;
      menuOwner = { btn, items, o, paint };
      btn.setAttribute('aria-expanded', 'true');
      // place it under the key (or above, if there's more room there)
      const r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
      const w = Math.min(vw - 16, Math.max(r.width, o.minWidth || 170));
      menuEl.style.width = w + 'px';
      menuEl.style.left = clamp(r.left, 8, vw - w - 8) + 'px';
      const below = vh - r.bottom - 12, above = r.top - 12, h = menuEl.scrollHeight;
      const up = h > below && above > below;
      menuEl.style.maxHeight = Math.max(120, up ? above : below) + 'px';
      menuEl.style.top = (up ? Math.max(8, r.top - 6 - Math.min(h, above)) : r.bottom + 6) + 'px';
      const sel = menuEl.querySelector('[aria-selected="true"]');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    };
    press(btn, open);
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); const f = menuEl.querySelector('[aria-selected="true"]') || menuEl.querySelector('button'); if (f) f.focus(); } });
    randTargets.set(btn, () => { const items = o.items(); o.onPick(items[Math.floor(Math.random() * items.length)].value); paint(); });
    paint();
    return { paint, btn };
  }
  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (!b || !menuOwner) return;
    const { btn, items, o, paint } = menuOwner, it = items[+b.dataset.n];
    closeMenu();
    o.onPick(it.value); paint();
    btn.blur();
  });
  menuEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const b = menuOwner && menuOwner.btn; closeMenu(); if (b) b.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = [...menuEl.querySelectorAll('button')], k = list.indexOf(document.activeElement);
      const nx = list[clamp(k + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1)]; if (nx) nx.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (menuOwner && !menuEl.contains(e.target) && !menuOwner.btn.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('resize', closeMenu);

  /* ---------- hold the die and tap something: that one thing is rolled
     (a knob, a dropdown, a modulator's name, a step, an engine section).
     randTargets maps an element to its roll(strength). ---------- */
  let dieHold = null; // {strength, used} while the top-bar die is held
  function rollTarget(e) {
    if (!dieHold || e.target.closest('.dicetrack')) return false;
    for (let el = e.target; el && el !== document.body; el = el.parentElement) {
      const fn = randTargets.get(el);
      if (!fn) continue;
      e.preventDefault(); e.stopPropagation();
      fn(dieHold.strength > 0.05 ? dieHold.strength : 0.5);
      dieHold.used = true;
      el.classList.remove('rolled'); void el.offsetWidth; el.classList.add('rolled');
      suppressClick = performance.now();
      dirty = stepsDirty = laneDirty = true;
      history.commit();
      return true;
    }
    return false;
  }
  let suppressClick = 0;
  document.addEventListener('pointerdown', rollTarget, true);
  document.addEventListener('click', (e) => { if (performance.now() - suppressClick < 600) { e.preventDefault(); e.stopPropagation(); } }, true);

  /* ==========================================================================
     Modulation page. Six modulators, each a row: a live thumbnail, its
     name, its shape and destination, and Step / Drum assign keys. The
     selected one opens its controls right under its row.
     Assigning: hold Step or Drum and tap stars on the sky above, or hold a
     star and tap Step or Drum; several either way in one hold. A quick tap
     on Step or Drum latches it (lit) until tapped again, for one pointer.
     ========================================================================== */
  const modSky = $('#modSky'), msg = modSky.getContext('2d');
  let modField = null, modSel = 0;
  const modsEl = $('#mods');
  const isGlobal = (m) => GLOBAL_DESTS.has(m.dest);
  modsEl.innerHTML = '<div class="modhead" aria-hidden="true"><span></span><span>Assign</span></div>' + mods.map((_, k) => `<div class="mod" data-k="${k}" style="--mc:${MOD_COL[k]}">
      <canvas aria-hidden="true"></canvas>
      <div class="mid"><button type="button" class="nm" aria-label="M${k + 1}"><i></i>M${k + 1}</button>
        <div class="dds"><button type="button" class="dd cap shape"></button><button type="button" class="dd cap dest"></button></div></div>
      <button class="assign cap" type="button" data-kind="step" aria-label="Step: hold and tap stars to send M${k + 1} to those steps">Step</button>
      <button class="assign cap" type="button" data-kind="drum" aria-label="Drum: hold and tap a star to send M${k + 1} to every hit of its drum">Drum</button>
    </div>`).join('');
  const modRows = [...modsEl.querySelectorAll('.mod')];
  // the selected modulator's controls, moved under its row
  const modEdit = document.createElement('div');
  modEdit.className = 'modedit';
  modEdit.innerHTML = '<div class="modkeys"><button type="button" class="mini cap" data-t="free"></button><button type="button" class="mini cap" data-t="uni"></button></div><div class="knobgrid"></div>';
  const modKnobsEl = modEdit.querySelector('.knobgrid');

  /* shape icons, drawn from the shapes themselves */
  function shapeIcon(id, size = 22) {
    const sh = SHAPE_BY_ID[id], pts = [];
    if (sh.env) { const m = { atk: 0.25, dec: 0.5 }; const span = envAttack(m) + envDecay(m); for (let q = 0; q <= 30; q++) pts.push([2 + 20 * q / 30, 20 - envAt(m, span * q / 30) * 16]); }
    else if (sh.orbit) { const n = id === 'precession' ? 360 : id === 'halo' ? 400 : 160, cyc = id === 'precession' ? 4 : id === 'halo' ? 1.5 : id === 'retrograde' ? 2 : 1; for (let q = 0; q <= n; q++) { const o = lfoAt(id, cyc * q / n, 0.5); pts.push([12 + o.x * 9, 12 - o.y * 9]); } }
    else for (let q = 0; q <= 60; q++) pts.push([2 + 20 * q / 60, 12 - lfoAt(id, 1.5 * q / 60, id === 'random' ? 0 : 0.5).x * 7]);
    const d = pts.map((q, k) => (k ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="${d}"/></svg>`;
  }
  const SHAPE_GROUP = (s) => (s.env ? 'One-shot' : s.orbit ? 'Orbits' : 'Waves');
  const SHAPE_ITEMS = MOD_SHAPES.map((sh) => ({ value: sh.id, label: sh.name, short: sh.id === 'figure8' ? 'Figure 8' : sh.name, icon: shapeIcon(sh.id, 18), group: SHAPE_GROUP(sh) }));
  const destItems = (m) => MOD_DESTS.filter((d) => !(d.global && isEnv(m))).map((d) => ({ value: d.id, label: d.name, group: d.group }));
  const shapeMenus = [], destMenus = [];
  function setShape(k, id) {
    const m = mods[k]; m.shape = id;
    if (isEnv(m) && isGlobal(m)) m.dest = 'pitch'; // an envelope can't move the transport
    modSel = k; renderMods(); refreshKnobMods(); history.commit();
  }
  modRows.forEach((row, k) => {
    shapeMenus[k] = createMenu(row.querySelector('.shape'), { label: `M${k + 1} shape`, cls: 'two', minWidth: 290, items: () => SHAPE_ITEMS, value: () => mods[k].shape, onPick: (v) => setShape(k, v) });
    destMenus[k] = createMenu(row.querySelector('.dest'), { label: `M${k + 1} destination`, minWidth: 220, items: () => destItems(mods[k]), value: () => mods[k].dest, onPick: (v) => { mods[k].dest = v; modSel = k; renderMods(); refreshKnobMods(); history.commit(); } });
    randTargets.set(row.querySelector('.nm'), (st) => { randomizeModSettings(k, st, true); modSel = k; renderMods(); refreshKnobMods(); });
  });

  function renderMods() {
    modRows.forEach((row, k) => {
      const m = mods[k];
      row.classList.toggle('sel', k === modSel);
      row.style.setProperty('--mc', modCol(k));
      shapeMenus[k].paint(); destMenus[k].paint();
      row.querySelectorAll('.assign').forEach((b) => { b.disabled = isGlobal(m); b.title = isGlobal(m) ? 'Tempo and swing are global: nothing to assign' : ''; });
    });
    const row = modRows[modSel];
    if (modEdit.parentElement !== row) row.appendChild(modEdit);
    modEdit.style.setProperty('--mc', modCol(modSel));
    loadModEditor();
  }

  /* assigning */
  let assignHold = null;        // {k, kind, used, pointerId} while an assign key is held
  let assignLatch = null;       // {k, kind} after a quick tap, until tapped again
  const heldStars = new Map();  // pointerId -> step indices of a star held on the sky
  function targetFor(kind, list) {
    const s = seq.steps[list[0]];
    return kind === 'drum' ? [{ kind: 'drum', a: nearestAnchor(s.x, s.y) }] : list.map((i) => ({ kind: 'step', i }));
  }
  function assign(k, kind, list) {
    for (const g of targetFor(kind, list)) toggleTarget(mods[k], g);
    if (modSel !== k) { modSel = k; renderMods(); }
    refreshKnobMods(); dirty = true;
  }
  function paintAssignKeys() {
    modRows.forEach((row, k) => row.querySelectorAll('.assign').forEach((b) => {
      const on = (assignHold && assignHold.k === k && assignHold.kind === b.dataset.kind) || (assignLatch && assignLatch.k === k && assignLatch.kind === b.dataset.kind);
      b.setAttribute('aria-pressed', String(!!on));
    }));
  }
  modRows.forEach((row, k) => {
    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.dd, .assign, .modedit')) return;
      if (modSel !== k) { modSel = k; renderMods(); dirty = true; }
    });
    row.querySelectorAll('.assign').forEach((b) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { b.setPointerCapture(e.pointerId); } catch (_) {}
        assignHold = { k, kind: b.dataset.kind, used: false, pointerId: e.pointerId };
        // the inverse flow: stars already held get assigned on the spot
        for (const list of heldStars.values()) { assign(k, b.dataset.kind, list); assignHold.used = true; }
        paintAssignKeys();
      });
      const up = (e) => {
        if (!assignHold || assignHold.pointerId !== e.pointerId) return;
        const h = assignHold; assignHold = null;
        if (!h.used) assignLatch = assignLatch && assignLatch.k === h.k && assignLatch.kind === h.kind ? null : { k: h.k, kind: h.kind };
        paintAssignKeys(); history.commit();
      };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
      b.addEventListener('click', (e) => { if (e.detail === 0) { assignLatch = assignLatch && assignLatch.k === k && assignLatch.kind === b.dataset.kind ? null : { k, kind: b.dataset.kind }; paintAssignKeys(); } });
    });
  });
  function starAt(e) {
    const r = modSky.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
    let best = null, bd = Infinity;
    for (const list of starGroups()) {
      const s = seq.steps[list[0]], d = Math.hypot((s.x - x) * r.width, (s.y - y) * r.height);
      if (d < bd) { bd = d; best = list; }
    }
    return bd < 28 ? best : null;
  }
  modSky.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const list = starAt(e);
    if (!list) return;
    try { modSky.setPointerCapture(e.pointerId); } catch (_) {}
    const mode = assignHold || assignLatch;
    if (mode) { assign(mode.k, mode.kind, list); if (assignHold) assignHold.used = true; history.commit(); }
    else heldStars.set(e.pointerId, list);
    dirty = true;
  });
  const skyUp = (e) => { heldStars.delete(e.pointerId); dirty = true; };
  modSky.addEventListener('pointerup', skyUp); modSky.addEventListener('pointercancel', skyUp);
  modSky.addEventListener('contextmenu', (e) => e.preventDefault());

  function drawModSky(now) {
    const r = modSky.getBoundingClientRect(), d = Math.min(2.5, window.devicePixelRatio || 1);
    const W = Math.max(2, Math.round(r.width * d)), H = Math.max(2, Math.round(r.height * d));
    if (modSky.width !== W || modSky.height !== H) { modSky.width = W; modSky.height = H; if (!morph) modField = null; }
    if (!modField) modField = buildSky(W, H);
    msg.drawImage(modField, 0, 0, W, H);
    const m = mods[modSel];
    const held = new Set([...heldStars.values()].flat());
    drawStarChart(msg, W, H, d, now, {
      playhead: true,
      mark: (list) => {
        if (list.some((i) => held.has(i))) return 'step';
        const s = seq.steps[list[0]], a = nearestAnchor(s.x, s.y);
        if (m.targets.some((g) => g.kind === 'step' && list.includes(g.i))) return 'step';
        if (m.targets.some((g) => g.kind === 'drum' && g.a === a)) return 'drum';
        return null;
      },
    });
  }

  /* thumbnails: an LFO's path or wave with its body, or the envelope's shape */
  function drawModThumbs() {
    modRows.forEach((row, k) => {
      const cv = row.querySelector('canvas'), d = Math.min(2, window.devicePixelRatio || 1), S = Math.round(40 * d);
      if (cv.width !== S) { cv.width = S; cv.height = S; }
      const g = cv.getContext('2d'), m = mods[k], col = modCol(k), sh = SHAPE_BY_ID[m.shape], c = S / 2;
      g.fillStyle = rgbs(theme.sky, 1); g.fillRect(0, 0, S, S);
      g.lineWidth = 1.4 * d; g.strokeStyle = theme.line;
      if (isEnv(m)) {
        const span = envAttack(m) + envDecay(m);
        g.strokeStyle = col; g.beginPath();
        for (let q = 0; q <= 40; q++) { const X = 4 * d + (S - 8 * d) * q / 40, Y = S - 6 * d - envAt(m, span * q / 40) * (S - 12 * d); if (q) g.lineTo(X, Y); else g.moveTo(X, Y); }
        g.stroke();
        return;
      }
      const T = clockNow(), p = modCycles(m, beatsAt(T), T);
      if (sh.orbit) {
        const R = S * 0.36; g.beginPath();
        for (let q = 0; q <= 120; q++) { const o = lfoAt(m.shape, p - 1 + q / 120, m.ctl); const X = c + o.x * R, Y = c - o.y * R; if (q) g.lineTo(X, Y); else g.moveTo(X, Y); }
        g.stroke();
        const o = lfoAt(m.shape, p, m.ctl); g.fillStyle = col; g.beginPath(); g.arc(c + o.x * R, c - o.y * R, 3 * d, 0, 6.283); g.fill();
      } else {
        // unipolar waves sit on the floor of the thumbnail
        const yOf = (v) => (m.uni ? S - 6 * d - (v + 1) / 2 * (S - 12 * d) : c - v * S * 0.32);
        if (m.uni) { g.beginPath(); g.moveTo(3 * d, S - 6 * d); g.lineTo(S - 3 * d, S - 6 * d); g.stroke(); }
        g.strokeStyle = col; g.beginPath();
        for (let q = 0; q <= 60; q++) { const X = 4 * d + (S - 8 * d) * q / 60, Y = yOf(lfoAt(m.shape, p - 1.5 + 1.5 * q / 60, m.ctl).x); if (q) g.lineTo(X, Y); else g.moveTo(X, Y); }
        g.stroke();
      }
    });
  }

  /* the selected modulator's controls: Sync / Free and polarity keys, then
     rate (or Hz), depth, the shape's own control and phase for LFOs;
     attack, decay and depth for the envelope */
  const modKeys = { free: modEdit.querySelector('[data-t="free"]'), uni: modEdit.querySelector('[data-t="uni"]') };
  press(modKeys.free, () => { const m = mods[modSel]; m.free = !m.free; loadModEditor(); history.commit(); });
  press(modKeys.uni, () => { const m = mods[modSel]; m.uni = !m.uni; loadModEditor(); refreshKnobMods(); history.commit(); });
  const fmtHzRate = (m) => { const h = modHz(m); return h < 1 ? h.toFixed(2) + ' Hz' : h.toFixed(h < 10 ? 1 : 0) + ' Hz'; };
  function loadModEditor() {
    const m = mods[modSel], sh = SHAPE_BY_ID[m.shape];
    modKeys.free.hidden = modKeys.uni.hidden = !!sh.env;
    modKeys.free.textContent = m.free ? 'Free' : 'Sync';
    modKeys.free.title = m.free ? 'Free: runs on its own clock, even when stopped' : 'Sync: follows the song\'s tempo';
    modKeys.uni.innerHTML = m.uni ? '<b>+</b>&thinsp;Uni' : '<b>±</b>&thinsp;Bi';
    modKeys.uni.title = m.uni ? 'Unipolar: moves one way, 0 to depth' : 'Bipolar: swings both ways';
    modKnobsEl.innerHTML = '';
    const knob = (o) => { const d = document.createElement('div'); modKnobsEl.appendChild(d); return createKnob(d, Object.assign({ onChange: () => { refreshKnobMods(); history.commit(); } }, o)); };
    if (sh.env) {
      knob({ min: 0, max: 1, step: 0.01, value: m.atk, label: 'Attack', fmt: () => fmtT(envAttack(m)), onInput: (v) => { m.atk = v; } });
      knob({ min: 0, max: 1, step: 0.01, value: m.dec, label: 'Decay', fmt: () => fmtT(envDecay(m)), onInput: (v) => { m.dec = v; } });
    } else if (m.free) {
      knob({ min: 0, max: 1, step: 0.005, value: m.hz == null ? 0.45 : m.hz, label: 'Rate', fmt: () => fmtHzRate(m), onInput: (v) => { m.hz = v; } });
    } else {
      knob({ min: 0, max: MOD_RATES.length - 1, step: 1, value: m.rate, label: 'Rate', fmt: (v) => MOD_RATES[v].name, onInput: (v) => { m.rate = v; } });
    }
    knob({ min: -100, max: 100, step: 1, value: Math.round(m.depth * 100), bipolar: true, label: 'Depth', fmt: (v) => (v > 0 ? '+' : '') + v + '%', onInput: (v) => { m.depth = v / 100; refreshKnobMods(); } });
    if (!sh.env && sh.ctl) knob({ min: 0, max: 1, step: 0.01, value: m.ctl, label: sh.ctl[0], fmt: (v) => (sh.ctl[1] + v * (sh.ctl[2] - sh.ctl[1])).toFixed(2), onInput: (v) => { m.ctl = v; } });
    if (!sh.env) knob({ min: 0, max: 359, step: 1, value: Math.round(m.phase * 360), label: 'Phase', fmt: (v) => v + '°', onInput: (v) => { m.phase = v / 360; } });
  }

  /* rolling a modulator's settings: rate, depth, its shape's control and
   phase always move; at higher strength the shape and destination may
   change too (to ones that suit it). Never its assignments. */
  const ENV_DESTS = ['pitch', 'lp', 'hp', 'x', 'y', 'noise', 'metal', 'resF', 'mPitch', 'fold', 'drive', 'fm'];
  const LFO_DESTS = ['x', 'y', 'decay', 'pitch', 'lp', 'fold', 'fm', 'drive', 'noise', 'resShape', 'q'];
  function randomizeModSettings(k, strength, all) {
    const m = mods[k], pick = (a) => a[Math.floor(Math.random() * a.length)], r = Math.random;
    if (r() < (all ? 0.4 + 0.6 * strength : strength * 0.6)) { m.shape = pick(MOD_SHAPES).id; if (isEnv(m) && isGlobal(m)) m.dest = 'pitch'; }
    if (!isGlobal(m) && r() < (all ? 0.25 + 0.5 * strength : strength * 0.35)) m.dest = pick(isEnv(m) ? ENV_DESTS : LFO_DESTS);
    m.rate = clamp(Math.round(m.rate + (r() * 2 - 1) * 3 * strength), 0, MOD_RATES.length - 1);
    m.hz = clamp((m.hz == null ? 0.45 : m.hz) + (r() * 2 - 1) * 0.4 * strength, 0, 1);
    m.depth = clamp((r() < 0.5 ? -1 : 1) * (0.15 + r() * 0.6 * strength), -1, 1);
    m.ctl = clamp(m.ctl + (r() * 2 - 1) * strength, 0, 1);
    if (r() < strength) m.phase = r();
    if (r() < strength * 0.25) m.free = !m.free;
    if (r() < strength * 0.25) m.uni = !m.uni;
    m.atk = clamp(m.atk + (r() * 2 - 1) * strength * 0.6, 0, 1);
    m.dec = clamp(m.dec + (r() * 2 - 1) * strength * 0.6, 0, 1);
  }
  /* the page's die: below halfway it rolls every modulator's settings;
     past halfway, if Preferences allow it, it also makes new assignments */
  function randomizeModPage(strength) {
    mods.forEach((_, k) => { if (Math.random() < 0.4 + 0.6 * strength) randomizeModSettings(k, strength, false); });
    if (prefs.diceAssign && strength >= 0.5) randomizeAssignments(strength);
    renderMods(); refreshKnobMods(); dirty = true;
    history.commit();
  }
  /* new assignments: each modulator picks a destination that suits it
     (envelopes on things that glide through a hit) and lands on the drums
     the pattern actually uses most, or on a few steps */
  function randomizeAssignments(strength) {
    const on = seq.steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);
    if (!on.length) return;
    const counts = new Map();
    for (const i of on) { const s = seq.steps[i], a = nearestAnchor(s.x, s.y); counts.set(a, (counts.get(a) || 0) + 1); }
    const drums = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    mods.forEach((m) => {
      if (Math.random() > 0.3 + 0.7 * strength) return;
      m.targets = [];
      m.dest = pick(isEnv(m) ? ENV_DESTS : LFO_DESTS);
      const r = Math.random();
      if (r < 0.55) m.targets.push({ kind: 'drum', a: drums[Math.floor(Math.pow(Math.random(), 1.6) * drums.length)] });
      else if (r < 0.92 || strength < 0.6) {
        const n = 1 + Math.floor(Math.random() * Math.min(3, on.length));
        for (let q = 0; q < n; q++) { const g = { kind: 'step', i: pick(on) }; if (!modCovers(m, g.i, -2)) m.targets.push(g); }
      } else m.targets.push({ kind: 'kit' });
      m.depth = (Math.random() < 0.5 ? -1 : 1) * (0.12 + Math.random() * 0.5 * strength);
    });
  }

  /* the knob pickers on the kit and engine pages: a modulator moves that
     knob's control for the kit, or for the drum being edited */
  function knobMod(dest, target) {
    const sameT = (g, t) => g.kind === t.kind && g.a === t.a;
    const o = {
      dest,
      current() { const t = target(); return mods.findIndex((m) => m.dest === dest && m.targets.some((g) => sameT(g, t))); },
      pick(k) {
        const t = target();
        mods.forEach((m) => { if (m.dest === dest) m.targets = m.targets.filter((g) => !sameT(g, t)); });
        if (k >= 0) { const m = mods[k]; if (m.dest !== dest) { m.dest = dest; } m.targets.push(t); }
        renderMods(); refreshKnobMods(); dirty = true; history.commit();
      },
    };
    knobMods.push(o);
    return o;
  }
  function refreshKnobMods() { knobRefreshers.forEach((f) => f()); }

  /* ---------- undo / redo ---------- */
  const history = {
    stack: [], index: -1,
    snapshot() {
      return {
        steps: JSON.parse(JSON.stringify(seq.steps)),
        anchors: ANCHORS.map((a) => ({ ...a.p })),
        trims: { ...trims }, tempo, swing, mono: pendingMono, playMode,
        mods: JSON.parse(JSON.stringify(mods)),
      };
    },
    restore(s) {
      seq.steps = JSON.parse(JSON.stringify(s.steps));
      s.anchors.forEach((p, i) => { ANCHORS[i].p = { ...p }; });
      Object.assign(trims, { fold: 0, resMix: 1 }, s.trims);
      tempo = s.tempo; swing = s.swing;
      if (s.playMode) { playMode = s.playMode; playModeMenu.paint(); }
      if (s.mods) s.mods.forEach((m, k) => { mods[k] = JSON.parse(JSON.stringify(m)); });
      renderMods(); loadModEditor(); refreshKnobMods();
      pendingMono = s.mono; if (engine) engine.mono = s.mono;
      tempoSlider.set(tempo);
      swingSlider.set(swing);
      monoBtn.setAttribute('aria-pressed', String(s.mono));
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
      if (stash) return; // a clip is only being auditioned
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
  /* ==========================================================================
     Clips: the clip key keeps the loop as it stands (pattern, kit,
     modulation, tempo, play mode) in a pool on the Clips page, each shown
     as a thumbnail of its sky. Select one to play it there, load it back
     into the sequencer, or export it: a zip of WAVs, the mix plus one stem
     per drum, rendered from one shared set of hits so chokes cut the
     stems exactly as they cut the mix.
     Clips are kept for this viewer in the artifact's database when it's
     available, otherwise in this browser.
     ========================================================================== */
  let clips = [], clipSel = null, clipPlaying = null, stash = null, clipCount = 0;
  const clipStore = { col: null };
  const clipGrid = $('#clipGrid'), clipNote = $('#clipNote');
  const clipBody = (c) => ({ kind: 'clip', name: c.name, at: c.at, snap: c.snap, thumb: c.thumb });
  async function initClipStore() {
    try {
      if (window.claude && window.claude.use) {
        const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
        const uid = db && user ? await user.id() : null;
        if (uid) {
          clipStore.col = db.collection('data/users/' + uid);
          const snap = await clipStore.col.get();
          const got = snap.docs.filter((d) => d.exists && d.data().kind === 'clip').map((d) => Object.assign({ id: d.id }, JSON.parse(JSON.stringify(d.data()))));
          mergeClips(got);
          return;
        }
      }
    } catch (_) { clipStore.col = null; }
    try { mergeClips(JSON.parse(localStorage.getItem('pixy.clips') || '[]')); } catch (_) {}
  }
  function mergeClips(list) {
    for (const c of list) if (!clips.some((d) => d.id === c.id)) clips.push(c);
    clips.sort((a, b) => a.at - b.at);
    clipCount = clips.reduce((n, c) => Math.max(n, +(/\d+$/.exec(c.name) || [0])[0]), clipCount);
    if (currentPage === 'clips') renderClips();
  }
  function saveLocalClips() { if (!clipStore.col) try { localStorage.setItem('pixy.clips', JSON.stringify(clips)); } catch (_) {} }
  async function storeClip(c) {
    if (clipStore.col) { try { await clipStore.col.doc(c.id).set(clipBody(c)); return; } catch (_) { clipStore.col = null; } }
    saveLocalClips();
  }
  async function unstoreClip(c) {
    if (clipStore.col) { try { await clipStore.col.doc(c.id).delete(); return; } catch (_) {} }
    saveLocalClips();
  }

  /* a clip's thumbnail: its sky and constellation, no moons or labels */
  function clipThumb() {
    const S = 180, cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const g = cv.getContext('2d');
    g.drawImage(buildSky(S, S), 0, 0);
    drawStarChart(g, S, S, S / 360, performance.now(), { thumb: true });
    return cv.toDataURL('image/jpeg', 0.82);
  }
  async function takeClip() {
    if (!seq.steps.some((s) => s.on)) { flashKey($('#clip'), 'Nothing to clip'); return; }
    const snap = stash ? stash.snap : history.snapshot();
    const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: 'Clip ' + (++clipCount), at: Date.now(), snap, thumb: clipThumb() };
    clips.push(c); clipSel = c.id;
    flashKey($('#clip'));
    if (currentPage === 'clips') renderClips();
    await storeClip(c);
  }
  function flashKey(el, msg) {
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 380);
    if (msg) el.title = msg;
  }
  press($('#clip'), takeClip);

  const clipBtns = { play: $('#clipPlay'), load: $('#clipLoad'), exp: $('#clipExport'), del: $('#clipDelete') };
  const selClip = () => clips.find((c) => c.id === clipSel) || null;
  function renderClips() {
    clipGrid.innerHTML = '';
    for (const c of clips) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'clipcard'; b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(c.id === clipSel));
      b.classList.toggle('playing', c.id === clipPlaying);
      const n = c.snap.steps.filter((s) => s.on).length;
      b.innerHTML = `<img alt="" src="${c.thumb}"><span>${c.name} · ${Math.round(c.snap.tempo)} bpm · ${n} steps</span>`;
      b.setAttribute('aria-label', `${c.name}, ${Math.round(c.snap.tempo)} bpm, ${n} steps`);
      b.addEventListener('click', () => {
        clipSel = c.id;
        if (clipPlaying && clipPlaying !== c.id) playClip(c); // selecting another while one plays switches to it
        renderClips();
      });
      clipGrid.appendChild(b);
    }
    const c = selClip();
    for (const k of ['play', 'load', 'exp', 'del']) clipBtns[k].disabled = !c;
    clipBtns.play.setAttribute('aria-pressed', String(!!c && clipPlaying === c.id));
    if (!clips.length) clipNote.textContent = 'No clips yet. The clip key beside record keeps the loop as it is.';
    else if (!clipNote.dataset.busy) clipNote.textContent = '';
  }
  /* playing a clip here swaps it in for the working pattern; stopping, or
     leaving this page, puts the working pattern back */
  function playClip(c) {
    if (!stash) stash = { snap: history.snapshot(), wasPlaying: playing };
    history.restore(c.snap);
    clipPlaying = c.id;
    if (!playing) setPlaying(true);
    renderClips();
  }
  function stopClip() {
    if (!stash) return;
    const st = stash; stash = null; clipPlaying = null;
    if (!st.wasPlaying) setPlaying(false);
    history.restore(st.snap);
    renderClips();
  }
  function leaveClips() { stopClip(); }
  press(clipBtns.play, () => { const c = selClip(); if (!c) return; if (clipPlaying === c.id) stopClip(); else playClip(c); });
  clipBtns.load.addEventListener('click', () => {
    const c = selClip(); if (!c) return;
    if (stash) { const st = stash; stash = null; clipPlaying = null; if (!st.wasPlaying) setPlaying(false); }
    history.restore(c.snap); history.commit();
    clipNote.textContent = `${c.name} is in the sequencer.`;
    renderClips();
  });
  clipBtns.del.addEventListener('click', async () => {
    const c = selClip(); if (!c) return;
    if (clipPlaying === c.id) stopClip();
    clips = clips.filter((d) => d !== c); clipSel = null;
    renderClips();
    await unstoreClip(c);
  });

  /* ---------- export ---------- */
  const EXPORT_BARS = 4, EXPORT_SR = 44100;
  /* every hit of the clip, planned once: when, what, and which drum's stem
     it belongs to. A bar is played first and thrown away, so the loop
     starts with the tails it would have when looping. */
  function planClip(snap) {
    const keep = history.snapshot(), live = { beatMarks, playing };
    history.restore(snap);
    const hits = [], marks = [];
    beatMarks = marks; playing = true;
    let t = 0.02, loopStart = 0, loopEnd = 0;
    const plan = (i, x, y, at, decMult, glidePts) => {
      const act = activeMods(i, x, y), envs = act.filter((m) => isEnv(m) && GLIDE_DESTS.has(m.dest));
      const P = soundAt(i, x, y, at, envs.length ? 0 : null, act), gl = glidePts ? glidePts.slice() : [];
      if (envs.length) {
        const span = Math.min(2, Math.max(...envs.map((m) => envAttack(m) + envDecay(m))));
        for (let k = 1; k <= ENV_POINTS; k++) { const tau = span * k / ENV_POINTS; gl.push([soundAt(i, x, y, at, tau, act), at + tau]); }
      }
      hits.push({ t: at, P, decMult, glide: gl.length > 0 || !!glidePts, glides: gl, a: nearestAnchor(x, y) });
    };
    for (let n = 0; n < (EXPORT_BARS + 1) * N_STEPS; n++) {
      if (n === N_STEPS) loopStart = t;
      const beat = n * 0.25, tp = transportAt(beat, t), dur = 60 / tp.bpm / 4;
      marks.push({ t, beat, dur });
      const i = stepAt(playMode, n), sw = swingOffset(n % N_STEPS, tp.sw, dur), at = t + sw, span = dur - sw;
      const r = seq.trial(i), s = seq.steps[i];
      if (r.fired && s.auto) {
        const dx = r.x - s.x, dy = r.y - s.y;
        const q = (o) => { const p = autoAt(s.auto, o); return { x: clamp(p.x + dx, 0, 1), y: clamp(p.y + dy, 0, 1) }; };
        const offs = [0, ...s.ratchets.map((rr) => rr.offset)];
        offs.forEach((o, k) => {
          const o2 = k + 1 < offs.length ? offs[k + 1] : 1, ht = at + o * span, p0 = q(o), pts = [];
          for (let j = 1; j < AUTO_POINTS; j++) { const oo = j / (AUTO_POINTS - 1); if (oo > o && oo <= o2) { const qq = q(oo); pts.push([soundAt(i, qq.x, qq.y, ht, (oo - o) * span), at + oo * span]); } }
          hits.push({ t: ht, P: soundAt(i, p0.x, p0.y, ht, 0), decMult: r.decMult, glide: true, glides: pts, a: nearestAnchor(p0.x, p0.y) });
        });
      } else if (r.fired) {
        plan(i, r.x, r.y, at, r.decMult);
        for (const rr of s.ratchets) plan(i, rr.x, rr.y, at + rr.offset * span, r.decMult);
      }
      t += dur;
    }
    loopEnd = t;
    const setup = { trims: { ...trims }, mono: pendingMono };
    beatMarks = live.beatMarks; playing = live.playing;
    history.restore(keep);
    return { hits, loopStart, loopEnd, setup };
  }
  /* render the plan; stem = an anchor index (only its hits are heard, but
     every hit is still struck so chokes land where they do in the mix) */
  async function renderPlan(plan, stem) {
    const len = Math.ceil((plan.loopEnd + 0.05) * EXPORT_SR);
    const ctx = new OfflineAudioContext(1, len, EXPORT_SR);
    const R = Math.random; let seed = 12345; Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    try {
      const eng = new Engine(ctx, { dry: stem != null });
      eng.trims = plan.setup.trims; eng.mono = plan.setup.mono;
      for (const h of plan.hits) {
        const v = eng.trigger(h.P, h.t, h.decMult, h.glide ? { glide: true } : undefined);
        if (stem != null && h.a !== stem) v.out.gain.value = 0;
        if (v.glide) for (const [P, at] of h.glides) v.glide(P, at);
      }
    } finally { Math.random = R; }
    const buf = (await ctx.startRendering()).getChannelData(0);
    return buf.slice(Math.round(plan.loopStart * EXPORT_SR), Math.round(plan.loopEnd * EXPORT_SR));
  }
  const fileSafe = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  async function exportClip(c) {
    const note = (t) => { clipNote.textContent = t; };
    clipNote.dataset.busy = '1'; clipBtns.exp.disabled = true;
    try {
      note('Rendering the mix…');
      const plan = planClip(c.snap), base = fileSafe(c.name);
      const files = [{ name: `${base}/${base}-mix.wav`, data: encodeWav(await renderPlan(plan), EXPORT_SR) }];
      const stems = [...new Set(plan.hits.map((h) => h.a))].sort((a, b) => a - b);
      for (const [k, a] of stems.entries()) {
        note(`Rendering stems… ${k + 1} of ${stems.length}`);
        files.push({ name: `${base}/stems/${String(a + 1).padStart(2, '0')}-${fileSafe(ANCHORS[a].name)}.wav`, data: encodeWav(await renderPlan(plan, a), EXPORT_SR) });
      }
      const zip = new Blob([zipStore(files)], { type: 'application/zip' }), filename = `pixy-${base}.zip`;
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
      if (dl) {
        try { await dl.save({ filename, data: zip }); note(`Saved ${filename}: the mix and ${stems.length} stems, ${EXPORT_BARS} bars.`); }
        catch (e) { note(e && e.code === 'declined' ? 'Export cancelled.' : 'Couldn’t save the file here.'); }
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = filename;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        note(`Exported ${filename}: the mix and ${stems.length} stems, ${EXPORT_BARS} bars.`);
      }
      window.__lastExport = { filename, files: files.map((f) => f.name), bytes: zip.size }; // for tests
    } catch (e) {
      note('Export failed: ' + (e && e.message ? e.message : e));
    } finally {
      delete clipNote.dataset.busy; clipBtns.exp.disabled = !selClip();
    }
  }
  clipBtns.exp.addEventListener('click', () => { const c = selClip(); if (c) exportClip(c); });
  initClipStore();

  /* ---------- randomizer dice: strength 0..1 (how far right the die was
     dragged) scales how much gets perturbed. ---------- */
  const jitterAnchorParams = (a, strength) => jitterParams(a.p, strength);
  function randomizeSequence(strength) {
    randomizeSteps(seq.steps, strength);
    seq.onChange();
    history.commit();
  }
  function randomizeDrum(strength) {
    jitterAnchorParams(ANCHORS[engineIdx], strength);
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
  function randomizeLane(strength) {
    for (const s of seq.steps) {
      if (!s.on) continue;
      for (const row of LANES[laneMode].rows) s[row.key] = clamp(s[row.key] + (Math.random() * 2 - 1) * strength, 0, 1);
    }
    seq.onChange();
    history.commit();
  }
  /* the top-bar die, per page: what a roll does, and its caption (which
     can change with how far the die is dragged) */
  const DICE = {
    pad: [() => 'Randomize sequence', randomizeSequence],
    mod: [(st) => (prefs.diceAssign ? (st >= 0.5 ? 'Randomize modulators + assignments' : 'Randomize modulators · past half: assignments') : 'Randomize modulator settings'), randomizeModPage],
    lanes: [() => 'Randomize this lane', randomizeLane],
    kit: [() => 'Randomize every drum', randomizeKit],
    engine: [() => 'Randomize this drum', randomizeDrum],
    clips: null,
    prefs: null,
  };
  const dice = createDiceSlider($('#diceField'), 'Randomize sequence', (st) => { const d = DICE[currentPage]; if (d) d[1](st); });
  function updateDice(st) {
    const d = DICE[currentPage], cap = d ? d[0](st || 0) : '';
    dice.setAttribute('aria-label', d ? cap + '. Hold it and tap a control to randomize just that.' : 'Nothing to randomize here');
    dice.title = cap;
    dice.setAttribute('aria-disabled', String(!d));
    $('#diceCap').textContent = dieHold && dieHold.used ? 'Tap what to randomize' : cap;
  }
  /* hold the die and tap a step: that one step is rolled */
  tiles.forEach((btn, i) => randTargets.set(btn, (st) => {
    const s = seq.steps[i];
    if (!s.on) { s.on = true; s.set = true; s.x = 0.04 + Math.random() * 0.92; s.y = 0.04 + Math.random() * 0.92; }
    else randomizeSteps([s], st);
    seq.onChange();
  }));

  const HELP = {
    pad: ['Star chart', [
      '<b>Touch the sky</b> to play: every point is a different blend of drums. Each sequenced step is a star, joined to the next in step order.',
      '<b>Tap a step</b> to switch it on or off. Switching one off clears it completely.',
      '<b>Hold the pad, then tap a step</b> to give that step the sound under your finger. <b>Hold steps, then touch the pad</b> and they follow your finger.',
      '<b>Hold a step, then tap another</b> to copy its sound.',
      '<b>Trash</b>: hold it and tap steps to delete them, or hold steps and tap it. Tapped on its own, it clears the whole sequence.',
      '<b>Record</b>: while playing, touching the sky writes into the step that\'s passing. A touch that starts in the second half of a step lands on the next one; a hold covers every step it\'s still held at. Stopping also disarms record.',
      'The <b>ratchet bar</b> beside the sky sets how many hits a recorded step gets (2, 3, 4 or 6). Hold it up while recording with the sky; it springs back to 1/16 when you let go and does nothing on its own.',
      '<b>Stepped / smooth</b> (beside record): smooth lets a ringing hit follow your finger and records the whole gesture. It only affects new touches.',
      '<b>Clip</b> (the framed stars) keeps the loop as it is, sound and all, on the Clips page.',
      '<b>Play mode</b> (beside redo): forward, backward, ping-pong or random.',
      '<b>Choke</b> (the cut-off wave) lets only one hit ring at a time. <b>Select</b> (dotted square) latches steps for one-finger editing.',
      'Small <b>moons</b> orbit the stars a modulator moves. Set them up on the modulation page.',
    ]],
    mod: ['Modulation', [
      'Six modulators. Each one is a <b>wave</b>, an <b>orbit</b> (real orbital motion: Kepler, precession, halo, retrograde, resonance, figure-eight) or a one-shot <b>envelope</b>. Pick its shape and destination on its row.',
      '<b>Assign</b>: hold <b>Step</b> and tap stars to send a modulator to those steps; hold <b>Drum</b> and tap a star to send it to every hit of that star\'s drum. Tap a star again to remove it. Or hold a star and tap Step or Drum. A quick tap on Step or Drum latches it until you tap it again.',
      'Tap a row to open its controls. <b>Sync</b> follows the song\'s tempo and rests when stopped; <b>Free</b> runs in Hz on its own clock, always. <b>Bi</b> swings both ways; <b>Uni</b> only moves one way.',
      '<b>Tempo</b> and <b>swing</b> are destinations too; they\'re global, so there\'s nothing to assign.',
      'An LFO is read at the moment each hit is struck. An envelope runs through the hit: pitch, filters, levels, position, FM, fold and drive follow its whole shape; decays, attack, sweep and clap take its peak. A slow attack shows as a flare, a fast one as an impact, a fast one with a long tail as a supernova.',
      'The kit and engine pages have a small picker under each knob. A modulated knob gets a ring in its modulator\'s colour; drag the ring to set the depth.',
      '<b>The die</b> rolls every modulator\'s settings. In Preferences you can let it also make new assignments past halfway.',
    ]],
    lanes: ['Step lanes', [
      '<b>Chance</b>: how often each step plays. <b>X / Y drift</b>: how often, and how far, a step strays from its spot. <b>Decay</b>: each step\'s own decay length, and how often and how far it varies.',
      'Drag a bar up or down to set it; drag sideways to paint across steps.',
    ]],
    kit: ['Whole kit', [
      'These shift every drum on the map at once. Double-tap a knob to reset it.',
      'The small picker under each knob sends a modulator (M1 to M6) to that control for the whole kit; drag the coloured ring to set how far it moves.',
      'The die rolls every drum\'s sound. To roll one macro, hold the die and tap its knob.',
    ]],
    engine: ['Drum engine', [
      'Each drum is a point the whole map blends toward, so shaping it reshapes nearby sounds too.',
      'Layers: <b>body</b> (pitched sine with FM), <b>noise</b>, <b>metal</b> (808-style squares), <b>resonator</b> (a struck physical model, string to skin to bar), then <b>filter</b>, <b>fold</b> and <b>drive</b>.',
      'The small picker under each knob sends a modulator to that control for this drum. Hold the die and tap a section\'s name to roll just that section.',
    ]],
    prefs: ['Preferences', [
      'Settings for this browser: whether the modulation die can make new assignments, and the theme.',
    ]],
    clips: ['Clips', [
      'The <b>clip</b> key on the star chart keeps the loop as it is: pattern, sounds, modulation, tempo and play mode.',
      'Tap a clip to select it. <b>Play</b> hears it here without touching your pattern (leaving the page puts yours back); <b>Load</b> puts it into the sequencer (undo covers it).',
      '<b>Export</b> renders four bars as a zip of WAVs: the mix, and a stem for each drum. Every hit is struck in every stem, so choke cuts the stems exactly as it cuts the mix. Stems skip the master compressor.',
    ]],
  };
  /* preferences: a page of their own */
  const prefPage = $('.page[data-page="prefs"]'), prefAssign = $('#prefAssign');
  function paintPrefs() {
    prefAssign.setAttribute('aria-pressed', String(prefs.diceAssign));
    prefAssign.textContent = prefs.diceAssign ? 'On' : 'Off';
    prefPage.querySelectorAll('#prefTheme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === prefs.theme)));
  }
  prefAssign.addEventListener('click', () => { prefs.diceAssign = !prefs.diceAssign; savePrefs(); paintPrefs(); updateDice(); });
  prefPage.querySelectorAll('#prefTheme button').forEach((b) => b.addEventListener('click', () => {
    prefs.theme = b.dataset.v; savePrefs(); paintPrefs();
    if (prefs.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = prefs.theme;
  }));
  paintPrefs();

  const help = $('#help'), helpBtn = $('#helpBtn');
  function fillHelp() {
    const [title, items] = HELP[currentPage];
    $('#helpH').textContent = title;
    $('#helpList').innerHTML = items.map((t) => `<li>${t}</li>`).join('') +
      '<li><b>Hold the die and tap</b> a knob, a dropdown, a step or a modulator\'s name to roll just that one. Drag the die further for a bigger change.</li>' +
      '<li><b>Undo / redo</b> (or Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z) cover every edit. Swipe left or right to change page.</li>';
  }
  function setHelp(open) {
    help.hidden = !open; helpBtn.setAttribute('aria-expanded', String(open)); helpBtn.setAttribute('aria-pressed', String(open));
    if (open) { fillHelp(); $('#helpClose').focus(); }
  }
  helpBtn.addEventListener('click', () => setHelp(help.hidden));
  $('#helpClose').addEventListener('click', () => { setHelp(false); helpBtn.focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !help.hidden) { setHelp(false); helpBtn.focus(); } });

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
        if (!q.ratchet) { curT = q.t; curN = q.n; }
        cur = q.i;
        headDirty = dirty = laneDirty = true;
      }
    }
    if (playing || mods.some((m) => m.targets.length || m.free)) dirty = true;
    if (actx) envFires = envFires.filter((f) => actx.currentTime - f.t < 2.5);

    if (headDirty) { updateHead(); headDirty = false; }
    if (stepsDirty) { renderSteps(); stepsDirty = false; }
    readoutDirty = false; // nothing displays a voice readout anymore
    if (laneDirty) { drawLanes(); laneDirty = false; }
    if (dirty) {
      if (currentPage === 'pad' || slide) drawPad(now);
      if (currentPage === 'mod' || slide) { drawModSky(now); drawModThumbs(now); }
      dirty = false;
    }
    requestAnimationFrame(frame);
  }

  /* ---------- pages: icon nav + swipe between pad/lanes/kit/engine/info ---------- */
  const PAGE_ORDER = ['pad', 'mod', 'lanes', 'kit', 'engine', 'clips', 'prefs'];
  let currentPage = 'pad';
  let slide = null; // the page transition in flight, if any
  /* a page's parts, in the order they assemble; the sky is its own part,
     shared by the pad and modulation pages */
  const PARTS = {
    pad: '.ratchet, .transport > *, .cell, .tools > :not(.gap)',
    mod: '.modhead, .mod',
    lanes: '.lanehead > *, .lanetabs .tab, #laneCanvas, .lanereadout',
    kit: 'h2, #kitKnobs > *',
    engine: 'h2, .enginepick > *, .module h3, .module .knobgrid > *',
    clips: '.cliphead > *, .clipcard, .clipnote',
    prefs: 'h2, .prefrow',
  };
  const SKY = { pad: '.padrow .padwrap', mod: '.modsky' };
  function settleSlide() {
    if (!slide) return;
    const { from, anims, timer } = slide;
    slide = null;
    clearTimeout(timer);
    anims.forEach((an) => { try { an.cancel(); } catch (_) {} });
    from.classList.remove('active', 'leaving');
    if (morph) { morph = null; resizePad(); modField = null; dirty = true; }
  }
  function setPage(page) {
    if (!PAGE_ORDER.includes(page) || page === currentPage) return;
    settleSlide();
    closeMenu();
    const from = document.querySelector(`.page[data-page="${currentPage}"]`);
    const to = document.querySelector(`.page[data-page="${page}"]`);
    const fromSky = SKY[currentPage] && from.querySelector(SKY[currentPage]), r0 = fromSky && fromSky.getBoundingClientRect();
    const prev = currentPage;
    currentPage = page;
    updateDice();
    document.querySelectorAll('.navbtn').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.page === page)));
    if (prev === 'clips') leaveClips();
    if (prev === 'pad' && recording) setRecording(false); // recording only happens on the star chart
    to.classList.add('active');
    // canvases inside a page that was display:none have stale/zero size;
    // force a resize+redraw now that the page is actually visible.
    if (page === 'pad') { resizePad(); dirty = true; }
    if (page === 'lanes') { resizeLaneCanvas(); laneDirty = true; }
    if (page === 'mod') { modField = null; renderMods(); dirty = true; }
    if (page === 'clips') renderClips();
    if (!help.hidden) fillHelp();
    if (reduceMotion || !to.animate) { from.classList.remove('active'); return; }
    /* the old page comes apart and the new one assembles: each part flies
       in from beyond its own side of the page, a few ms after the last.
       Between the pad and modulation pages the sky stays and resizes. */
    from.classList.add('leaving');
    const anims = [], pr = to.getBoundingClientRect(), cx = pr.left + pr.width / 2, cy = pr.top + Math.min(pr.height, window.innerHeight) / 2;
    const toSky = SKY[page] && to.querySelector(SKY[page]);
    const out = (el) => { const r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy, n = Math.hypot(dx, dy) || 1; return [dx / n, dy / n]; };
    const fromParts = [...from.querySelectorAll(PARTS[prev])];
    if (fromSky) fromParts.push(fromSky);
    fromParts.forEach((el) => {
      if (el === fromSky && toSky) { el.style.visibility = 'hidden'; anims.push({ cancel() { el.style.visibility = ''; } }); return; }
      const [ux, uy] = out(el);
      anims.push(el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate(${ux * 26}px, ${uy * 26}px) scale(.96)` }], { duration: 170, easing: 'cubic-bezier(.5, 0, .9, .4)', fill: 'forwards' }));
    });
    const parts = [...to.querySelectorAll(PARTS[page])];
    if (toSky && !fromSky) parts.unshift(toSky);
    parts.forEach((el, n) => {
      const [ux, uy] = out(el), d = 34 + (n % 3) * 10;
      anims.push(el.animate([{ opacity: 0, transform: `translate(${ux * d}px, ${uy * d + 10}px) scale(.94)` }, { opacity: 1, transform: 'none' }],
        { duration: 420, delay: 70 + Math.min(n, 16) * 16, easing: 'cubic-bezier(.2, .85, .25, 1.06)', fill: 'backwards' }));
    });
    let last = 70 + Math.min(parts.length - 1, 16) * 16 + 420;
    if (toSky && fromSky) {
      // the sky resizes from where it was to where it lands on this page
      const r1 = toSky.getBoundingClientRect();
      morph = true;
      anims.push(toSky.animate([
        { transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px)`, width: r0.width + 'px', height: r0.height + 'px' },
        { transform: 'none', width: r1.width + 'px', height: r1.height + 'px' },
      ], { duration: 460, easing: 'cubic-bezier(.65, 0, .35, 1)' }));
      last = Math.max(last, 460);
    }
    const timer = setTimeout(settleSlide, last + 60);
    slide = { from, anims, timer };
  }
  function initPages() {
    document.querySelectorAll('.navbtn').forEach((btn) => {
      btn.addEventListener('click', () => setPage(btn.dataset.page));
    });
    const pages = $('#pages');
    const INTERACTIVE = '#pad, #modSky, .step, .knob, .dicetrack, .ratchet, #laneCanvas, .mod, .menu, button, select, input, .tab';
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
  const onTheme = () => { readTheme(); field = buildSky(pad.width, pad.height); modField = null; dirty = stepsDirty = laneDirty = true; renderMods(); };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { dirty = true; });
  resizePad(); resizeLaneCanvas();
  renderMods(); loadModEditor(); updateDice();
  requestAnimationFrame(frame);
  initPages();
})();

