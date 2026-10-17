#!/usr/bin/env python3
"""Splice core.js and ui.js into template.html -> ../pixy.html."""
from pathlib import Path

here = Path(__file__).parent
core = (here / "core.js").read_text().split("\n\n// --- Node export")[0]
ui = (here / "ui.js").read_text().removesuffix("\n")
html = (here / "template.html").read_text().replace("/*CORE*/", core, 1).replace("/*UI*/", ui, 1)
(here.parent / "pixy.html").write_text(html)
