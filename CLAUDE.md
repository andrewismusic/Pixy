# Pixy

XY-pad drum synth + 16-step sequencer. Web prototype now; native iOS (SwiftUI + AVAudioEngine) port planned. Read `docs/ios-port-handoff.md` for architecture and the reasoning behind past bug fixes.

## Workflow

- Edit `web/core.js`, `web/ui.js`, `web/template.html` — never `pixy.html` directly.
- After any edit: `python3 web/build.py` and commit the regenerated `pixy.html` and `dist/pixy-artifact.html` alongside the sources.
- Testing on a phone: publish `dist/pixy-artifact.html` to the private claude.ai artifact https://claude.ai/artifact/Ekz2ozza21qeJ1V8y9JxNq (pass it as `url` from a new session). Opening `pixy.html` from Files or a chat preview doesn't run scripts.
- Tests: `node --test web/test/*.test.js`. Add tests for any change to `core.js` logic.
- `core.js` ends with a Node `module.exports` block, introduced by the `// --- Node export` marker; `build.py` cuts at that marker. Keep the marker and add new exports there.
- `core.js` must stay free of DOM/Canvas code; it's the portable model layer.

## Invariants (see handoff "Known rough edges")

- Mono/choke silences other voices at the new voice's start time `t`, not `ctx.currentTime`.
- Recording is gesture-based: a pad touch or ratchet-bar hold covers a step if it started before that step's catch point (`RATCHET_CATCH`, halfway) and was still held at it. A tap that starts and ends before one catch point still counts for that step (`pendingPress` / `pendingBar`, armed only when a gesture starts).
- Smooth mode (the key beside record) changes only new touches: live pad hits are glide voices that follow the finger, and recorded steps store `auto`, `AUTO_POINTS` positions sampled from that one gesture after the step has passed. Stepped recording clears `auto`.
- `playVoice(..., {glide: true})` builds every layer behind a mix gain so `glide()` can move pitch, filters, layer balance and level; layers silent at the strike ring as long as the longest layer. Without `glide` the voice must render byte-identically to before.
- Ratchet bar values must divide a 16th into whole hits (`RATCHET_VALUES`); a recorded value applies to the whole step.
- Swing is a percentage, 50 (straight) to 75; `swingOffset` turns it into a delay for odd steps.
- While playing, live pad hits are scheduled only `LIVE_AHEAD` (35 ms) ahead so lifting a finger stops them promptly.
- Toggling a step off resets it fully via `freshStep()`.
- Modulation (`MOD_COUNT` = 6): each modulator has one destination and any number of targets (step, drum = hits whose `nearestAnchor` is that drum, or kit). LFOs are read once per hit at the strike; an envelope glides the voice through the hit for destinations in `GLIDE_DESTS` and applies its peak at the strike for the rest. All hits go through `strike()` / `soundAt()` in ui.js.
- Stolen voices are stopped outright (`Engine.silence`), and finished voices disconnect, so dense ratchets don't pile up nodes.
- Resonator exciter sources must outlive the ring: Chromium stops processing a biquad ~0.28 s after its input source ends.
- New synth params default in `BASE` so the original 14 anchors render byte-identically; check with an offline render before/after.

## Design rules (template.html)

- Look: a star chart. The pad is a sky (night console in dark mode, printed star atlas in light); sequenced steps are stars joined in playing order; modulators are moons orbiting the steps they move. No halftone, chromatic aberration, comic effects or readouts on the pad.
- Type: Oxanium for titles (`--font-head`), Chakra Petch for everything else (`--font-ui`), JetBrains Mono for values.
- Yellow (`--hold`) = on / selected / highlighted (toggles, active page and tab, playing, touched knob, held step). Cyan (`--now`) = the playhead. Red (`--rec`) = recording.
- Sound colours follow stellar classes from `voiceSignature(P).t` (ui.js `STAR_NIGHT` / `STAR_DAY` on the sky, the stronger `TILE` on step tiles and lanes); they stay clear of yellow and cyan. The six modulator colours (`MOD_COL`) do too.
- Raised controls use `.cap` and sink when pressed or on; knob arcs take their colour from the module accent (`--m-*`). A knob's cap and shadow stay put; only `.knob-ptr` turns.
- Help is a sheet for the page you're on (`HELP` in ui.js), not a page. Keep it current when a page changes.
- Check both light and dark themes, at phone width (430px).
- No explanatory text at the top of pages, and no boxes around pages or engine sections.
- `design/style-board.html` is the working style board (artifact https://claude.ai/artifact/8KpJmX9YTn1KA2oiTf6vxX).
