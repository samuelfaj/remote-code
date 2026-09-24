#!/usr/bin/env python3
"""Check local links in the current RemoteCode plan and README."""

import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        for name in ("href", "src"):
            if attrs.get(name):
                self.links.append(attrs[name])


pages = {}
for path in (ROOT / "plan").glob("*.html"):
    page = Page()
    page.feed(path.read_text())
    pages[path.resolve()] = page

errors = []
sources = [(ROOT / "README.md", re.findall(r"\]\(([^)]+)\)", (ROOT / "README.md").read_text()))]
sources += [(path, page.links) for path, page in pages.items()]

for source, links in sources:
    for link in links:
        parsed = urlsplit(link)
        if parsed.scheme or parsed.netloc:
            continue
        target = (source.parent / unquote(parsed.path)).resolve() if parsed.path else source
        if not target.exists():
            errors.append(f"{source.relative_to(ROOT)}: missing {link}")
        elif parsed.fragment and target in pages and unquote(parsed.fragment) not in pages[target].ids:
            errors.append(f"{source.relative_to(ROOT)}: missing anchor {link}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"Checked local links in README.md and {len(pages)} plan pages")
