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
// Keep retrieval small for frontend latency & consistency.
// Use TAKT_RAG_TOPK=0 to fully disable RAG; otherwise keep it low (recommend 1-3).
const DEFAULT_RAG_TOPK = 3;
const RAG_TOPK_ENV = Number(process.env.TAKT_RAG_TOPK || DEFAULT_RAG_TOPK);
const RAG_TOPK = Math.max(0, Math.min(10, Number.isFinite(RAG_TOPK_ENV) ? RAG_TOPK_ENV : DEFAULT_RAG_TOPK));

// Structured Outputs requires models that support json_schema formatting.
// We default to gpt-4o-mini for reliability.
const DEFAULT_MODEL = process.env.TAKT_MODEL || "gpt-4o-mini";

// Tone profile for Schritt 3 (Brand Voice)
// "klar" = klare Kante, fair erklärt (Default). "vorsichtig" = zurückhaltender, mehr erklärend.
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

function normalizeMode(mode) {
  const m = String(mode || "website").toLowerCase().trim();
  if (m === "analyst" || m === "analyse" || m === "customgpt") return "analyst";
  return "website";
}

function detectPressureSignals(text) {
  const t = String(text || "").toLowerCase();
  // Druck, Einschüchterung, Drohung, Erpressung, Besuch ankündigen, "ich sorge dafür" etc.
  return /(ich\s+sorge\s+dafür|i\s*\'?ll\s+make\s+sure|wir\s+werden\s+sehen|ich\s+komme\s+vorbei|besuche\s+euch|ich\s+finde\s+euch|anzeige|anwalt|klage|erpress|droh|bedroh|einschüchter|doxx|adresse|job|kündig|boykott|alle\s+mitglieder\s+verliert|ihr\s+werdet\s+alle\s+mitglieder\s+verlieren)/i.test(t);
}

function buildCoreSystem({ mode }) {
  const m = normalizeMode(mode);
  // IMPORTANT: Regelwerk rules come first.
  // Website mode: no follow-up questions, best plausible assumption if needed.
  // Analyst mode: may ask one short clarification only for truly critical decision ambiguity.
  return `Du bist Friedrich, Community Eskalations- und Konfliktanalyst (TAKT).
Du arbeitest strikt nach dem verbindlichen Moderations-Regelwerk. Wenn Regeln kollidieren, hat das Regelwerk Vorrang.

Workflow (immer in dieser Reihenfolge):
0 Türsteher (Moderationsblick)
1 Analyse (Schulz von Thun, Vier-Seiten-Modell)
2 Kompass (SIDE Modell)
3 Tonart (GFK)

Betriebsmodus: ${m}.
Website-Betrieb:
- Stelle keine Rückfragen.
- Wenn Informationen fehlen, triff die beste plausible Annahme und markiere sie kurz als „Annahme:“.
- Bei kritischen Grenzfällen entscheide selbstständig und begründe knapp.
Analyst-Betrieb:
- Stelle nur dann eine einzelne Rückfrage, wenn ohne diese Frage eine harte Maßnahme nicht seriös entschieden werden kann.
- Ansonsten wie Website-Betrieb (kurz, klar, entscheidungsfreudig).

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

function buildStyleSystem({ needsFirmness }) {
  const tone = TONE_PROFILE === "vorsichtig" ? "vorsichtig" : "klar";
  const firmness = needsFirmness ? "Fallhinweis: In diesem Kommentar sind Signale von Druck/Einschüchterung erkennbar. Antworte besonders klar: Grenze, Norm, nächster Schritt." : "";
  return `Brand Voice (verbindlich für Schritt 3, solange kein Konflikt mit Schutz/Zielen):
Zielgruppe: erwachsene, digitalaffine Community. Erwartet klare Ansagen statt PR und Standardfloskeln. Keine Jugend- und keine Behörden-Sprache.
Schreibstil:
- Kurze klare Sätze. Alltagssprache. Kein Blabla. Keine PR-Floskeln.
- Keine Emojis. Keine Gedankenstriche im Satz. Keine künstliche Großschreibung.
- Fokus auf Verhalten und Wirkung, nicht auf Etiketten für Personen.
- Keine Gegenangriffe, keine Abwertung der Kritik an sich.
GFK-Logik sichtbar, aber modern:
- Beobachtung: konkret zitieren („In deinem Kommentar steht …“), ohne Bewertung.
- Gefühl/Impact: kurz, alltagstauglich („Man merkt, dass dich das Thema nervt“), keine Therapie-Sprache.
- Bedürfnis: knapp (Respekt, Fairness, Sicherheit, Klarheit).
- Bitte/Grenze: konkret, mit nächstem Schritt.
Klare Kante ohne Drohkulisse (wichtig bei Druck, Einschüchterung, Drohung):
- Grenze klar benennen. Fair erklären.
- Konsequenz ruhig und konkret („Wenn das so weitergeht, löschen wir solche Kommentare und prüfen Einschränkungen.“).
Floskeln vermeiden:
- Vermeide z. B. „Wir verstehen deinen Frust“, „Wir nehmen dein wertvolles Feedback sehr ernst“, „Wir haben vollstes Verständnis“.
- Nutze stattdessen direkte, moderne Alternativen wie: „Man merkt, dass dich das Thema nervt“, „Dein Punkt ist angekommen“, „Aus deiner Sicht wirkt das gerade unfair“.
Formatvorgaben:
- Genau eine öffentliche Moderatorenantwort. Optional eine Direktnachricht nur wenn sinnvoll.
Tonprofil: ${tone}.
${firmness}`.trim();
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
	      // Structured Outputs requires: required must include EVERY key in properties.
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
	      // Structured Outputs requires: required must include EVERY key in properties.
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

  // Regelwerk: Wenn stehen_lassen, muss der Satz exakt vorkommen.
  // Wir checken das im Renderer zusätzlich, aber hier als Sicherheitsnetz.
  return errors;
}

// Brand Voice enforcement for Schritt 3 (public + DM)
const BV_BANNED_WORDS = [
  "befund",
  "gemäß",
  "im rahmen",
  "seitens",
  "hiermit",
  "vorgenommen",
  "in anbetracht",
  "wir verstehen deinen frust",
  "wir nehmen dein feedback sehr ernst",
  "wertvolles feedback",
  "vollstes verständnis",
];

function validateBrandVoiceStep3(data, { needsFirmness } = {}) {
  const errors = [];
  const s3 = (data && data.step3) || {};
  const texts = [String(s3.public_reply || ""), String(s3.dm_reply || "")].join("\n").toLowerCase();

  for (const w of BV_BANNED_WORDS) {
    if (w && texts.includes(w)) {
      errors.push(`Brand Voice: Bitte vermeide Büro-/Floskel-Wortwahl („${w}“).`);
    }
  }

  // Avoid fully quoted replies
  const pub = String(s3.public_reply || "").trim();
  if (/^(["„]).*(["“])$/.test(pub) || /^'.*'$/.test(pub)) {
    errors.push("Brand Voice: Setze komplette Antworten nicht in Anführungszeichen.");
  }

  // Tone: for klar profile, ensure a concrete boundary sentence exists in public reply when
  // (a) risk >= mittel + violations OR (b) external signal indicates pressure/einschüchterung
  const s0 = (data && data.step0) || {};
  const risk = String(s0.risk || "").toLowerCase();
  const hasViol = Array.isArray(s0.violations) && s0.violations.length > 0;
  const wantsKlar = TONE_PROFILE !== "vorsichtig";
  const shouldBeFirm = Boolean(needsFirmness) || (hasViol && (risk === "mittel" || risk === "hoch" || risk === "kritisch"));
  if (wantsKlar && shouldBeFirm) {
    const hasBoundary = /(lassen wir|hat hier keinen platz|geht so nicht|so nicht|grenze)/i.test(pub);
    const hasConsequence = /(wenn.*weiter|wenn.*nochmal|sonst|dann.*löschen|werden wir.*löschen|einschränken|sperren|weitere schritte)/i.test(pub);
    if (!hasBoundary) errors.push("Brand Voice: Bei Verstoß bitte eine klare Grenze in der öffentlichen Antwort formulieren.");
    if (!hasConsequence) errors.push("Brand Voice: Bei Verstoß bitte einen klaren nächsten Schritt bzw. Konsequenzsatz ergänzen.");
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
    lines.push("Kurzcheck: Keine klaren strafbaren Inhalte erkennbar.");
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
	          `Analysiere den folgenden Kommentar strikt nach TAKT und gib das Ergebnis ausschließlich im JSON Schema aus.

Wichtig für das Schema:
- Fülle ALLE Felder.
- Wenn du keine Annahme brauchst, setze step0.assumption auf einen leeren String.
- Wenn include_dm = false, setze step3.dm_reply auf einen leeren String.

Kommentar:
${userText}`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
			// Required by the Responses API for structured outputs
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
	          `Dein vorheriger Output verletzt Format- oder Stilregeln.\n\nFehlerliste:\n- ${validationErrors.join("\n- ")}\n\nKorrigiere ausschließlich Form und Stil. Inhaltliche Aussagen nur wenn zwingend nötig, damit die Regeln erfüllt sind.\nGib wieder ausschließlich JSON im selben Schema aus.\n\nSchema-Hinweise:\n- Fülle ALLE Felder.\n- Wenn du keine Annahme brauchst, setze step0.assumption auf einen leeren String.\n- Wenn include_dm = false, setze step3.dm_reply auf einen leeren String.\n\nVorheriges JSON:\n${JSON.stringify(previousJson)}`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
			// Required by the Responses API for structured outputs
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
    const mode = normalizeMode(body.mode);
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

    // For website UX, keep retrieval small. If you want full determinism, set TAKT_RAG_TOPK=0.
    const effectiveTopK = Math.max(0, Math.min(RAG_TOPK, mode === "website" ? 3 : 6));
    const snippets = effectiveTopK ? retrieveSnippets(text, effectiveTopK) : [];
    const knowledge = snippets
      .map((s) => `Quelle: ${s.source} | Abschnitt: ${s.title}\n${s.text}`)
      .join("\n\n");

    const client = await getOpenAI();

    const needsFirmness = detectPressureSignals(text);
    const systemCore = buildCoreSystem({ mode });
    const systemStyle = buildStyleSystem({ needsFirmness });

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
    errors.push(...validateBrandVoiceStep3(parsed, { needsFirmness }));
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
      const errors2 = [...validateRenderedText(rendered2), ...validateBrandVoiceStep3(parsed2, { needsFirmness })];

      // If still failing, we return the best-effort rendered2 anyway.
      rendered = rendered2;
      errors = errors2;
    }

    return json(200, {
      output: rendered,
      meta: {
        model: DEFAULT_MODEL,
        mode,
        rag_topk_used: effectiveTopK,
        warnings: errors.length ? errors : undefined,
      },
    });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
