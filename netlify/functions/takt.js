/**
 * Netlify Function (CommonJS): /.netlify/functions/takt
 * Endpoint: /.netlify/functions/takt
 * Request body: { "text": "..." }
 *
 * Goal:
 * - Output matches TAKT-Regelwerk headings and Brand Voice consistently.
 * - Exactly ONE public reply; optional ONE DM.
 * - Uses Structured Outputs (JSON Schema) + deterministic server-side rendering.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_CHARS = 2000;
const MAX_CHARS = Number(process.env.TAKT_MAX_CHARS || DEFAULT_MAX_CHARS);
const RAG_TOPK = Math.max(0, Number(process.env.TAKT_RAG_TOPK || 6));

// Tone profile for Step 3 language. Defaults to "klar".
// Allowed values: "klar" | "vorsichtig" (anything else falls back to "klar").
const TONE_PROFILE = String(process.env.TAKT_TONE || "klar").toLowerCase();

// Structured Outputs requires models that support json_schema formatting.
// We default to gpt-4o-mini for reliability.
const DEFAULT_MODEL = process.env.TAKT_MODEL || "gpt-4o-mini";

let KB = null;
let OpenAIClient = null;

function json(statusCode, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
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

// RAG-light retrieval (used only as optional context, not as primary rule source)
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
      score += qCount * w * (dCount * w);
    }

    if (score > 0) scores.push({ i, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK).map(({ i }) => kb.chunks[i]);
}

function buildCoreSystem() {
  // IMPORTANT: Regelwerk rules come first.
  // Website mode: no follow-up questions, best plausible assumption if needed.
  return `Du bist Friedrich, Community Eskalations- und Konfliktanalyst (TAKT).
Du arbeitest strikt nach dem verbindlichen Moderations-Regelwerk. Wenn Regeln kollidieren, hat das Regelwerk Vorrang.

Workflow (immer in dieser Reihenfolge):
0 Türsteher (Moderationsblick)
1 Analyse (Schulz von Thun, Vier-Seiten-Modell)
2 Kompass (SIDE Modell)
3 Tonart (GFK)

Website-Betrieb:
- Stelle keine Rückfragen.
- Wenn Informationen fehlen, triff die beste plausible Annahme und markiere sie kurz als „Annahme:“.
- Bei kritischen Grenzfällen entscheide selbstständig und begründe knapp.

Formalia:
- Sprich konsequent in Wir-Form als Moderationsteam.
- Keine Rechtsberatung.
- Vermeide Behörden- und Prozesssprache wie „wir prüfen Maßnahmen“, „wir leiten Schritte ein“, „im Rahmen unserer Richtlinien“.
- Wenn du einen nächsten Schritt nennen musst, nenne ihn aktiv und konkret (löschen, verwarnen, sperren, einschränken).
- Klar, kurz, keine Schachtelsätze. Keine Gedankenstriche im Satz.

Du nutzt exakt diese sichtbaren Überschriften:
„0. Türsteher (Moderationsblick)“
„1. Analyse (Schulz von Thun – Nachricht entschlüsseln)“
„2. Kompass (SIDE Modell – Community-Dynamik)“
„3. Tonart (GFK – Antwortvorschlag)“

Ausgabe-Regeln:
- Wenn kein sofortiger Löschbedarf: schreibe exakt „Kein sofortiger Löschbedarf: Weiter mit Schritt 1.“
- In Schritt 3: genau eine „Öffentliche Moderatorenantwort:“
- Optional: eine „Optionale Direktnachricht an das Mitglied:“ nur wenn wirklich sinnvoll.
- Zusätzlich in Schritt 3: „Empfohlene Moderationsmaßnahme: …“
- In Schritt 3 muss mindestens ein Satz die relevante Norm und die gewünschte Botschaft aus Schritt 2 enthalten.`.trim();
}

function buildStyleSystem() {
  const tone = TONE_PROFILE === "vorsichtig" ? "vorsichtig" : "klar";
  return `Brand Voice (verbindlich für Schritt 3, solange kein Konflikt mit Schutz/Zielen):
Tonprofil: ${tone}.

Grundstil:
- Modern, direkt, locker aber professionell. Auf Augenhöhe.
- Kurze klare Sätze. Alltagssprache. Kein Blabla. Keine PR-Floskeln.
- Keine Emojis. Keine Gedankenstriche. Keine Therapie- oder Behörden-Sprache.
- Fokus auf Verhalten und Wirkung, nicht auf Etiketten für Personen.

Blacklist (nicht verwenden):
- Befund, Drohanzeige
- prüfen, Prüfung, Maßnahmen ergreifen, Schritte einleiten
- im Rahmen unserer Richtlinien, wir werden das intern prüfen

Bevorzugte Wörter:
- Drohung, Einschüchterungsversuch, Druckversuch (statt „Drohanzeige“)
- Kurzcheck (statt „Befund“)

GFK, aber ohne Lehrerzimmer-Ton:
- Beobachtung: konkret („In deinem Kommentar steht …“).
- Impact statt Pädagogik: „Das setzt uns unter Druck.“ / „Das ist eine Drohung.“
- Bedürfnis: kurz (Respekt, Sicherheit, Fairness).
- Bitte/Grenze: konkret.

Wenn der Kommentar Druck, Einschüchterung oder Drohungen enthält:
- Keine weiche Empathie-Floskel („Man merkt, dass …“).
- Grenze klar in einem Satz.
- Konsequenz ruhig und konkret, aktiv formuliert (löschen, sperren, einschränken). Keine „wir prüfen …“.
 - Nutze ein klares Wenn-Dann: „Wenn du Druck machst oder drohst, löschen wir solche Beiträge und sperren den Account bei Wiederholung.“

Format:
- Genau eine öffentliche Moderatorenantwort (3 bis 6 kurze Sätze).
- Optional eine DM nur, wenn sie wirklich sinnvoll ist.
`.trim();
}

// JSON Schema for Structured Outputs
const TAKT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: { type: "string", enum: ["de"] },
    step0: {
      type: "object",
      additionalProperties: false,
      properties: {
        risk: { type: "string", enum: ["niedrig", "mittel", "hoch", "kritisch"] },
        decision: { type: "string", enum: ["sofort_entfernen", "stehen_lassen"] },
        violations: {
          type: "array",
          maxItems: 6,
          items: { type: "string" },
        },
        rationale: { type: "string" },
        assumption: { type: "string" },
      },
      // Structured Outputs (strict) requires: required includes EVERY key in properties.
      required: ["risk", "decision", "violations", "rationale", "assumption"],
    },
    step1: {
      type: "object",
      additionalProperties: false,
      properties: {
        sachebene: { type: "string" },
        selbstoffenbarung: { type: "string" },
        beziehungsebene: { type: "string" },
        appell: { type: "string" },
      },
      required: ["sachebene", "selbstoffenbarung", "beziehungsebene", "appell"],
    },
    step2: {
      type: "object",
      additionalProperties: false,
      properties: {
        ingroup_outgroup: { type: "string" },
        normen: { type: "string" },
        botschaft: { type: "string" },
      },
      required: ["ingroup_outgroup", "normen", "botschaft"],
    },
    step3: {
      type: "object",
      additionalProperties: false,
      properties: {
        public_reply: { type: "string" },
        include_dm: { type: "boolean" },
        dm_reply: { type: "string" },
        action: { type: "string" },
      },
      // Structured Outputs (strict) requires: required includes EVERY key in properties.
      required: ["public_reply", "include_dm", "dm_reply", "action"],
    },
  },
  required: ["language", "step0", "step1", "step2", "step3"],
};

async function getOpenAI() {
  if (OpenAIClient) return OpenAIClient;

  // Works even if the SDK is ESM-only:
  const mod = await import("openai");
  const OpenAI = mod.default || mod.OpenAI || mod;
  OpenAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return OpenAIClient;
}

function extractOutputText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  // Fallback: try to find first text block
  try {
    const out = Array.isArray(response.output) ? response.output : [];
    for (const item of out) {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        if (c && c.type === "output_text" && typeof c.text === "string") {
          const t = c.text.trim();
          if (t) return t;
        }
      }
    }
  } catch {}
  return "";
}

function containsEmoji(s) {
  // Heuristic: common emoji ranges
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s);
}

function validateRenderedText(txt) {
  const errors = [];

  const requiredHeadings = [
    "0. Türsteher (Moderationsblick)",
    "1. Analyse (Schulz von Thun – Nachricht entschlüsseln)",
    "2. Kompass (SIDE Modell – Community-Dynamik)",
    "3. Tonart (GFK – Antwortvorschlag)",
  ];

  for (const h of requiredHeadings) {
    if (!txt.includes(h)) errors.push(`Fehlende Überschrift: ${h}`);
  }

  const publicCount = (txt.match(/Öffentliche Moderatorenantwort:/g) || []).length;
  if (publicCount !== 1) errors.push("Schritt 3 muss genau eine öffentliche Moderatorenantwort enthalten.");

  const dmCount = (txt.match(/Optionale Direktnachricht an das Mitglied:/g) || []).length;
  if (dmCount > 1) errors.push("Es darf höchstens eine optionale Direktnachricht geben.");

  if (/[–—]/.test(txt)) errors.push("Gedankenstriche (–/—) sind nicht erlaubt.");
  if (containsEmoji(txt)) errors.push("Emojis sind nicht erlaubt.");

  // Brand-Voice Lint: Büro-/Behördenwörter und passiv-vage Prozesssprache
  const bannedPatterns = [
    /\bBefund\b/i,
    /\bDrohanzeige\b/i,
    /\b(prüfen|Prüfung|geprüft|prüfen\s+wir)\b/i,
    /\bMaßnahmen\s+(ergreifen|einleiten)\b/i,
    /\bSchritte\s+einleiten\b/i,
    /\b(im\s+Rahmen\s+unserer\s+Richtlinien)\b/i,
    /\b(intern\s+prüfen|interne\s+Prüfung)\b/i,
  ];
  for (const re of bannedPatterns) {
    if (re.test(txt)) {
      errors.push("Brand Voice: Büro-/Behördensprache gefunden. Bitte alltagstauglich und aktiv formulieren.");
      break;
    }
  }

  // Semantik-Lint: typische Fehlparaphrase im Druck-/Einschüchterungsfall
  if (/droh\w*\s+.*,?\s*mitglieder\s+zu\s+verlieren/i.test(txt) || /droh\w*\s+mitglieder\s+zu\s+verlieren/i.test(txt)) {
    errors.push("Schritt 3: Formulierung wirkt unlogisch (z. B. ‚du drohst, Mitglieder zu verlieren‘). Bitte direkt zitieren oder korrekt paraphrasieren (‚dass Mitglieder die Gruppe verlassen‘). ");
  }

  const highRisk = /Risiko:\s*(hoch|kritisch)\./i.test(txt);
  if (highRisk) {
    // Bei Drohung/Einschüchterung: kein "Lehrerzimmer"-Empathiesatz
    if (/Man\s+merkt,?\s+dass\s+dich/i.test(txt)) {
      errors.push("Brand Voice: Bei Drohung/Einschüchterung keine weiche Empathie-Floskel („Man merkt ...“).");
    }

    // Bei hohem Risiko muss die Konsequenz konkret sein (aktiv).
    const hasConcreteAction = /(löschen|entfernen|sperren|stummschalten|einschränken|verwarnen)/i.test(txt);
    if (!hasConcreteAction) {
      errors.push("Schritt 3: Bei hohem/kritischem Risiko muss die Konsequenz aktiv und konkret benannt werden (löschen, sperren, einschränken...).");
    }
  }

  // Regelwerk: Wenn stehen_lassen, muss der Satz exakt vorkommen.
  // Wir checken das im Renderer zusätzlich, aber hier als Sicherheitsnetz.
  return errors;
}

function renderTAKT(data) {
  const s0 = data.step0 || {};
  const s1 = data.step1 || {};
  const s2 = data.step2 || {};
  const s3 = data.step3 || {};

  const lines = [];

  // 0
  lines.push("0. Türsteher (Moderationsblick)");
  lines.push(`Risiko: ${s0.risk || "mittel"}.`);
  if (Array.isArray(s0.violations) && s0.violations.length) {
    lines.push(`Kurzcheck: ${s0.violations.join(", ")}.`);
  } else {
    lines.push("Kurzcheck: Keine klaren strafbaren Inhalte erkennbar.");
  }
  lines.push(`Empfehlung: ${s0.decision === "sofort_entfernen" ? "Kommentar löschen oder Account einschränken." : "Kann stehen bleiben. Weiter analysieren."}`);
  lines.push(`Begründung: ${String(s0.rationale || "").trim()}`.trim());

  if (s0.assumption && String(s0.assumption).trim()) {
    lines.push(`Annahme: ${String(s0.assumption).trim()}`);
  }

  if (s0.decision !== "sofort_entfernen") {
    lines.push("Kein sofortiger Löschbedarf: Weiter mit Schritt 1.");
  }

  lines.push("");

  // 1
  lines.push("1. Analyse (Schulz von Thun – Nachricht entschlüsseln)");
  lines.push(`Sachebene: ${String(s1.sachebene || "").trim()}`.trim());
  lines.push(`Selbstoffenbarung: ${String(s1.selbstoffenbarung || "").trim()}`.trim());
  lines.push(`Beziehungsebene: ${String(s1.beziehungsebene || "").trim()}`.trim());
  lines.push(`Appell: ${String(s1.appell || "").trim()}`.trim());

  lines.push("");

  // 2
  lines.push("2. Kompass (SIDE Modell – Community-Dynamik)");
  lines.push(`Ingroup / Outgroup (vermutet): ${String(s2.ingroup_outgroup || "").trim()}`.trim());
  lines.push(`Relevante Norm(en): ${String(s2.normen || "").trim()}`.trim());
  lines.push(`Gewünschte Botschaft an die Community: ${String(s2.botschaft || "").trim()}`.trim());

  lines.push("");

  // 3
  lines.push("3. Tonart (GFK – Antwortvorschlag)");
  lines.push("Öffentliche Moderatorenantwort:");
  lines.push(String(s3.public_reply || "").trim());

  if (s3.include_dm) {
    const dm = String(s3.dm_reply || "").trim();
    lines.push("");
    lines.push("Optionale Direktnachricht an das Mitglied:");
    lines.push(dm || "Keine Direktnachricht empfohlen.");
  }

  lines.push("");
  lines.push(`Empfohlene Moderationsmaßnahme: ${String(s3.action || "").trim()}`.trim());

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function shortenOneOrTwoSentences(s, maxLen = 170) {
  const t = String(s || "").trim();
  if (!t) return "";
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (!p.trim()) continue;
    out.push(p.trim());
    if (out.join(" ").length >= maxLen || out.length >= 2) break;
  }
  let joined = out.join(" ");
  if (joined.length > maxLen) joined = joined.slice(0, maxLen - 1).trimEnd() + "…";
  return joined;
}

function extractQuoteSnippet(originalText, maxLen = 120) {
  const t = String(originalText || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const snippet = t.length > maxLen ? t.slice(0, maxLen).trimEnd() + "…" : t;
  return snippet.replace(/\n/g, " ");
}

function isCoercionOrThreat(originalText) {
  const t = String(originalText || "").toLowerCase();
  return (
    /\bsonst\b/.test(t) ||
    /ich\s+sorge\s+dafür/.test(t) ||
    /mitglieder\s+verlier/.test(t) ||
    /\bdroh/.test(t) ||
    /\berpress/.test(t) ||
    /\bunter\s+druck\b/.test(t)
  );
}

function enforceStep3ForClarity(parsed, originalText) {
  if (!parsed || !parsed.step3 || !parsed.step0 || !parsed.step2) return parsed;

  const risk = String(parsed.step0.risk || "").toLowerCase();
  const high = risk === "hoch" || risk === "kritisch";
  const coercion = isCoercionOrThreat(originalText);

  // Only hard-enforce for high-risk coercion/threat cases.
  if (!(high && coercion)) return parsed;

  const quote = extractQuoteSnippet(originalText);
  const norm = shortenOneOrTwoSentences(parsed.step2.normen, 140);
  const msg = shortenOneOrTwoSentences(parsed.step2.botschaft, 140);

  const publicLines = [];
  if (quote) publicLines.push(`Du schreibst: „${quote}“.`);
  publicLines.push("Das ist ein Druckversuch und so läuft das hier nicht.");
  if (norm || msg) {
    const pieces = [];
    if (norm) pieces.push(`Hier gilt: ${norm}`);
    if (msg) pieces.push(msg);
    publicLines.push(pieces.join(" ").replace(/\s+/g, " ").trim());
  } else {
    publicLines.push("Bitte bleib respektvoll und ohne Drohungen.");
  }
  publicLines.push("Formuliere deinen Punkt ohne Druck oder Drohungen, dann bleiben wir im Gespräch.");
  publicLines.push("Wenn du weiter drohst oder Druck machst, löschen wir solche Beiträge und sperren den Account bei Wiederholung.");

  const dmLines = [];
  dmLines.push("Hi, kurz direkt: Dein Kommentar war ein Druckversuch.");
  dmLines.push("Bitte formuliere ohne Drohungen. Sonst löschen wir und sperren bei Wiederholung.");
  dmLines.push("Wenn du dein Anliegen sachlich schreibst, schauen wir drauf.");

  parsed.step3.public_reply = publicLines.join(" ");
  parsed.step3.include_dm = true;
  parsed.step3.dm_reply = dmLines.join(" ");

  // Also enforce a concrete action if the model gave something vague.
  if (!/(löschen|entfernen|sperren|einschränken|verwarnen)/i.test(String(parsed.step3.action || ""))) {
    parsed.step3.action = "Kommentar löschen. Bei Wiederholung verwarnen oder sperren.";
  }

  return parsed;
}

async function createStructuredTAKT(client, { systemCore, systemStyle, knowledge, userText }) {
  const r = await client.responses.create({
    model: DEFAULT_MODEL,
    input: [
      { role: "system", content: systemCore },
      { role: "system", content: systemStyle },
      { role: "system", content: `WISSENSKONTEXT (Auszüge, nur falls relevant):\n${knowledge}` },
      {
        role: "user",
        content:
          `Analysiere den folgenden Kommentar strikt nach TAKT und gib das Ergebnis ausschließlich im JSON Schema aus.

Wichtig:
- Fülle ALLE Felder.
- Nutze alltagstaugliche Wörter (z. B. „Drohung“ statt „Drohanzeige“).
- Bei Drohung/Einschüchterung: keine weiche Empathie-Floskel. Nenne eine klare Grenze und eine konkrete Konsequenz (löschen, sperren, einschränken).
- Wenn du keine Annahme brauchst, setze step0.assumption auf einen leeren String.
- Wenn include_dm = false, setze step3.dm_reply auf einen leeren String.

Kommentar:
${userText}`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "takt_output",
        strict: true,
        schema: TAKT_SCHEMA,
      },
    },
    max_output_tokens: 800,
  });

  return r;
}

async function repairIfNeeded(client, { systemCore, systemStyle, knowledge, userText, previousJson, validationErrors }) {
  const r = await client.responses.create({
    model: DEFAULT_MODEL,
    input: [
      { role: "system", content: systemCore },
      { role: "system", content: systemStyle },
      { role: "system", content: `WISSENSKONTEXT (Auszüge, nur falls relevant):\n${knowledge}` },
      {
        role: "user",
        content:
          `Dein vorheriger Output verletzt Format- oder Stilregeln.\n\nFehlerliste:\n- ${validationErrors.join("\n- ")}\n\nKorrigiere ausschließlich Form und Stil. Inhaltliche Aussagen nur wenn zwingend nötig, damit die Regeln erfüllt sind.\nGib wieder ausschließlich JSON im selben Schema aus.\n\nVorheriges JSON:\n${JSON.stringify(previousJson)}`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "takt_output",
        strict: true,
        schema: TAKT_SCHEMA,
      },
    },
    max_output_tokens: 800,
  });

  return r;
}

exports.handler = async (event) => {
  try {
    if ((event.httpMethod || "").toUpperCase() === "OPTIONS") {
      return json(204, {}, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
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

    const text = String(body.text || body.Kommentar || body.kommentar || "").trim();
    if (!text) return json(400, { error: "Bitte Text im Feld \"text\" (oder \"Kommentar\") senden." });
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
        hint: "Lege netlify/functions/takt_knowledge.json ins Repo. In netlify.toml: [functions].included_files = [\"netlify/functions/takt_knowledge.json\"]. Optional: TAKT_KB_PATH setzen.",
      });
    }

    const snippets = RAG_TOPK ? retrieveSnippets(text, RAG_TOPK) : [];
    const knowledge = snippets
      .map((s) => `Quelle: ${s.source} | Abschnitt: ${s.title}\n${s.text}`)
      .join("\n\n");

    const client = await getOpenAI();

    const systemCore = buildCoreSystem();
    const systemStyle = buildStyleSystem();

    // 1) Structured output -> parse JSON
    let r = await createStructuredTAKT(client, {
      systemCore,
      systemStyle,
      knowledge,
      userText: text,
    });

    let raw = extractOutputText(r);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // If parsing fails (should be rare with json_schema), do one repair pass.
      r = await createStructuredTAKT(client, {
        systemCore,
        systemStyle,
        knowledge,
        userText: `Gib ausschließlich gültiges JSON gemäß Schema aus.\n\n${text}`,
      });
      raw = extractOutputText(r);
      parsed = JSON.parse(raw);
    }

    // 2) Enforce "Klare Kante" for coercion/threat cases (deterministic, like CustomGPT consistency)
    parsed = enforceStep3ForClarity(parsed, text);

    // 3) Render deterministically
    let rendered = renderTAKT(parsed);

    // 4) Validate final text against hard rules, optionally repair
    let errors = validateRenderedText(rendered);
    if (parsed?.step0?.decision !== "sofort_entfernen" && !rendered.includes("Kein sofortiger Löschbedarf: Weiter mit Schritt 1.")) {
      errors.push("Pflichtsatz fehlt: Kein sofortiger Löschbedarf: Weiter mit Schritt 1.");
    }

    // Quality Gate: up to two targeted repair passes (keeps Frontend fast, but stabilizes Brand Voice).
    let attempts = 0;
    while (errors.length && attempts < 2) {
      attempts += 1;
      const r2 = await repairIfNeeded(client, {
        systemCore,
        systemStyle,
        knowledge,
        userText: text,
        previousJson: parsed,
        validationErrors: errors,
      });
      const raw2 = extractOutputText(r2);
      const parsed2 = JSON.parse(raw2);
      const rendered2 = renderTAKT(parsed2);
      const errors2 = validateRenderedText(rendered2);

      parsed = parsed2;
      rendered = rendered2;
      errors = errors2;
    }

    return json(200, {
      output: rendered,
      meta: {
        model: DEFAULT_MODEL,
        warnings: errors.length ? errors : undefined,
      },
    });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
