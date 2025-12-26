# build_knowledge.py
# Usage: python build_knowledge.py regelwerk.docx brandvoice.docx construction.docx out.json
from docx import Document
import re, json, math, sys

token_re = re.compile(r"[A-Za-zÄÖÜäöüß0-9]+", re.UNICODE)
heading_re = re.compile(r'^(TEIL\s+[A-Z]|[0-9]+\.\s+Schritt|[0-9]+\.\s+|[A-ZÄÖÜ0-9][A-ZÄÖÜ0-9 \-_/]{6,}|<[^>]+>)')

def extract_paragraphs(path):
    doc = Document(path)
    out = []
    for p in doc.paragraphs:
        t = (p.text or "").strip()
        if t:
            out.append(t)
    return out

def chunk(paras, source, max_chars=1400, min_chars=350):
    chunks = []
    cur_title = None
    cur = []
    cur_len = 0

    def flush():
        nonlocal cur, cur_len, cur_title
        if not cur:
            return
        text = "\n".join(cur).strip()
        if len(text) < 120:
            cur = []
            cur_len = 0
            return
        chunks.append({"source": source, "title": cur_title or "Abschnitt", "text": text})
        cur = []
        cur_len = 0

    for t in paras:
        if heading_re.match(t) and len(t) <= 120:
            if cur_len >= min_chars:
                flush()
            cur_title = t
            continue
        cur.append(t)
        cur_len += len(t) + 1
        if cur_len >= max_chars:
            flush()
    flush()
    return chunks

def tokenize(s):
    return [w.lower() for w in token_re.findall(s)]

def main():
    if len(sys.argv) < 5 or (len(sys.argv) - 2) % 2 != 0:
        print("Usage: python build_knowledge.py <doc1> <name1> <doc2> <name2> ... <out.json>")
        sys.exit(1)

    out_path = sys.argv[-1]
    pairs = sys.argv[1:-1]
    chunks = []
    for p in range(0, len(pairs), 2):
        doc_path = pairs[p]
        name = pairs[p+1]
        paras = extract_paragraphs(doc_path)
        chunks.extend(chunk(paras, name))

    df = {}
    tfs = []
    for ch in chunks:
        tf = {}
        for w in tokenize(ch["text"]):
            if len(w) < 3:
                continue
            tf[w] = tf.get(w, 0) + 1
        tfs.append(tf)
        for w in set(tf.keys()):
            df[w] = df.get(w, 0) + 1

    trimmed = []
    for tf in tfs:
        items = sorted(tf.items(), key=lambda x: x[1], reverse=True)[:250]
        trimmed.append(dict(items))

    kb = {
        "chunk_count": len(chunks),
        "df": df,
        "chunks": [{**chunks[i], "tf": trimmed[i]} for i in range(len(chunks))]
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(kb, f, ensure_ascii=False)

    print(f"OK: wrote {out_path} with {len(chunks)} chunks")

if __name__ == "__main__":
    main()
