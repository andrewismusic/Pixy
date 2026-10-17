# Pixy → iOS Port Handoff

Oct 17, 2026

## What this is

Pixy is a single-drum-voice XY-pad drum synthesizer and 16-step sequencer, built as one self-contained HTML file (`pixy.html`) running pure Web Audio + Canvas2D, no frameworks or build tooling beyond a 3-line concatenation script. A finger/mouse point on a square pad blends between 14 named drum "anchors" (kick, snare, hats, etc.) to produce a continuously-morphing synthesized hit; a 16-step sequencer records and plays back pad gestures, including sub-beat "ratchets," per-step probability/deviation/decay lanes, and kit-wide macro controls.

This document is a technical handoff for porting the prototype to a native iOS app (presumably via SwiftUI + AVAudioEngine) in a fresh Claude Code session. It assumes the reader has the `pixy.html` source (or the three source files below) but no other context from the web build process — it explains what exists, why it's built the way it is, what's solid, what's rough, and what to watch for when re-implementing it natively.

## Current architecture

Three source files, concatenated into one shipped HTML file by a trivial build script:

| File | Lines | Role |
| --- | --- | --- |
| `core.js` | \~564 | Pure logic: synthesis math, parameter interpolation, the `Engine` audio-trigger class, and the `Sequence` data model/gesture state machine. Only touches Web Audio for actual node creation inside `playVoice`/`Engine` — otherwise no DOM, no Canvas, no browser-only APIs. Exports via `module.exports` for Node unit testing; that block is stripped before shipping. |
| `ui.js` | \~1104 | Everything DOM/Canvas/pointer-event/WebAudio-context-lifecycle related: pad and lane rendering, pointer gesture handling, the custom slider/dice widgets, undo/redo, the particle feedback system, the 5-page navigation + swipe system, and all wiring between UI controls and `core.js` objects. |
| `template.html` | \~339 | The page shell: CSS (custom properties for light/dark theme, slider/dice/page/nav styling), the DOM structure (5 `<section class="page">` elements inside `#pages`), and two `<script>` placeholders `/*CORE*/` and `/*UI*/`. |
| `build.py` | 3 | Reads `core.js` (truncating at the Node `module.exports` marker) and `ui.js`, splices both into `template.html`'s placeholders, writes `pixy.html`. Run with `python3 build.py` from the project directory. |
| `pixy.html` | — | The shipped, single-file output. This is what runs in a browser; it's generated, not hand-edited. |

`core.js` and `ui.js` end up as two separate `<script>` tags in the final HTML (not one), but since both are classic (non-module) scripts they share top-level lexical scope, so `const`/`class`/`function` declarations in `core.js` are directly visible to `ui.js`.

This split is the single most useful fact for porting: **`core.js` is already "the model" in MVC terms** — synthesis parameters, interpolation math, and sequencer state — with no rendering or input-handling baked in. On iOS this maps naturally to a Swift model/audio-engine layer, while `ui.js`'s responsibilities (rendering, gesture recognition, widgets) get rebuilt idiomatically in SwiftUI/UIKit rather than ported line-by-line.

To run the prototype today: open `pixy.html` directly in a browser (no server needed). To modify it: edit `core.js`/`ui.js`/`template.html`, then run `build.py` to regenerate `pixy.html`. There is no npm/webpack/bundler step.

## Synthesis & data model (`core.js`)

### XY-pad blending

