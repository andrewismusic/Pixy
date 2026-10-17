# Pixy

A single-voice XY-pad drum synthesizer with a 16-step sequencer. Moving a point around a square pad morphs between 14 synthesized drum "anchors" (kick, snare, hats, clap, cowbell, …); the sequencer records pad gestures, including sub-step ratchets and per-step probability/deviation/decay lanes.

The current build is a web prototype: pure Web Audio + Canvas2D, no dependencies. The plan is a native iOS port; see [`docs/ios-port-handoff.md`](docs/ios-port-handoff.md).

## Running

Open `pixy.html` in a browser. No server needed.

## Layout

| Path | What it is |
| --- | --- |
| `web/core.js` | Synthesis math, anchor blending, `Engine`, `Sequence` model. No DOM. |
| `web/ui.js` | Rendering, gestures, widgets, undo/redo, pages. |
| `web/template.html` | CSS and DOM shell with `/*CORE*/` and `/*UI*/` placeholders. |
| `web/build.py` | Splices the above into `pixy.html`. |
| `web/test/` | Node unit tests for `core.js`. |
| `pixy.html` | Generated, runnable output. Don't edit by hand. |
| `docs/` | Design notes and the iOS port handoff. |

## Developing

```sh
python3 web/build.py               # regenerate pixy.html
node --test web/test/*.test.js     # run core unit tests
```
