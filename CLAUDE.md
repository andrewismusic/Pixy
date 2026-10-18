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
- Resonator exciter sources must outlive the ring: Chromium stops processing a biquad ~0.28 s after its input source ends.
- New synth params default in `BASE` so the original 14 anchors render byte-identically; check with an offline render before/after.

## Design rules (template.html)

- Look: sci-fi instrument panel, not cartoon. No halftone, chromatic aberration or comic effects; the pad has no readouts or overlays.
- Yellow (`--hold`) = on / selected / highlighted (toggles, active page and tab, playing, touched knob, held step). Cyan (`--now`) = the playhead. Red (`--rec`) = recording.
- Sound colours (`voiceSignature` hue, orange -> pink -> violet) stay clear of yellow and cyan.
- Raised controls use `.cap` and sink when pressed or on; knob arcs take their colour from the module accent (`--m-*`).
- Check both light and dark themes, at phone width (430px).
- No explanatory text at the top of pages, and no boxes around pages or engine sections.
- `design/style-board.html` is the working style board (artifact https://claude.ai/artifact/8KpJmX9YTn1KA2oiTf6vxX); the space direction there isn't in the app yet.