14 named drum "anchors" (`ANCHOR_DEFS`: kick, sub, low tom, high tom, conga, rim, snare, clap, closed hat, open hat, cymbal, cowbell, zap, rumble) each sit at a fixed `(x, y)` point on a unit-square pad and carry a full 18-parameter synth preset plus a hue for visual feedback. For any pad point, `weightsAt(x, y)` computes a Gaussian-kernel weight per anchor (`SIGMA = 0.09`, numerically stabilized by subtracting the max before `exp`), and `paramsAt(x, y, w)` blends all 18 parameters by those weights to produce the sound at that exact point — so the pad is a continuous morph space, not a grid of fixed samples. Frequency-like and time-constant-like parameters (`LOG_KEYS`) interpolate in log domain so pitch/time blending sounds musically even rather than linear-in-Hz. A further `GROUPS` mechanism gates some parameters (e.g. pitch-related ones) by how "tone-heavy" each nearby anchor is, so a hat-dominated blend doesn't get dragged around by a kick's pitch envelope just because the kick anchor has nonzero weight.

**Porting note:** this blending math is pure arithmetic (no Web Audio types involved) and should port almost verbatim into a Swift struct/function pair — it's the cleanest, most self-contained piece of the whole prototype.

### The 18 synth parameters (`BASE` / `PARAM_SPECS`)

Each anchor's preset is 18 named numbers: `f` (base pitch), `pEnv`/`pDec` (pitch envelope depth/decay), `tone`/`tDec` (tonal body level/decay), `fm` (FM "crack" amount), `noise`/`nDec` (noise layer level/decay), `burst` (multi-burst noise pattern, e.g. for claps), `metal`/`mDec`/`mPitch` (detuned-square "metal"/hat layer), `hp`/`lp`/`q` (filter cutoffs/resonance for the noise layer), `drive` (waveshaper saturation amount), `atk` (attack time), `lvl` (output level).

### One-hit synthesis (`playVoice`)

Given a blended parameter set `P`, `playVoice(ctx, out, noiseBuf, P, trims, t, extraDecay)` builds and schedules one voice:

