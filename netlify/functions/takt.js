/**
 * Netlify Function (CommonJS): /.netlify/functions/takt
 * Request body: { "text": "..." }
 *
 * Fixes the "module is not defined in ES module scope" issue by:
 * - using CommonJS exports (exports.handler)
 * - requiring Node built-ins normally
 * - NOT relying on "type":"module" in package.json
 *
 * Works with OpenAI SDKs that are ESM-only via dynamic import.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_CHARS = 2000;
const MAX_CHARS = Number(process.env.TAKT_MAX_CHARS || DEFAULT_MAX_CHARS);

let KB = null;
let OpenAIClient = null;

function json(statusCode, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    },
    body: JSON.stringify(bodyObj)
  };
}

function resolveKbPath() {
  if (process.env.TAKT_KB_PATH) return process.env.TAKT_KB_PATH;

  // In Netlify Functions, __dirname points to the deployed function folder.
  const candidates = [
    path.join(__dirname, "takt_knowledge.json"),
    path.join(process.cwd(), "netlify", "functions", "takt_knowledge.json"),
    path.join(process.cwd(), "netlify/functions/takt_knowledge.json"),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return candidates[0];
}

const KB_PATH = resolveKbPath();

function loadKb() {
  if (KB) return KB;
  const raw = fs.readFileSync(KB_PATH, "utf8");
  KB = JSON.parse(raw);
  return KB;
}

// RAG-light retrieval
const tokenRe = /[A-Za-zÄÖÜäöüß0-9]+/g;

function tokenize(s) {
  return (String(s).match(tokenRe) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
}

function idf(df, N) {
  return Math.log((N + 1) / (df + 1)) + 1;
}

function retrieveSnippets(queryText, topK = 6) {
  const kb = loadKb();
  const qTokens = tokenize(queryText);
  if (qTokens.length === 0) return [];

  const qtf = new Map();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) || 0) + 1);

  const scores = [];
  for (let i = 0; i < kb.chunks.length; i++) {
    const ch = kb.chunks[i];
    const tf = ch.tf || {};
    let score = 0;

    for (const [t, qCount] of qtf.entries()) {
      const dCount = tf[t] || 0;
      if (!dCount) continue;
      const w = idf(kb.df[t] || 0, kb.chunk_count);
      score += (qCount * w) * (dCount * w);
    }

    if (score > 0) scores.push({ i, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK).map(({ i }) => kb.chunks[i]);
}

function buildCoreSystem() {
  return `Du bist Friedrich, Community Eskalations- und Konfliktanalyst (TAKT).
Du arbeitest strikt nach dem verbindlichen Moderations-Regelwerk. Wenn Regeln kollidieren, hat das Regelwerk Vorrang.
Du nutzt immer den 4-Schritte-Workflow TAKT in dieser Reihenfolge: 0 Türsteher, 1 Analyse (Schulz von Thun), 2 Kompass (SIDE), 3 Tonart (GFK).

Wichtig für Website-Betrieb:
- Stelle KEINE Rückfragen.
- Wenn Informationen fehlen, triff die beste plausible Annahme und markiere sie kurz als „Annahme:“.
- Bei kritischen Grenzfällen entscheide selbstständig (z. B. „verwarnen“ oder „sperren“) und begründe kurz.

Sprich konsequent in Wir-Form als Moderationsteam.
Keine Rechtsberatung. Empfiehl bei heiklen Fällen interne Prüfung.
Schreibe klar, kurz, ohne Schachtelsätze. Keine Gedankenstriche.

Nutze exakt diese sichtbaren Überschriften:
„0. Türsteher (Moderationsblick)“
„1. Analyse (Schulz von Thun – Nachricht entschlüsseln)“
„2. Kompass (SIDE Modell – Community-Dynamik)“
„3. Tonart (GFK – Antwortvorschlag)“

Ausgabe-Regeln:
- Wenn kein sofortiger Löschbedarf: schreibe explizit „Kein sofortiger Löschbedarf: Weiter mit Schritt 1.“
- In Schritt 3: liefere genau EINE „Öffentliche Moderatorenantwort:“.
- Eine „Optionale Direktnachricht:“ nur, wenn eine DM klar sinnvoll ist. Liefere dann genau EINE DM.
- In Schritt 3: integriere Norm und gewünschte Botschaft aus Schritt 2 in mindestens einem Satz.
`.trim();
}

function buildStyleSystem() {
  return `Brand Voice (verbindlich für Schritt 3, solange kein Konflikt mit Schutz/Zielen):
- Modern, direkt, locker aber professionell. Auf Augenhöhe. Keine Jugend- und keine Behörden-Sprache.
- Kurze klare Sätze. Alltagssprache. Kein Blabla, keine PR-Floskeln.
- Keine Emojis. Keine Gedankenstriche im Satz. Keine „Therapie-Sprache“.
- Fokus auf Verhalten und Wirkung, nicht auf Etiketten für Personen.
- GFK-Struktur erkennbar: Beobachtung, Gefühl, Bedürfnis, Bitte.
- Keine Variantenlisten. Genau eine öffentliche Antwort, optional eine DM.
`.trim();
}

async function getOpenAI() {
  if (OpenAIClient) return OpenAIClient;

  // Works even if the SDK is ESM-only:
  const mod = await import("openai");
  const OpenAI = mod.default || mod.OpenAI || mod;
  OpenAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return OpenAIClient;
}

exports.handler = async (event) => {
  try {
    if ((event.httpMethod || "").toUpperCase() === "OPTIONS") {
      return json(204, {}, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      });
    }

    if ((event.httpMethod || "").toUpperCase() !== "POST") {
      return json(405, { error: "Nur POST erlaubt." });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const text = String(body.text || "").trim();
    if (!text) return json(400, { error: "Bitte einen Kommentar im Feld „Kommentar“ einfügen." });
    if (text.length > MAX_CHARS) return json(400, { error: `Text zu lang. Maximal ${MAX_CHARS} Zeichen.` });

    if (text.includes("sk-")) {
      return json(400, { error: "Bitte keine Schlüssel oder Zugangsdaten einfügen." });
    }

    if (!process.env.OPENAI_API_KEY) {
      return json(500, { error: "OPENAI_API_KEY fehlt in Netlify Environment Variables." });
    }

    if (!fs.existsSync(KB_PATH)) {
      return json(500, {
        error: "Knowledge-Datei nicht gefunden.",
        kb_path_tried: KB_PATH,
        hint: "Lege netlify/functions/takt_knowledge.json ins Repo. In netlify.toml: [functions].included_files = [\"netlify/functions/takt_knowledge.json\"]. Optional: TAKT_KB_PATH setzen."
      });
    }

    const snippets = retrieveSnippets(text, 6);
    const knowledge = snippets
      .map((s) => `Quelle: ${s.source} | Abschnitt: ${s.title}\n${s.text}`)
      .join("\n\n");

    const client = await getOpenAI();

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: buildCoreSystem() },
        { role: "system", content: buildStyleSystem() },
        { role: "system", content: `WISSENSKONTEXT (Auszüge, nur falls relevant):\n${knowledge}` },
        { role: "user", content: text }
      ],
      max_output_tokens: 650
    });

    return json(200, { output: (r.output_text || "").trim() });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
