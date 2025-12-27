/**
 * Netlify Function (CommonJS): /.netlify/functions/takt
 *
 * Goal: CustomGPT-like consistency without endless prompt fiddling.
 * Approach:
 *  - Use Structured Outputs (json_schema) for steps 0–2 + moderation action.
 *  - Generate Step 3 (public reply + optional DM) deterministically via templates,
 *    based on lightweight scenario detection (exit / threat / critique).
 *  - Keep Brand Voice constraints in templates (no Behörden-/PR-Sprache, no floskeln).
 *
 * Env:
 *  - OPENAI_API_KEY (required)
 *  - TAKT_MODEL (default: gpt-4.1-mini)
 *  - TAKT_RAG_TOPK (default: 0)  // if >0, will attach snippets from takt_knowledge.json
 *  - TAKT_DM_MODE (auto|always|never) default: auto
 */

const fs = require("fs");

let OpenAIClient = null;

async function getOpenAI() {
  if (OpenAIClient) return OpenAIClient;
  const mod = await import("openai");
  const OpenAI = mod.default || mod.OpenAI || mod;
  OpenAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return OpenAIClient;
}

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
    body: body == null ? "" : JSON.stringify(body),
  };
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/** -------- Knowledge (optional) -------- */
function loadKnowledge(path) {
  try {
    const raw = fs.readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function retrieveSnippets(query, topk) {
  if (!topk || topk <= 0) return [];
  const kbPath = process.env.TAKT_KB_PATH || "netlify/functions/takt_knowledge.json";
  const kb = loadKnowledge(kbPath);
  if (!kb || !Array.isArray(kb.chunks)) return [];

  const q = tokenize(query);
  const qset = new Set(q);

  // very small, fast scorer: overlap + precomputed tf-idf (if present)
  const scored = kb.chunks.map((c) => {
    const t = tokenize(c.text);
    let overlap = 0;
    for (const w of t) if (qset.has(w)) overlap += 1;
    const score = overlap;
    return { score, c };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(x => x.score > 0).slice(0, topk).map(x => ({
    source: x.c.source || "knowledge",
    title: x.c.title || "",
    text: x.c.text || ""
  }));
}

/** -------- Brand Voice + Regelwerk distilled (system) -------- */
function buildCoreSystem() {
  return `
Du bist TAKT, ein Online-Moderations- und Deeskalationsassistent.
Du arbeitest praxisnah, deeskalierend, respektvoll und lösungsorientiert.

Pflicht: Ausgabe folgt IMMER dem TAKT-Workflow:
0. Türsteher (Moderationsblick)
1. Analyse (Schulz von Thun)
2. Kompass (SIDE Modell)
3. Tonart (GFK – Antwortvorschlag)

Wichtig:
- Keine Rechtsberatung. Keine juristische Fachsprache. Kein Behörden-Deutsch.
- In Schritt 0 keine Legalismen wie "strafbar". Nutze stattdessen "Regelverstoß" oder "Drohung/Beleidigung".
- Schritt 1 und 2 sind analytisch, aber in normaler Sprache (keine Lehrbuch-Abhandlung).
- Liefere keine Variantenlisten. Genau eine Empfehlung pro Feld.

Du erzeugst STRUCTURED OUTPUT als JSON nach Schema (strict).
  `.trim();
}

function buildStyleSystem() {
  return `
Brand Voice (verbindlich, v. a. für Schritt 3):
- Modern, direkt, locker aber professionell. Auf Augenhöhe.
- Kurze, klare Sätze. Kein Blabla. Keine PR- und keine Standardfloskeln.
- Keine Emojis. Keine Gedankenstriche im Satz.
- Keine Therapie-Sprache oder psychologische Fachbegriffe (z. B. "getriggert").
- Fokus auf Verhalten und Wirkung, nicht auf Abwertung von Personen.
  `.trim();
}

/** -------- Scenario detection (deterministic step 3) -------- */
function detectScenario(text) {
  const t = (text || "").toLowerCase();

  const isExit = /(ich\s+verlasse|bin\s+raus|trete\s+aus|ich\s+gehe|ich\s+bin\s+weg|leaving\s+the\s+community|goodbye)/i.test(t);

  const isThreat = /(sonst|anzeige|anwalt|ich\s+sorge\s+dafür|ich\s+komme\s+vorbei|wir\s+sehen\s+uns|ihr\s+werdet\s+schon\s+sehen|meld( )?e\s+euch|ruinier|dox|swat)/i.test(t);

  const isPressure = /(löscht\s+das|löschen\s+sonst|macht\s+das\s+weg|wenn\s+ihr\s+nicht|ihr\s+verliert\s+mitglieder)/i.test(t);

  const isCritique = /(enttäusch|schlecht|nervt|lächerlich|peinlich|unfähig|moderation|community)/i.test(t);

  if (isThreat || isPressure) return "threat";
  if (isExit) return "exit";
  if (isCritique) return "critique";
  return "neutral";
}

function extractShortQuote(text, maxLen = 90) {
  const s = (text || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + "…";
}

function wantsDM(dmMode, scenario) {
  if (dmMode === "never") return false;
  if (dmMode === "always") return true;
  // auto
  return scenario === "exit" || scenario === "threat";
}

function step3Templates({ scenario, originalText }) {
  const quote = extractShortQuote(originalText);

  if (scenario === "exit") {
    return {
      public_reply:
        `Du schreibst, dass du hier enttäuscht bist und die Community verlässt. Kritik ist hier okay. Uns hilft sie nur, wenn sie konkret wird. Wenn du magst, schreib in einem Satz, was für dich der Punkt war, der es gekippt hat. Dann schauen wir, was wir wirklich verbessern können.`,
      dm_reply:
        `Ich melde mich kurz direkt, weil dein Kommentar nach einem echten Bruch klingt. Wenn du willst, schick mir knapp die zwei bis drei Punkte, die für dich entscheidend waren. Dann kann das Team daraus wirklich etwas ableiten.`
    };
  }

  if (scenario === "threat") {
    return {
      public_reply:
        `Du schreibst: „${quote}“. Drohungen oder Druck haben hier keinen Platz. Wenn das nochmal so kommt, löschen wir den Inhalt und schränken den Account ein. Wenn du Kritik hast, sag sie bitte konkret und ohne Druck.`,
      dm_reply:
        `Kurzer Hinweis: Bitte keine Drohungen oder Druck. Wenn du ein Problem hast, schreib es konkret. Bei weiteren Drohungen löschen wir und schränken den Account ein.`
    };
  }

  if (scenario === "critique") {
    return {
      public_reply:
        `Danke für die klare Rückmeldung. Kritik ist hier okay. Hilf uns kurz mit einem konkreten Punkt: Was genau hat dich enttäuscht, und was würdest du dir stattdessen wünschen? Dann können wir sinnvoll reagieren.`,
      dm_reply:
        `Wenn du magst, schreib mir kurz die ein bis zwei Punkte, die für dich am meisten gestört haben. Dann kann das Team gezielt nachsteuern.`
    };
  }

  return {
    public_reply:
      `Danke für deinen Beitrag. Wenn du magst, sag kurz konkret, worum es dir geht. Dann können wir gezielt reagieren.`,
    dm_reply:
      `Wenn du möchtest, schreib mir kurz, was genau du meinst. Dann kann das Team besser helfen.`
  };
}

/** -------- Schema -------- */
const TAKT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    step0: {
      type: "object",
      additionalProperties: false,
      properties: {
        risiko: { type: "string", enum: ["niedrig", "mittel", "hoch", "kritisch"] },
        kurzcheck: { type: "string" },
        empfehlung: { type: "string" },
        begruendung: { type: "string" },
        assumption: { type: "string" }
      },
      required: ["risiko", "kurzcheck", "empfehlung", "begruendung", "assumption"]
    },
    step1: {
      type: "object",
      additionalProperties: false,
      properties: {
        sachebene: { type: "string" },
        selbstoffenbarung: { type: "string" },
        beziehungsebene: { type: "string" },
        appell: { type: "string" }
      },
      required: ["sachebene", "selbstoffenbarung", "beziehungsebene", "appell"]
    },
    step2: {
      type: "object",
      additionalProperties: false,
      properties: {
        ingroup_outgroup: { type: "string" },
        normen: { type: "string" },
        botschaft: { type: "string" }
      },
      required: ["ingroup_outgroup", "normen", "botschaft"]
    },
    step3: {
      type: "object",
      additionalProperties: false,
      properties: {
        public_reply: { type: "string" },
        dm_reply: { type: "string" },
        moderation_massnahme: {
          type: "string",
          enum: ["stehen_lassen", "antworten", "loeschen", "verwarnen", "einschraenken", "sperren"]
        }
      },
      required: ["public_reply", "dm_reply", "moderation_massnahme"]
    }
  },
  required: ["step0", "step1", "step2", "step3"]
};

/** -------- Renderer (Regelwerk headings) -------- */
function render(output, { includeDM }) {
  const s0 = output.step0 || {};
  const s1 = output.step1 || {};
  const s2 = output.step2 || {};
  const s3 = output.step3 || {};

  const lines = [];

  lines.push(`0. Türsteher (Moderationsblick)`);
  lines.push(``);
  lines.push(`Risiko: ${s0.risiko}.`);
  lines.push(`Kurzcheck: ${s0.kurzcheck}`.trim());
  lines.push(`Empfehlung: ${s0.empfehlung}`.trim());
  lines.push(`Begründung: ${s0.begruendung}`.trim());
  lines.push(``);
  // Pflichtsatz aus Regelwerk-Logik
  if (/stehen|bleib/i.test(s0.empfehlung || "")) {
    lines.push(`Kein sofortiger Löschbedarf: Weiter mit Schritt 1.`);
  } else {
    lines.push(`Weiter mit Schritt 1.`);
  }

  lines.push(``);
  lines.push(`1. Analyse (Schulz von Thun – Nachricht entschlüsseln)`);
  lines.push(``);
  lines.push(`Sachebene: ${s1.sachebene}`.trim());
  lines.push(``);
  lines.push(`Selbstoffenbarung: ${s1.selbstoffenbarung}`.trim());
  lines.push(``);
  lines.push(`Beziehungsebene: ${s1.beziehungsebene}`.trim());
  lines.push(``);
  lines.push(`Appell: ${s1.appell}`.trim());

  lines.push(``);
  lines.push(`2. Kompass (SIDE Modell – Community-Dynamik)`);
  lines.push(``);
  lines.push(`Ingroup / Outgroup (vermutet): ${s2.ingroup_outgroup}`.trim());
  lines.push(``);
  lines.push(`Relevante Norm(en): ${s2.normen}`.trim());
  lines.push(``);
  lines.push(`Gewünschte Botschaft an die Community: ${s2.botschaft}`.trim());

  lines.push(``);
  lines.push(`3. Tonart (GFK – Antwortvorschlag)`);
  lines.push(``);
  lines.push(`Öffentliche Moderatorenantwort:`);
  lines.push(``);
  lines.push(`${s3.public_reply}`.trim());

  if (includeDM) {
    lines.push(``);
    lines.push(`Optionale Direktnachricht an das Mitglied:`);
    lines.push(``);
    lines.push(`${s3.dm_reply}`.trim());
  }

  lines.push(``);
  lines.push(`Empfohlene Moderationsmaßnahme: ${s3.moderation_massnahme}`.trim());

  return lines.join("\n");
}

/** -------- Main handler -------- */
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
      return json(405, { error: "Method not allowed. Use POST." }, { "Allow": "POST, OPTIONS" });
    }

    const body = safeParseJson(event.body || "{}") || {};
    const text = (body.text || body.kommentar || body.Kommentar || "").toString().trim();
    const mode = (body.mode || "website").toString();

    if (!text) return json(400, { error: "Missing 'text' in request body." });

    const topk = Number(process.env.TAKT_RAG_TOPK || "0");
    const snippets = retrieveSnippets(text, topk);
    const knowledge = snippets.length
      ? snippets.map((s) => `Quelle: ${s.source}${s.title ? " | " + s.title : ""}\n${s.text}`).join("\n\n")
      : "";

    const client = await getOpenAI();

    // Ask model for steps 0-2 + recommended moderation action (step3.moderation_massnahme).
    // Step 3 text itself will be replaced by deterministic templates.
    const r = await client.responses.create({
      model: process.env.TAKT_MODEL || "gpt-4.1-mini",
      input: [
        { role: "system", content: buildCoreSystem() },
        { role: "system", content: buildStyleSystem() },
        ...(knowledge ? [{ role: "system", content: `WISSENSKONTEXT (Auszüge, nur falls relevant):\n${knowledge}` }] : []),
        { role: "user", content: `Analysiere den folgenden Kommentar nach TAKT. Gib JSON nach Schema zurück.\n\nKommentar:\n${text}` }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "takt_output",
          strict: true,
          schema: TAKT_SCHEMA
        }
      },
      max_output_tokens: 700
    });

    const raw = (r.output_text || "").trim();
    const parsed = safeParseJson(raw);
    if (!parsed) {
      return json(500, { error: "Model did not return valid JSON.", raw });
    }

    // Deterministic Step 3 upgrade
    const scenario = detectScenario(text);
    const dmMode = (process.env.TAKT_DM_MODE || "auto").toLowerCase();
    const includeDM = wantsDM(dmMode, scenario);

    const templates = step3Templates({ scenario, originalText: text });
    parsed.step3.public_reply = templates.public_reply;
    parsed.step3.dm_reply = includeDM ? templates.dm_reply : "";
    // keep model's recommended moderation action (already in parsed.step3.moderation_massnahme)

    const outputText = render(parsed, { includeDM });

    return json(200, {
      output: outputText,
      meta: {
        mode,
        scenario,
        rag_topk: topk,
        dm_mode: dmMode,
        dm_included: includeDM
      }
    });

  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: String(e && e.message ? e.message : e) });
  }
};