1. **Kit-wide macro pre-pass**: before any signal generation, `toneMix`/`noiseMix`/`metalMix`/`punch` (from `trims`, user-controlled kit macros) scale a cloned copy of `P`'s relevant fields.
2. **Tone layer**: a sine oscillator with a pitch envelope (plus an optional FM-based "crack" transient) for the drum's tonal body.
3. **Noise layer**: a shared white-noise buffer (`makeNoise`) through resonant high-pass/low-pass `BiquadFilterNode`s; `burst` can split this into a multi-hit "clap" pattern (fixed `BURST_GAP = 0.0105`s between sub-hits).
4. **Metal layer**: six square oscillators at fixed detuned ratios (`METAL_RATIOS = [205.3, 304.4, 369.6, 522.7, 540, 800]`, modeling classic 808-style hi-hat metallic timbre).
5. All three layers sum through a shared `WaveShaperNode` using a precomputed 2048-sample `tanh`-based curve (`SHAPER_CURVE`) for drive/saturation.
6. Short exponential amplitude envelopes (`ampEnv`/`noiseEnv` helpers) are applied directly as `AudioParam` automation (`setValueAtTime`/`linearRampToValueAtTime`/`exponentialRampToValueAtTime`) — there is no sample playback or convolution anywhere; everything is oscillators, noise, filters, and a waveshaper.
7. `extraDecay` is a per-hit decay multiplier (used by the sequencer's per-step decay-deviation lanes) threaded through to scale all the above envelopes for that one hit only.

**Porting note:** this is the piece with the most direct `AVAudioEngine` analog risk. Web Audio's per-parameter automation curves (`exponentialRampToValueAtTime`, etc.) don't have a 1:1 `AVAudioEngine` equivalent — `AVAudioUnitEQ`/`AVAudioUnitDistortion` exist but hand-rolled envelope automation on arbitrary `AudioParam`-like targets does not. See the iOS recommendations section below for specific mapping options.

### `Engine` class

Wraps one `AudioContext`: holds `trims` (the kit macros above, plus tune/decay/drive), a shared noise buffer, a `voices` array for bookkeeping (capped at 14 simultaneous voices), a `mono` boolean ("Choke" mode in the UI), and a master gain → `DynamicsCompressorNode` → destination chain. `trigger(P, t, extraDecay)` is the single entry point for playing a sound. When `mono` is true, every other currently-tracked voice is silenced via `gain.cancelScheduledValues(t)` followed by `gain.setTargetAtTime(0, t, 0.006)` scheduled **at the new voice's own start time `t`**, not at "now" — this was a real bug fixed during this build (see Known rough edges) and matters for anyone re-implementing choke/mono behavior with a different scheduling model.

### Sequencer data model (`Sequence` class)

16 steps (`N_STEPS = 16`), each a record: `{ on, x, y, set, ratchets: [], prob, devXChance, devXAmount, devYChance, devYAmount, decay, decDevChance, decDevAmount }`.

- **`ratchets`**: an array of `{ offset, x, y }` sub-hits recorded within a single step's time box at finer-than-1/16 quantization. The step's own `x`/`y`/`on` remain the "primary" hit at offset 0; ratchets only fire if the primary's probability roll fires.
- **`trial(i)`**: resolves one step's per-occurrence outcome (probability roll, X/Y deviation rolls, decay-deviation roll) and returns `{ fired, x, y, decMult }` *without mutating stored state* — this is what makes the step lanes probabilistic/generative rather than deterministic.
- **`decayMultiplier(v) = Math.pow(4, 2·clamp(v,0,1) - 1)`**: maps a step's 0–1 decay-lane slider to a 0.25×–4× per-occurrence decay multiplier (0.5 = neutral). This is distinct from the kit-wide decay trim described next.
- **Full step deletion**: `toggle(i)`, when turning a step off, resets it entirely via `freshStep()` (clears position, ratchets, and all lane values) rather than just flipping `on = false`. This was a deliberate late change — earlier builds preserved stale state so a step could be re-enabled with its old sound, which users found confusing once ratchets were involved. Undo (below) is the safety net for accidental deletes.
- **Gesture-driven assignment**: tap toggles a step on/off; hold-pad-then-tap-step assigns the current pad point to that step; hold-step(s)-then-touch-pad makes held steps follow the live pad point; hold-one-step-then-tap-another copies the first step's sound to the second.

### Kit-wide decay range

The whole-kit Decay trim is a multiplier, not a percentage, by design: `kitDecayFromSlider(v) = v ≥ 0 ? 4^(v/100) : 0.05^(-v/100)`, giving a 0.05×–4× range, continuous through `v = 0 → 1×` on both sides, with an inverse `kitDecaySliderFromValue(m)` for restoring slider position from a stored multiplier. A multiplicative range was chosen deliberately over a percent-of-fixed-range slider because halving a decay time reads as the same perceptual step regardless of the starting absolute duration — a percentage scale would bunch all musically useful motion into a tiny arc near one end of the slider.

### Quantization & recording engine

`QUANT_VALUES = [16, 24, 32, 40, 48, 64]` (notes-per-beat-quarter × 4, i.e. "1/N"). `slotDuration(tempo, quantN)` gives the duration of one quantize slot; `quantizedSlot(atTime, barStart, stepDur, tempo, quantN)` snaps any real timestamp onto that grid (anchored at the live scheduler's 16th-note grid origin) and returns `{ stepIndex, offset, time }` — this works for any subdivision ratio, including non-power-of-2 ones like 24, because `stepIndex = floor(sixteenthSlot)` and `offset` is the fractional remainder.

Recording itself (in `ui.js`, not `core.js`, since it's AudioContext-timing-dependent) always snaps a gesture's *first* hit to the nearest 1/16 grid line regardless of the user's chosen fine-quantize setting — so a ratchet group always starts on a sequencer step, truncating/extending by at most half a 16th — then quantizes subsequent hits in that same gesture at the user's chosen finer setting, clamped so a fast sub-hit can never compute a negative offset and wrap into the previous step (a real bug caught and fixed during this build; see Known rough edges).

## UI & interaction layer (`ui.js`)

`ui.js` is a single IIFE, organized into clearly-marked sections (grep for `/* ===== */` and `/* --- */` headers): state, audio, sequencer clock, particle feedback, abstract backdrop, pad drawing, pad input, step tiles, drum engine editor, step lanes, hslider factory, dice slider factory, controls wiring, undo/redo, randomizer dice, keyboard, frame loop, and pages/swipe — roughly in that order in the file.

### Gesture system

All pad/step interaction is pointer-event based (`pointerdown`/`pointermove`/`pointerup`, with `setPointerCapture` used for drag reliability). Core gestures: tap a step to toggle it; hold the pad then tap a step to assign the current pad point; hold one or more steps then touch the pad to make them follow the live point; hold one step then tap a different step to copy its sound (both the source and target are marked `consumed` on this gesture so neither toggles off on release — a bugfix from earlier in this build). A live pad-hold-and-retrigger loop (`startPadHold`/`stopPadHold`, a `setInterval` at the current quantize-slot duration) fires sounds continuously while the pad is held, even when the sequencer is stopped, and feeds into recording when active.

### Quantized recording glue

`audition(x, y, kind)` is called on every genuine new pad touch/drag and is the hook point for recording: on gesture start it snaps to the nearest 1/16 and records that as the step's primary hit; subsequent touches in the same gesture are quantized at the user's chosen fine setting and appended as ratchets (see previous section for the underlying math in `core.js`).

### Custom widgets

Native `<input type=range>` was replaced throughout with a hand-built `.hslider` component (`createHSlider`): a draggable rectangular track with the parameter name left-aligned inside it and the live value right-aligned, supporting click-to-jump, drag, and arrow-key nudging, with `role="slider"` + `aria-value*` for accessibility. A second widget, `createDiceSlider`, drives the three randomizer "dice" controls (sequence/drum/kit): drag or tap sets a 0–1 strength, and releasing fires the randomization once and eases the die back to its resting position via CSS transition.

### Undo/redo

A `history` object snapshots the full editable state (all step data including ratchets, all 14 anchors' parameters, kit trims, tempo, swing, quantize setting, mono/choke flag) on every gesture-end point (pointer-up on pad/step/lane, slider release, Clear/reset/dice-roll clicks) — never mid-drag. Restoring a snapshot writes the state back and explicitly re-syncs every slider widget's visual position, since the widgets hold their own rendered state separately from the model. Capped at 60 entries; Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z are wired via a `keydown` listener.

### Particle feedback & pad/backdrop rendering

A lightweight particle system renders a brief visual burst on each triggered hit (color/size/decay derived from `voiceSignature(P)`, which maps synth parameters to visual properties), plus an "abstract backdrop" ambient rendering behind the pad. Both are Canvas2D, driven by a `requestAnimationFrame` loop that only redraws when dirty flags are set (`dirty`/`stepsDirty`/`laneDirty`, etc.) — a cheap, manual dirty-tracking scheme rather than a reactive framework.

### Step lanes

A single canvas with a tab switcher (`LANES` config: probability, X-deviation, Y-deviation, decay-deviation) rather than four independently-foldable lane views — this was an explicit, communicated scope simplification versus a literal "foldable lanes" ask, given effort constraints. Drag-to-paint editing locks onto a row on pointerdown (`laneDrag = { pointerId, rowIndex }`) so a drag doesn't jump between rows.

### 5-page navigation + swipe

The app is split into 5 pages (`pad`, `lanes`, `kit`, `engine`, `info`), each a `<section class="page">` toggled via a `.active` CSS class, with an icon nav bar and left/right swipe gesture support on top. Swiping is pointer-tracked on the `#pages` container; a gesture is skipped as a swipe candidate if it starts on any interactive control (pad, step, slider, dice track, canvas, button, select, input) so dragging a slider or the pad never gets hijacked as a page-swipe. `setPointerCapture` is used here too, specifically because a swipe's `pointerup` can land outside `#pages`'s bounding box after a long drag — without capture, that `pointerup` silently never fires on the container at all.

### What's intentionally *not* a separate layer

There's no view-model or state-management library; `ui.js` reads and writes `core.js` objects (`seq`, `ANCHORS[i].p`, `trims`) directly and triggers redraws via a handful of boolean dirty flags. This is fine for a single-screen prototype but is **not** a pattern to port as-is — a SwiftUI port should introduce proper observable state (`@Observable`/`ObservableObject`) wrapping equivalents of `Sequence` and the anchor parameter set, rather than replicating manual dirty-flag Canvas redraws.

## iOS port recommendations

### Suggested stack

- **UI**: SwiftUI, for the pad, step grid, sliders, pages, and lanes. The pad and step-grid rendering are good candidates for `Canvas` (SwiftUI's immediate-mode drawing view, the closest analog to the Canvas2D code in `ui.js`); the custom hslider/dice widgets are straightforward to rebuild as native SwiftUI views with `DragGesture` rather than ported pixel-for-pixel.
- **Audio**: `AVAudioEngine` with a graph of `AVAudioSourceNode`s (for oscillator/noise generation) feeding `AVAudioUnitEQ` (for the hp/lp/resonant filtering) and a custom `AVAudioUnitEffect`/Audio Unit (for the waveshaper/distortion curve) — or, if development speed matters more than full control, consider **AudioKit**, a Swift audio synthesis library that already provides oscillator, noise, and filter nodes with a more Web-Audio-like node-graph API; it would significantly shorten the `playVoice` port at some cost in low-level control over envelope timing precision.
- **Scheduling**: Web Audio's sample-accurate parameter automation (`setValueAtTime` etc.) does not have a drop-in `AVAudioEngine` equivalent. The two realistic approaches are (a) render each voice's envelope by writing directly into an `AVAudioSourceNode`'s render block sample-by-sample (most faithful, more work), or (b) drive a small number of exposed parameters (amplitude, filter cutoff) via `AUParameter` automation on a custom Audio Unit and accept slightly coarser timing. Given the drum hits are short (tens to low-hundreds of ms), sample-accurate rendering in the source-node render block is likely the better fidelity match for the sound here.

### Concept-by-concept mapping

| Web Audio / JS concept | iOS equivalent |
| --- | --- |
| `AudioContext` | `AVAudioEngine` |
| `OscillatorNode` (sine/square) | `AVAudioSourceNode` rendering a sine/square waveform in its render block, or AudioKit `Oscillator` |
| White-noise buffer (`makeNoise`) | Pre-filled `AVAudioPCMBuffer`, or an `AVAudioSourceNode` generating noise on the fly |
| `BiquadFilterNode` (hp/lp/resonant) | `AVAudioUnitEQ` band, or a hand-rolled biquad in the render block for exact coefficient parity |
| `WaveShaperNode` (tanh curve) | Custom Audio Unit applying the same lookup curve, or recompute `tanh` inline in a render block |
| `GainNode` + `AudioParam` automation | Either `AUParameter` ramps, or amplitude baked directly into the render-block sample loop (recommended for the short envelopes here) |
| `DynamicsCompressorNode` | `AVAudioUnitEffect` wrapping Apple's dynamics processor, or omit initially and revisit if clipping is audible |
| Gaussian pad-blend math (`weightsAt`/`paramsAt`) | Pure Swift struct/function, ports near-verbatim |
| `Sequence` class + scheduler | Pure Swift model class/struct; the lookahead-scheduling pattern (schedule slightly ahead of real time, as `ui.js`'s clock does) should be kept — it's what makes timing robust against UI-thread hiccups |
| Pointer events (`pointerdown`/move/up) | `DragGesture`/`UIGestureRecognizer`, mapped to the same press/hold/drag state machine described above |
| Canvas2D pad/lane rendering | SwiftUI `Canvas`, or `CAShapeLayer`/Core Graphics if more control is needed |
| `requestAnimationFrame` + dirty flags | `CADisplayLink`-driven redraw, or let SwiftUI's own diffing handle it once state is `@Observable` (preferred — don't reproduce manual dirty flags) |
| `localStorage` (currently unused for persistence) | No prototype equivalent exists yet; see Known rough edges — this needs a new design for the native app (likely a saved-kit/pattern file format) |

### Suggested build order

1. Port the pure math first (anchor data, `weightsAt`/`paramsAt`, decay/quantize formulas) as plain Swift with unit tests mirroring the existing Node tests — this is low-risk and validates quickly without touching audio or UI at all.
2. Build a minimal `AVAudioEngine` voice-trigger path for one or two anchors (e.g. kick + hat) and confirm the sound and envelope shaping match the web version by ear/waveform comparison before porting all 14 anchors and the full 18-parameter model.
3. Build the pad + step grid UI against the ported model, wiring gestures incrementally (tap, then hold-assign, then copy-by-tap, then ratchets) rather than all at once.
4. Port quantized recording, undo/redo, and the lane system last — they depend on the gesture system being solid first.

### Open design questions for the port (not resolved in the web prototype)

- **Persistence**: the web prototype has no save/load for kits or patterns beyond the single built-in `DEMO_BEAT`. An iOS app will presumably need this (Core Data, a JSON file format, or iCloud sync) — worth deciding early since it affects how `Sequence`/`ANCHORS` state is modeled.
- **Audio export/sharing**: not present in the prototype; if wanted on iOS, factor the `AVAudioEngine` graph to support offline rendering (`AVAudioEngine`'s manual-rendering mode) from the start rather than retrofitting it.
- **Background audio / interruption handling**: iOS audio session management (route changes, interruptions from calls/alarms) has no web equivalent to port from and needs native design from scratch.

## Known rough edges & bugs fixed during this build

Worth knowing about because they're exactly the kind of thing a port can silently reintroduce if the underlying reasoning isn't carried over, not just the final code:

- **Mono/choke timing**: silencing other voices must be scheduled at the *new* voice's start time `t`, not at "now" (`ctx.currentTime`). Scheduling at "now" silenced every voice the instant the next hit was merely *scheduled* (which can be \~100ms+ ahead of when it actually sounds, under lookahead scheduling), truncating nearly every step. Any native scheduling model with a similar lookahead buffer needs the equivalent care.
- **Ratchet quantization wrap-around**: quantizing a fast sub-hit relative to a snapped-forward gesture-start time can compute a negative relative offset and wrap into the *previous* step if not clamped (`safeNow = max(now, anchorTime)` before quantizing). Any reimplementation of quantized recording needs this clamp.
- **Full step deletion vs. soft toggle-off**: deleting a step must fully reset its stored state (position, ratchets, lane values), not just flip an `on` flag — otherwise a re-enabled step silently resurrects a stale sound/ratchet pattern, which users found confusing.
- **Audio testing tooling gap**: the `node-web-audio-api` npm package's `OfflineAudioContext` produces garbage output specifically when `gain.cancelScheduledValues()` is combined with prior automation curves on the same parameter. This is a limitation of that particular (immature) Node binding, not a real Web Audio bug — real-browser testing (Playwright/Chromium) was used instead for anything touching `cancelScheduledValues`. Not directly relevant on iOS, but worth knowing the mono-choke fix above was verified in a real browser, not Node, so treat its exact timing behavior as the source of truth rather than any Node-based reproduction that might exist in test scripts.

## Deliberate simplifications (scope, not bugs)

- **Step lanes page**: shares one canvas with a tab switcher (probability/X-dev/Y-dev/decay-dev) rather than four independently foldable lane views. A true multi-lane fold would need the single-canvas rendering/drag logic refactored into a reusable per-lane component — reasonable to build properly on iOS from the start rather than carrying over the tab-switcher shortcut.
- **No persistence, no audio export, no multi-instrument/track support**: the prototype is a single drum voice with one pattern in memory; see the "Open design questions" above.

## Deferred / discussed-but-not-built ideas

These were raised and discussed with the user as future directions but intentionally **not implemented** in the web prototype — worth surfacing to whoever scopes the iOS app's roadmap, since they represent already-considered next steps rather than new ideas:

- Per-drum drive/distortion/wavefolding as a distinct, more aggressive sound-design control (beyond the current shared waveshaper-based drive).
- Expanded synthesis types — FM synthesis and lightweight physical modeling were discussed as directions for more aggressive/expressive drum timbres, with a suggested build order (navigation/UI first, then these) that the user explicitly endorsed.
- A multi-instrument/multi-track architecture (currently Pixy is strictly single-voice-at-a-time per pad/sequence) — discussed only at a conceptual level, not designed in detail.

## File manifest

All under `/home/claude/pixy/` in the web-prototype build environment:

| File | What it is |
| --- | --- |
| `core.js` | Pure synthesis + data model logic (anchors, blending, `playVoice`, `Engine`, `Sequence`). Start here — it's the most portable piece and the best place to pull exact constants (anchor positions/params, `METAL_RATIOS`, `SIGMA`, `QUANT_VALUES`, decay formulas) from. |
| `ui.js` | All DOM/Canvas/gesture/widget code. Read for exact gesture-state-machine behavior and the quantized-recording glue, not for code to port verbatim. |
| `template.html` | CSS + DOM shell. Useful mainly as a reference for exact visual styling (colors, spacing, the 5-page layout) if visual parity matters. |
| `build.py` | 3-line concatenation script; not relevant to the iOS port beyond explaining why `core.js`/`ui.js` are separate files that combine into one HTML file. |
| `pixy.html` | The built, runnable prototype — open this in a browser to see and hear the actual current behavior before porting anything. This is the most reliable ground truth when this document and the code disagree. |

When in doubt about exact current behavior (an envelope shape, a slider's exact range, a gesture's precise timing threshold), treat `pixy.html`/`core.js`/`ui.js` as authoritative over this document's prose — this handoff describes the architecture and reasoning, but exact constants should be read from source.

## Testing methodology reference

For the Swift port, the same two-tier approach that worked here is worth carrying over:

- **Pure logic** (anchor blending, decay/quantize formulas, step-deletion behavior): unit-testable in isolation with no audio or UI involved, the same way `core.js` was tested directly with Node scripts requiring it and asserting on `quantizedSlot`, `kitDecayFromSlider`/`kitDecaySliderFromValue`, and the gesture-state logic in `Sequence`. In Swift this is ordinary `XCTest` on the ported model types — do this first, before any audio engine work, since it's cheap to get right early and expensive to debug later through audio symptoms.
- **Audio correctness**: be skeptical of any immature or indirect test harness for complex parameter-automation timing (this build hit a real bug in the `node-web-audio-api` package's handling of `cancelScheduledValues`, which gave confidently-wrong results). On iOS, prefer testing actual rendered audio — either real-device/simulator playback checked by ear, or offline rendering via `AVAudioEngine`'s manual-rendering mode with assertions on the resulting buffer (RMS, zero-crossings, envelope shape) — over trusting a mocked or lightly-implemented audio graph.
- **Interaction/gesture testing**: the web build relied heavily on direct interactive testing (Playwright driving real Chromium) to catch timing- and pointer-capture-related bugs that pure unit tests couldn't reach (e.g. the swipe-pointerup-outside-bounds bug, the mono-choke timing bug). On iOS, UI tests (`XCUITest`) or manual device testing for gesture edge cases (fast ratchet entry, swipe-while-dragging-a-slider, hold-and-copy) play the same role — don't assume the gesture state machine is correct just because it compiles and the unit tests on the model pass.
