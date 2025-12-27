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
- Keine Rechtsberatung. Bei heiklen Fällen: interne Prüfung empfehlen.
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
  return `Brand Voice (verbindlich für Schritt 3, solange kein Konflikt mit Schutz/Zielen):
- Modern, direkt, locker aber professionell. Auf Augenhöhe. Keine Jugend- und keine Behörden-Sprache.
- Kurze klare Sätze. Alltagssprache. Kein Blabla, keine PR-Floskeln.
- Keine Emojis. Keine Gedankenstriche im Satz. Keine „Therapie-Sprache“.
- Fokus auf Verhalten und Wirkung, nicht auf Etiketten für Personen.
- GFK-Struktur erkennbar: Beobachtung, Gefühl, Bedürfnis, Bitte.
- Keine Variantenlisten. Genau eine öffentliche Antwort, optional eine Direktnachricht.`.trim();
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
      required: ["risk", "decision", "violations", "rationale"],
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
      required: ["public_reply", "include_dm", "action"],
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
    lines.push(`Befund: ${s0.violations.join(", ")}.`);
  } else {
    lines.push("Befund: Keine klaren strafbaren Inhalte erkennbar.");
  }
  lines.push(`Empfehlung: ${s0.decision === "sofort_entfernen" ? "Sofort entfernen oder sperren." : "Kann stehen bleiben, weitere Analyse notwendig."}`);
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
    if (dm) {
      lines.push("");
      lines.push("Optionale Direktnachricht an das Mitglied:");
      lines.push(dm);
    }
  }

  lines.push("");
  lines.push(`Empfohlene Moderationsmaßnahme: ${String(s3.action || "").trim()}`.trim());

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
          `Analysiere den folgenden Kommentar strikt nach TAKT und gib das Ergebnis ausschließlich im JSON Schema aus.\n\nKommentar:\n${userText}`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
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
        hint: "Lege netlify/functions/takt_knowledge.json ins Repo. In netlify.toml: [functions].included_files = [\"netlify/functions/takt_knowledge.json\"]. Optional: TAKT_KB_PATH setzen.",
      });
    }

    const snippets = retrieveSnippets(text, 6);
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

    // 2) Render deterministically
    let rendered = renderTAKT(parsed);

    // 3) Validate final text against hard rules, optionally repair once
    let errors = validateRenderedText(rendered);
    if (parsed?.step0?.decision !== "sofort_entfernen" && !rendered.includes("Kein sofortiger Löschbedarf: Weiter mit Schritt 1.")) {
      errors.push("Pflichtsatz fehlt: Kein sofortiger Löschbedarf: Weiter mit Schritt 1.");
    }

    if (errors.length) {
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

      // If still failing, we return the best-effort rendered2 anyway.
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
