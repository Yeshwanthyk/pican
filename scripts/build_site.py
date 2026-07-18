#!/usr/bin/env python3
"""Assemble the English VitePress source tree from user-docs/en/."""

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "website"
SRC = SITE / "src"
USER_DOCS = ROOT / "user-docs" / "en"
ASSETS = ROOT / "user-docs" / "assets"

HOME_TITLE = "pi-web - Web UI for Pi (Access pi via Remote, Mobile)"
DOC_ORDER = [
    "README",
    "why",
    "install",
    "personal-assistant",
    "keyboard-shortcuts",
    "llm-debug",
    "roadmap",
]


def transform(text: str) -> str:
    text = text.replace("](../assets/", "](/assets/")
    text = re.sub(r"\]\(README\.md#([^)]*)\)", r"](/guide#\1)", text)
    return re.sub(r"\n{3,}", "\n\n", text).lstrip("\n")


def yaml_scalar(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_hero() -> str:
    hero = json.loads((USER_DOCS / "hero.json").read_text())
    lines = [
        "---",
        "layout: home",
        f"title: {yaml_scalar(HOME_TITLE)}",
        "titleTemplate: false",
        "",
        "hero:",
        '  name: "pi-web"',
        f"  text: {yaml_scalar(hero['text'])}",
        f"  tagline: {yaml_scalar(hero['tagline'])}",
        "  actions:",
    ]
    for action in hero["actions"]:
        link = action.get("link") or f"/{action['to']}"
        lines += [
            f"    - theme: {action.get('theme', 'brand')}",
            f"      text: {yaml_scalar(action['text'])}",
            f"      link: {yaml_scalar(link)}",
        ]
    lines += ["", "features:"]
    for feature in hero["features"]:
        lines += [
            f"  - icon: {yaml_scalar(feature['icon'])}",
            f"    title: {yaml_scalar(feature['title'])}",
            f"    details: {yaml_scalar(feature['details'])}",
        ]
    lines += ["---", ""]
    return "\n".join(lines)


def main() -> None:
    if SRC.exists():
        shutil.rmtree(SRC)
    SRC.mkdir(parents=True)

    dest_assets = SRC / "public" / "assets"
    dest_assets.mkdir(parents=True, exist_ok=True)
    for path in ASSETS.glob("*"):
        if path.is_file():
            shutil.copy2(path, dest_assets / path.name)

    (SRC / "index.md").write_text(render_hero())
    for doc in DOC_ORDER:
        name = "guide" if doc == "README" else doc
        text = transform((USER_DOCS / f"{doc}.md").read_text())
        (SRC / f"{name}.md").write_text(text)

    print(f"Assembled English VitePress src at {SRC.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
