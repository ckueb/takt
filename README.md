# TAKT – Friedrich (Netlify + OpenAI Responses API)

TAKT ist ein kleiner Web-Client plus Netlify Function, die Kommentare moderationspraktisch analysiert und einen deeskalierenden Antwortvorschlag erzeugt.
Die KI arbeitet als „Friedrich“ nach dem TAKT-Workflow (0–3) und nutzt eine lokale Wissensbasis, die aus euren Dokumenten generiert wird.

## Projektstruktur

Empfohlene Struktur im Repository:

- index.html
- netlify.toml
- package.json
- README.md
- netlify/
  - functions/
    - takt.js
    - takt_knowledge.json
- tools/
  - build_knowledge.py

Hinweis: Der Endpoint ist fest `/.netlify/functions/takt`. Die Datei muss daher `netlify/functions/takt.js` heißen.

## Setup

### 1) Dependencies installieren

```bash
npm install
```

### 2) Environment Variables (Netlify)

Setze in Netlify unter „Site settings → Environment variables“ mindestens:

- `OPENAI_API_KEY`  
  Dein OpenAI API Key.

Optional:

- `TAKT_MAX_CHARS`  
  Maximale Zeichenlänge für Eingaben. Default: 2000

- `TAKT_KB_PATH`  
  Pfad zur Knowledge-Datei. Normalerweise nicht nötig, wenn `takt_knowledge.json` im gleichen Ordner wie `takt.js` liegt.

Empfehlung für reproduzierbares Runtime-Verhalten:

- `NODE_VERSION` = `18` (oder `20`)

## Wissensbasis (Custom-GPT-Knowledge Ersatz)

Statt „Knowledge“ im Custom GPT wird eine lokale Wissensdatei verwendet:

- `netlify/functions/takt_knowledge.json`

Diese Datei wird aus euren Quellen erzeugt, typischerweise aus:

- regelwerk.docx
- brandvoice.docx
- CM-Eskalations-Konfliktanalyst.docx

### Knowledge neu bauen

Lege die DOCX-Dateien lokal in ein Arbeitsverzeichnis und führe aus:

```bash
python tools/build_knowledge.py regelwerk.docx regelwerk brandvoice.docx brandvoice "CM-Eskalations-Konfliktanalyst .docx" construction netlify/functions/takt_knowledge.json
```

Danach committen und deployen.

## Runtime-Verhalten

### Request

`POST /.netlify/functions/takt`

Body (JSON):

```json
{ "text": "Dein Kommentartext ..." }
```

### Response

```json
{ "output": "..." }
```

## Wichtige inhaltliche Regeln

- Keine Rückfragen an Website-Nutzer. Wenn Informationen fehlen, wird eine plausible Annahme getroffen und kurz als „Annahme:“ markiert.
- Keine Variantenlisten in Schritt 3. Es gibt genau eine öffentliche Moderatorenantwort. Eine DM nur, wenn klar sinnvoll, dann genau eine DM.
- Keine Rechtsberatung. In heiklen Fällen wird zur internen Prüfung geraten.
- Stil: kurze Sätze, keine Schachtelsätze, keine Gedankenstriche, keine Emojis.

## Lokale Entwicklung

Variante A: Netlify CLI (empfohlen)

```bash
npm install -g netlify-cli
netlify dev
```

Variante B: Nur statische Seite testen
- index.html direkt öffnen oder über einen lokalen Server bereitstellen.
- Der KI-Endpoint funktioniert dann nur, wenn die Netlify Function lokal läuft.

## Deployment

1) Änderungen committen
2) Push nach GitHub
3) Netlify deployt automatisch (bei GitHub-Integration)

Achte darauf, dass `takt_knowledge.json` im Deployment enthalten ist (liegt im Functions-Ordner).

## Troubleshooting

### 500 „Server error“
- `OPENAI_API_KEY` fehlt oder ist falsch
- OpenAI-Quota oder Projekt-Berechtigungen
- Knowledge-Datei wird nicht gefunden. Prüfe, ob `takt_knowledge.json` neben `takt.js` liegt

### Antwort ist leer
- Eingabetext ist leer oder nur Leerzeichen
- OpenAI Response ist unerwartet kurz

### Netlify Function wird nicht gefunden
- Pfad stimmt nicht. `netlify.toml` muss `functions = "netlify/functions"` setzen
- Datei muss `netlify/functions/takt.js` heißen
