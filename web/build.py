#!/usr/bin/env python3
"""Splice core.js and ui.js into template.html -> ../pixy.html, plus
dist/pixy-artifact.html: the same page without the document wrapper
(doctype/html/head/body), which the claude.ai artifact host supplies."""
import re
from pathlib import Path

here = Path(__file__).parent
core = (here / "core.js").read_text().split("\n\n// --- Node export")[0]
ui = (here / "ui.js").read_text().removesuffix("\n")
html = (here / "template.html").read_text().replace("/*CORE*/", core, 1).replace("/*UI*/", ui, 1)
(here.parent / "pixy.html").write_text(html)

# artifact copy: head contents + body contents, minus the charset/viewport
# metas the host's own skeleton already carries
head = re.search(r"<head>(.*)</head>", html, re.S).group(1)
head = re.sub(r'<meta (charset|name="viewport")[^>]*>\n', "", head)
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
(here.parent / "dist").mkdir(exist_ok=True)
(here.parent / "dist" / "pixy-artifact.html").write_text(head.strip() + "\n" + body.strip() + "\n")
