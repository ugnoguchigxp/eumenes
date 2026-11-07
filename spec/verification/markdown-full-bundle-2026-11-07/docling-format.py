# /// script
# requires-python = ">=3.12"
# dependencies = ["markdown-it-py==4.2.0", "pyyaml==6.0.3"]
# ///
"""Read and execute Desk's pure formatting functions; never import/start its application."""
import ast
import csv
import hashlib
import html
import io
import json
import posixpath
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
import yaml
from markdown_it import MarkdownIt

here = Path(__file__).resolve().parent
source = Path(sys.argv[1]) if len(sys.argv) > 1 else here.parents[3] / "stanley-sites/services/docling-desk/src/docling_desk/knowledge"
functions = {"MarkdownIt": MarkdownIt, "hashlib": hashlib, "html": html, "re": re, "posixpath": posixpath, "parse_qs": parse_qs, "unquote": unquote, "urlencode": urlencode, "urlsplit": urlsplit, "yaml": yaml, "csv": csv, "io": io, "config": SimpleNamespace(url=lambda path: path)}
for filename, names in [("catalog.py", {"evidence_body", "split_frontmatter", "csv_rows"}), ("content.py", {"parse", "render"})]:
    tree = ast.parse((source / filename).read_text())
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(selected) == len(names)
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *selected], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(source / filename), "exec"), functions)
fixture = json.loads((here / "docling-format-input.json").read_text())
body, metadata = functions["split_frontmatter"](fixture["text"])
assert body == fixture["text"] and metadata == {}, "Desk removed data as frontmatter"
rendered = functions["render"](body, "Eumenes", "fixture.md", [], [])
assert "保存の本文" in rendered
assert "eumenes-plate-document" not in rendered, "editor envelope is visible"
assert fixture["payloadPrefix"] not in rendered, "base64 is visible"
evidence = functions["evidence_body"](body)
assert evidence == fixture["markdown"].strip(), "index contains editor metadata or loses body"
result = {"htmlReadable": True, "editorDataHidden": True, "indexIsBodyOnly": True, "frontmatterUntouched": True, "renderer": "Docling Desk content.render + catalog.evidence_body", "sourceSha256": {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in ["content.py", "catalog.py"]}, "renderedHtml": rendered}
(here / "docling-format-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({k: v for k, v in result.items() if k != "renderedHtml"}, ensure_ascii=False))
