#!/usr/bin/env python3
"""Convert DOCX files to plain text for stable retrieval chunking.

Usage:
  python tools/docx_to_text.py <input_dir> <output_dir>

- Keeps headings/paragraph breaks.
- Adds simple section separators to make chunking more predictable.
"""
import sys
from pathlib import Path

try:
    from docx import Document
except Exception as e:
    print("Missing dependency python-docx. Install with: pip install python-docx", file=sys.stderr)
    raise

def docx_to_txt(src: Path) -> str:
    doc = Document(str(src))
    out_lines = []
    for p in doc.paragraphs:
        text = (p.text or "").strip()
        if not text:
            continue
        # Heuristic: treat short ALLCAPS or numbered headings as headings
        if len(text) <= 80 and (text.isupper() or text[:2].isdigit() or text.startswith(("Schritt", "0.", "1.", "2.", "3."))):
            out_lines.append(f"\n=== {text} ===\n")
        else:
            out_lines.append(text)
    return "\n".join(out_lines).strip() + "\n"

def main():
    if len(sys.argv) != 3:
        print("Usage: python tools/docx_to_text.py <input_dir> <output_dir>", file=sys.stderr)
        sys.exit(2)

    in_dir = Path(sys.argv[1]).resolve()
    out_dir = Path(sys.argv[2]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    docx_files = sorted(in_dir.glob("*.docx"))
    if not docx_files:
        print(f"No .docx files found in {in_dir}", file=sys.stderr)
        sys.exit(1)

    for src in docx_files:
        txt = docx_to_txt(src)
        dest = out_dir / (src.stem.replace(" ", "_") + ".txt")
        dest.write_text(txt, encoding="utf-8")
        print(f"Wrote {dest}")

if __name__ == "__main__":
    main()
