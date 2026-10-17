# Pixy

XY-pad drum synth + 16-step sequencer. Web prototype now; native iOS (SwiftUI + AVAudioEngine) port planned. Read `docs/ios-port-handoff.md` for architecture and the reasoning behind past bug fixes.

## Workflow

- Edit `web/core.js`, `web/ui.js`, `web/template.html` — never `pixy.html` directly.
- After any edit: `python3 web/build.py` and commit the regenerated `pixy.html` alongside the sources.
- Tests: `node --test web/test/*.test.js`. Add tests for any change to `core.js` logic.
- `core.js` ends with a Node `module.exports` block, introduced by the `// --- Node export` marker; `build.py` cuts at that marker. Keep the marker and add new exports there.
- `core.js` must stay free of DOM/Canvas code; it's the portable model layer.

## Invariants (see handoff "Known rough edges")

- Mono/choke silences other voices at the new voice's start time `t`, not `ctx.currentTime`.
- Recording clamps `safeNow = max(now, anchorTime)` before quantizing ratchets.
- Toggling a step off resets it fully via `freshStep()`.
