/**
 * Netlify Function (CommonJS): /.netlify/functions/takt
 *
 * Ziel:
 * - Output entspricht Regelwerk-Struktur (TAKT) und Brand Voice stabil.
 * - Genau EINE öffentliche Antwort; optional EINE DM (vom System sinnvoll gesetzt).
 * - Structured Outputs (JSON Schema) + deterministisches Rendering + Quality Gate (Lint + Repair).
 *
 * Request body:
 * - { "text": "..." }  (alternativ: "Kommentar" / "kommentar")
 *
 * Env:
 * - OPENAI_API_KEY (required)
 * - TAKT_MODEL (default: gpt-4o-mini)
 * - TAKT_MAX_CHARS (default: 2000)
 * - TAKT_RAG_TOPK (default: 0)  // 0 = kein RAG; 1-3 = leichtes RAG
 * - TAKT_TONE (default: klar)    // klar | vorsichtig
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_MODEL = process.env.TAKT_MODEL || "gpt-4o-mini";
const DEFAULT_MAX_CHARS = 2000;
const MAX_CHARS = Number(process.env.TAKT_MAX_CHARS || DEFAULT_MAX_CHARS);

// Performance/Consistency: default RAG off for Website.
const RAG_TOPK = Math.max(0, Number(process.env.TAKT_RAG_TOPK || 0));

// Tone profile for Step 3 language.
const TONE_PROFILE = String(process.env.TAKT_TONE || "klar").toLowerCase();

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

// ---------- RAG-light (optional) ----------
const tokenRe = /[A-Za-zÄÖÜäöüß0-9]+/g;

function tokenize(s) {
  return (String(s).match(tokenRe) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
}

function idf(df, N) {
  return Math.log((N + 1) / (df + 1)) + 1;
}

function retrieveSnippets(queryText, topK = 3) {
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

// ---------- Prompts ----------
function buildCoreSystem() {
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
- Entscheide auch bei Grenzfällen selbstständig und begründe knapp.

Formalia:
- Sprich konsequent in Wir-Form als Moderationsteam.
- Keine Rechtsberatung.
- Klar, kurz, keine Schachtelsätze. Keine Gedankenstriche im Satz.

Du nutzt exakt diese sichtbaren Überschriften:
„0. Türsteher (Moderationsblick)“
„1. Analyse (Schulz von Thun – Nachricht entschlüsseln)“
„2. Kompass (SIDE Modell – Community-Dynamik)“
„3. Tonart (GFK – Antwortvorschlag)“

Ausgabe-Regeln:
- Wenn kein sofortiger Löschbedarf: schreibe exakt „Kein sofortiger Löschbedarf: Weiter mit Schritt 1.“
- In Schritt 3: genau eine „Öffentliche Moderatorenantwort:“
- Optional: eine „Optionale Direktnachricht an das Mitglied:“ wenn sinnvoll.
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

Floskel-Verbot (Beispiele):
- „Wenn du Hilfe benötigst …“
- „Sprich uns gerne an …“
- „Wir wünschen uns, dass alle …“ (wenn es leer/unkonkret bleibt)

Blacklist (nicht verwenden):
- Befund, Drohanzeige
- prüfen, Prüfung, Maßnahmen ergreifen, Schritte einleiten
- im Rahmen unserer Richtlinien, wir werden das intern prüfen

Bevorzugte Wörter:
- Kurzcheck (statt „Befund“)
- Drohung, Einschüchterungsversuch, Druckversuch (statt „Drohanzeige“)

GFK, aber ohne Lehrerzimmer-Ton:
- Beobachtung: konkret („Du schreibst …“ / direktes Zitat).
- Gefühl/Impact: kurz, passend zur Lage (bei Drohung: „Das setzt uns unter Druck.“).
- Bedürfnis: kurz (Respekt, Sicherheit, Fairness).
- Bitte/Grenze: konkret.

Wenn der Kommentar Druck, Einschüchterung oder Drohungen enthält:
- Keine weiche Empathie-Floskel.
- Grenze klar in einem Satz.
- Konsequenz ruhig und konkret, aktiv formuliert (löschen, sperren, einschränken). Keine „wir prüfen …“.
- Nutze ein klares Wenn-Dann.

Wenn jemand die Community verlassen will:
- Keine generische Support-Antwort.
- Bitte um einen konkreten Punkt (ein Satz reicht).
- Biete eine kurze Direktnachricht an, um Feedback privat zu sammeln.

Format Schritt 3:
- Genau eine öffentliche Moderatorenantwort (3 bis 6 kurze Sätze).
- Optional eine DM (2 bis 4 kurze Sätze), wenn sinnvoll.`.trim();
}

// ---------- JSON Schema (Structured Outputs, strict) ----------
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
        violations: { type: "array", maxItems: 6, items: { type: "string" } },
        rationale: { type: "string" },
        assumption: { type: "string" },
      },
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
      required: ["public_reply", "include_dm", "dm_reply", "action"],
    },
  },
  required: ["language", "step0", "step1", "step2", "step3"],
};

// ---------- OpenAI Client ----------
async function getOpenAI() {
  if (OpenAIClient) return OpenAIClient;

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

// ---------- Rendering + Lint ----------
function containsEmoji(s) {
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

  // Brand-Voice Lint: Büro-/Behördenwörter + leere Support-Floskeln
  const bannedPatterns = [
    /\bBefund\b/i,
    /\bDrohanzeige\b/i,
    /\b(prüfen|Prüfung|geprüft|prüfen\s+wir)\b/i,
    /\bMaßnahmen\s+(ergreifen|einleiten)\b/i,
    /\bSchritte\s+einleiten\b/i,
    /\b(im\s+Rahmen\s+unserer\s+Richtlinien)\b/i,
    /\b(intern\s+prüfen|interne\s+Prüfung)\b/i,
    /\bWenn\s+du\s+Hilfe\s+benötigst\b/i,
    /\bsprich\s+uns\s+gerne\s+an\b/i,
  ];
  for (const re of bannedPatterns) {
    if (re.test(txt)) {
      errors.push("Brand Voice: Büro-/Behördensprache oder generische Floskel gefunden. Bitte alltagstauglich, konkret und aktiv formulieren.");
      break;
    }
  }

  // Semantik-Lint: typische Fehlparaphrase im Droh-Fall
  if (/droh\w*\s+.*mitglieder\s+zu\s+verlieren/i.test(txt)) {
    errors.push("Schritt 3: Formulierung wirkt unlogisch (z. B. ‚du drohst, Mitglieder zu verlieren‘). Bitte korrekt paraphrasieren (‚dass Mitglieder die Gruppe verlassen‘) oder direkt zitieren.");
  }

  const highRisk = /Risiko:\s*(hoch|kritisch)\./i.test(txt);
  if (highRisk) {
    if (/Man\s+merkt,?\s+dass\s+dich/i.test(txt)) {
      errors.push("Brand Voice: Bei Drohung/Einschüchterung keine weiche Empathie-Floskel („Man merkt ...“).");
    }
    const hasConcreteAction = /(löschen|entfernen|sperren|stummschalten|einschränken|verwarnen)/i.test(txt);
    if (!hasConcreteAction) {
      errors.push("Schritt 3: Bei hohem/kritischem Risiko muss die Konsequenz aktiv und konkret benannt werden (löschen, sperren, einschränken...).");
    }
  }

  // Exit-Signal: bitte konkret nach einem Punkt fragen + DM anbieten
  const exitSignal = /\bverlass(e|en|t)\b/i.test(txt) || /\bbin\s+raus\b/i.test(txt) || /\btrete\s+aus\b/i.test(txt);
  if (exitSignal) {
    if (!/Optionale Direktnachricht an das Mitglied:/g.test(txt)) {
      errors.push("Schritt 3: Bei Austrittsankündigung ist eine optionale Direktnachricht sinnvoll. Bitte hinzufügen.");
    }
    const hasConcreteAsk = /\?/.test(txt) && /(was\s+war\s+der\s+punkt|welcher\s+punkt|in\s+einem\s+satz|zwei\s+oder\s+drei\s+punkte)/i.test(txt);
    if (!hasConcreteAsk) {
      errors.push("Schritt 3: Bitte stelle eine konkrete, kurze Frage (z. B. „Was war der Punkt, der es gekippt hat?“).");
    }
  }

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
    lines.push("Kurzcheck: Keine klaren Regelverstöße erkennbar.");
  }
  lines.push(`Empfehlung: ${s0.decision === "sofort_entfernen" ? "Kommentar entfernen oder Account einschränken." : "Kann stehen bleiben. Weiter analysieren."}`);
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

// ---------- Deterministische Step-3-Verbesserungen (CustomGPT-Nähe) ----------
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

function isExitSignal(originalText) {
  const t = String(originalText || "").toLowerCase();
  return (
    /\bverlass(e|en|t)\b/.test(t) ||
    /\bich\s+geh(e|e\s+jetzt)\b/.test(t) ||
    /\bbin\s+raus\b/.test(t) ||
    /\btrete\s+aus\b/.test(t) ||
    /\bcommunity\s+verlass/.test(t)
  );
}

function enforceStep3ForThreat(parsed, originalText) {
  if (!parsed || !parsed.step3 || !parsed.step0 || !parsed.step2) return parsed;

  const risk = String(parsed.step0.risk || "").toLowerCase();
  const high = risk === "hoch" || risk === "kritisch";
  const coercion = isCoercionOrThreat(originalText);

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
  if (!/(löschen|entfernen|sperren|einschränken|verwarnen)/i.test(String(parsed.step3.action || ""))) {
    parsed.step3.action = "sofort_entfernen. Kommentar entfernen. Bei Wiederholung sperren oder einschränken.";
  }

  return parsed;
}

function enforceStep3ForExit(parsed, originalText) {
  if (!parsed || !parsed.step3 || !parsed.step0 || !parsed.step2) return parsed;

  const risk = String(parsed.step0.risk || "").toLowerCase();
  const high = risk === "hoch" || risk === "kritisch";
  if (high) return parsed;
  if (!isExitSignal(originalText)) return parsed;

  const quote = extractQuoteSnippet(originalText);
  const norm = shortenOneOrTwoSentences(parsed.step2.normen, 140);
  const msg = shortenOneOrTwoSentences(parsed.step2.botschaft, 140);

  const publicLines = [];
  if (quote) publicLines.push(`Du schreibst: „${quote}“.`);
  publicLines.push("Das klingt nach einem klaren Cut.");

  const pieces = [];
  if (norm) pieces.push(`Hier gilt: ${norm}`);
  else pieces.push("Kritik ist hier okay, solange sie respektvoll bleibt.");
  if (msg) pieces.push(msg);
  else pieces.push("Uns hilft Kritik am meisten, wenn sie konkret wird.");
  publicLines.push(pieces.join(" ").replace(/\s+/g, " ").trim());

  publicLines.push("Wenn du magst, sag in einem Satz, was für dich der Punkt war, der es gekippt hat.");
  publicLines.push("Wenn du das lieber privat schreibst, schick es uns kurz per Direktnachricht.");

  const dmLines = [];
  dmLines.push("Hi, wir melden uns kurz direkt, weil dein Kommentar nach einem echten Bruch klingt.");
  dmLines.push("Wenn du magst, schreib uns knapp zwei oder drei Punkte, die dich am meisten enttäuscht haben.");
  dmLines.push("Kein Roman. Je konkreter, desto besser können wir daraus etwas verbessern.");

  parsed.step3.public_reply = publicLines.join(" ");
  parsed.step3.include_dm = true;
  parsed.step3.dm_reply = dmLines.join(" ");
  if (!String(parsed.step3.action || "").trim() || /stehen_lassen/i.test(String(parsed.step3.action))) {
    parsed.step3.action = "stehen_lassen. Kurz öffentlich antworten. Optional per DM nach konkreten Punkten fragen. Intern als Feedback markieren.";
  }

  return parsed;
}

// ---------- API Calls ----------
async function createStructuredTAKT(client, { systemCore, systemStyle, knowledge, userText }) {
  const r = await client.responses.create({
    model: DEFAULT_MODEL,
    input: [
      { role: "system", content: systemCore },
      { role: "system", content: systemStyle },
      { role: "system", content: knowledge ? `WISSENSKONTEXT (Auszüge, nur falls relevant):\n${knowledge}` : "WISSENSKONTEXT: (leer)" },
      {
        role: "user",
        content:
          `Analysiere den folgenden Kommentar strikt nach TAKT und gib das Ergebnis ausschließlich im JSON Schema aus.

Wichtig:
- Fülle ALLE Felder.
- Nutze alltagstaugliche Wörter.
- Schritt 1/2: bleib konkret (1–2 Sätze je Feld). Appell auch indirekt erkennen.
- Schritt 3: keine generischen Support-Sätze. Nutze Beobachtung („Du schreibst …“) + konkrete Bitte/Frage.
- Bei Drohung/Einschüchterung: keine weiche Empathie. Klare Grenze + konkrete Konsequenz (löschen, sperren, einschränken).
- Bei Austritt/Abschied: bitte um einen konkreten Punkt und biete eine Direktnachricht an.
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
    max_output_tokens: 850,
  });

  return r;
}

async function repairIfNeeded(client, { systemCore, systemStyle, knowledge, previousJson, validationErrors }) {
  const r = await client.responses.create({
    model: DEFAULT_MODEL,
    input: [
      { role: "system", content: systemCore },
      { role: "system", content: systemStyle },
      { role: "system", content: knowledge ? `WISSENSKONTEXT (Auszüge, nur falls relevant):\n${knowledge}` : "WISSENSKONTEXT: (leer)" },
      {
        role: "user",
        content:
          `Dein vorheriger Output verletzt Format- oder Stilregeln.

Fehlerliste:
- ${validationErrors.join("\n- ")}

Korrigiere ausschließlich Form und Stil. Inhaltliche Aussagen nur wenn zwingend nötig, damit die Regeln erfüllt sind.
Gib wieder ausschließlich JSON im selben Schema aus.

Vorheriges JSON:
${JSON.stringify(previousJson)}`,
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
    max_output_tokens: 850,
  });

  return r;
}

// ---------- Handler ----------
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

    // Knowledge is optional. If the file is missing and RAG_TOPK is 0, we can still run.
    let knowledge = "";
    if (RAG_TOPK > 0) {
      if (!fs.existsSync(KB_PATH)) {
        return json(500, {
          error: "Knowledge-Datei nicht gefunden.",
          kb_path_tried: KB_PATH,
          hint: "Lege netlify/functions/takt_knowledge.json ins Repo. In netlify.toml: included_files = [\"netlify/functions/takt_knowledge.json\"]. Optional: TAKT_KB_PATH setzen.",
        });
      }
      const snippets = retrieveSnippets(text, Math.min(3, RAG_TOPK));
      knowledge = snippets.map((s) => `Quelle: ${s.source} | Abschnitt: ${s.title}\n${s.text}`).join("\n\n");
    }

    const client = await getOpenAI();
    const systemCore = buildCoreSystem();
    const systemStyle = buildStyleSystem();

    // 1) Structured output -> parse JSON
    let r = await createStructuredTAKT(client, { systemCore, systemStyle, knowledge, userText: text });
    let raw = extractOutputText(r);
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      // One retry focused on valid JSON
      r = await createStructuredTAKT(client, { systemCore, systemStyle, knowledge, userText: `Gib ausschließlich gültiges JSON gemäß Schema aus.\n\n${text}` });
      raw = extractOutputText(r);
      parsed = JSON.parse(raw);
    }

    // 2) Deterministic Step-3 upgrades (CustomGPT-Nähe)
    parsed = enforceStep3ForThreat(parsed, text);
    parsed = enforceStep3ForExit(parsed, text);

    // 3) Render deterministically
    let rendered = renderTAKT(parsed);

    // 4) Validate + targeted repair (bis zu 2 Versuche)
    let errors = validateRenderedText(rendered);
    if (parsed?.step0?.decision !== "sofort_entfernen" && !rendered.includes("Kein sofortiger Löschbedarf: Weiter mit Schritt 1.")) {
      errors.push("Pflichtsatz fehlt: Kein sofortiger Löschbedarf: Weiter mit Schritt 1.");
    }

    let attempts = 0;
    while (errors.length && attempts < 2) {
      attempts += 1;
      const r2 = await repairIfNeeded(client, { systemCore, systemStyle, knowledge, previousJson: parsed, validationErrors: errors });
      const raw2 = extractOutputText(r2);
      const parsed2 = JSON.parse(raw2);

      // Re-apply deterministic rules after repair (keeps tone stable)
      let fixed = enforceStep3ForThreat(parsed2, text);
      fixed = enforceStep3ForExit(fixed, text);

      const rendered2 = renderTAKT(fixed);
      const errors2 = validateRenderedText(rendered2);

      parsed = fixed;
      rendered = rendered2;
      errors = errors2;
    }

    return json(200, {
      output: rendered,
      meta: {
        model: DEFAULT_MODEL,
        rag_topk: RAG_TOPK,
        tone: (TONE_PROFILE === "vorsichtig" ? "vorsichtig" : "klar"),
        warnings: errors.length ? errors : undefined,
      },
    });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
