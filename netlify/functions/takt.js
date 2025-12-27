/**
 * Netlify Function: /.netlify/functions/takt
 * Ziel: CustomGPT-Qualität reproduzierbar machen (Regelwerk + Brand Voice),
 * ohne Prompt-Glücksspiel. Kernprinzip:
 * - Schritt 0 und Schritt 3 (inkl. DM) werden deterministisch nach Policy/Templates gebaut.
 * - Schritt 1 & 2 kommen aus Templates für häufige Fälle, sonst optional aus dem Modell (strukturiert).
 *
 * CommonJS (Netlify). OpenAI SDK ESM-only via dynamic import.
 */

const fs = require("fs");
const path = require("path");

// ------------------------- Helpers -------------------------

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function safeTrim(s) {
  return (s || "").toString().trim();
}

function normalize(s) {
  return safeTrim(s).toLowerCase();
}

function ellipsize(s, max = 140) {
  const t = safeTrim(s);
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function pickQuote(original, patterns) {
  const txt = safeTrim(original);
  for (const re of patterns) {
    const m = re.exec(txt);
    if (m && m[0]) return ellipsize(m[0], 120);
  }
  // fallback: first sentence
  const m2 = txt.split(/\n|[.!?]/).map((x) => x.trim()).filter(Boolean)[0];
  return ellipsize(m2 || txt, 120);
}

// ------------------------- Classification -------------------------

function classify(text) {
  const t = normalize(text);

  const threat =
    /(sonst\b|ansonsten\b|ich\s+sorge\s+dafür|ich\s+besuche\s+euch|wir\s+sehen\s+uns|ich\s+finde\s+euch|anzeige|anwalt|ich\s+melde\s+euch|dox|adresse|ich\s+komme\s+vorbei)/i;

  const exit =
    /(ich\s+(verlasse|bin\s+raus|trete\s+aus|geh(e)?|gehe)\s+(die\s+)?(community|gruppe)|ich\s+lösche\s+meinen\s+account|ich\s+bin\s+dann\s+weg|tschüss\s+zusammen)/i;

  const personalAttack =
    /(keine\s+ahnung|gelaber|lern\s+erstmal|lern\s+mal|verpiss|idiot|dumm|blöd|halt\s+die\s+klappe|spinnst|typisch(\.|,)?\s*immer|lächerlich|peinlich|null\s+ahnung)/i;

  if (threat.test(t)) return { category: "threat" };
  if (personalAttack.test(t)) return { category: "personal_attack" };
  if (exit.test(t)) return { category: "exit" };
  if (/(\bhasse\b|\bich\s+töte\b|\bumbringen\b)/i.test(t)) return { category: "violent_threat" };
  return { category: "other" };
}

// ------------------------- Templates (0–3) -------------------------

function step0Text(category, original) {
  if (category === "personal_attack") {
    return [
      "Kein strafbarer Inhalt, keine Drohung, kein Doxing, kein Spam.",
      "Aber: klare Abwertung und persönlicher Angriff (z. B. „keine Ahnung“, „Gelaber“, „lern erstmal nachzudenken“). Das verletzt sehr wahrscheinlich die Umgangsregeln.",
      "Empfehlung: Kommentar ausblenden oder entfernen und kurz ermahnen. Weiter mit Schritt 1."
    ].join("\n");
  }
  if (category === "threat") {
    return [
      "Kein klar strafbarer Inhalt im Wortlaut, aber: Druck und Einschüchterung („sonst …“).",
      "Das ist ein Eskalationstreiber und untergräbt die Gesprächsnormen.",
      "Empfehlung: Kommentar ausblenden/entfernen, Grenze setzen, bei Wiederholung Konsequenz. Weiter mit Schritt 1."
    ].join("\n");
  }
  if (category === "exit") {
    return [
      "Kein strafbarer Inhalt, keine Drohung, kein Hate, kein Spam.",
      "Es ist Kritik/Enttäuschung und ein angekündigter Austritt.",
      "Empfehlung: Kann stehen bleiben. Kurz antworten, um konstruktives Feedback einzusammeln. Weiter mit Schritt 1."
    ].join("\n");
  }
  return [
    "Kurze Risiko-Einschätzung anhand des Inhalts.",
    "Empfehlung: Je nach Ton und Regelverstoß moderieren. Weiter mit Schritt 1."
  ].join("\n");
}

function step1_2_fromTemplates(category, original) {
  if (category === "personal_attack") {
    return {
      step1: {
        sachebene: "Du sagst, dass die andere Seite aus deiner Sicht keine Ahnung hat und nur „labert“.",
        selbstoffenbarung: "Hoher Frust, Ungeduld, möglicherweise das Gefühl, nicht ernst genommen zu werden.",
        beziehungsebene: "Abwertung, respektloser Ton, „ich bin dir überlegen“.",
        appell: "„Hör auf so zu antworten. Ändere deinen Stil. Sei kompetenter.“"
      },
      step2: {
        ingroup_outgroup: "„Genervte Nutzer:innen“ gegen „Antwortende/Moderation“.",
        relevante_normen: "Kritik an Inhalten ist okay, persönliche Angriffe nicht. Respektvoller Ton auch bei Frust.",
        botschaft: "Kritik ist willkommen, aber wir halten die Diskussion so, dass alle sicher mitreden können."
      }
    };
  }
  if (category === "exit") {
    return {
      step1: {
        sachebene: "Du sagst, dass du enttäuscht bist und die Community verlassen willst.",
        selbstoffenbarung: "Frust und Enttäuschung, vielleicht das Gefühl, nicht abgeholt zu werden.",
        beziehungsebene: "Vertrauen in uns oder in die Community ist gerade angeknackst.",
        appell: "Indirekt: „Ändert etwas, sonst bin ich weg.“"
      },
      step2: {
        ingroup_outgroup: "Du als enttäuschtes Mitglied vs. „ihr“ als Community/Moderationsteam.",
        relevante_normen: "Kritik ist okay, wir bleiben respektvoll und möglichst konkret.",
        botschaft: "Kritik hat Platz, Abwertung bringt wenig. Wir hören zu, brauchen aber greifbare Punkte."
      }
    };
  }
  if (category === "threat") {
    return {
      step1: {
        sachebene: "Du setzt uns unter Druck („löscht das, sonst …“).",
        selbstoffenbarung: "Hohe Anspannung, Kontrollwunsch oder Frust, der in Drohsprache kippt.",
        beziehungsebene: "Machtdruck: „Ich bestimme, was ihr tun müsst.“",
        appell: "„Reagiert sofort so, wie ich es fordere.“"
      },
      step2: {
        ingroup_outgroup: "Der/die Schreibende positioniert sich gegen die Moderation („ihr“).",
        relevante_normen: "Wir moderieren nach Regeln, nicht nach Drohungen. Respektvoller Umgang gilt für alle.",
        botschaft: "Druck zieht nicht. Regeln gelten konsequent, Kritik ist möglich, aber ohne Einschüchterung."
      }
    };
  }
  return null;
}

function step3Templates(category, original) {
  const t = safeTrim(original);
  if (category === "personal_attack") {
    const quote = pickQuote(t, [
      /„[^”]{0,120}”/g,
      /"[^"]{0,120}"/g,
      /(keine\s+ahnung|gelaber|lern\s+erstmal[^.!?\n]{0,60}|typisch[^.!?\n]{0,60})/i
    ]);

    const publicReply = [
      `Du schreibst: „${quote}“.`,
      "Man merkt, dass dich das gerade richtig nervt.",
      "Kritik am Inhalt ist hier völlig okay. Persönliche Abwertung lassen wir nicht stehen.",
      "Formuliere deinen Punkt bitte sachlich: Was genau passt dir inhaltlich nicht? Ein Satz reicht.",
      "Wenn das so weitergeht, blenden oder entfernen wir solche Kommentare. Bei Wiederholung gibt es eine Schreibpause."
    ].join(" ");

    const dmReply = [
      `Ich schreibe dir kurz direkt wegen deines Kommentars („${quote}“).`,
      "Das ist ein persönlicher Angriff. Kritik ist okay, aber bitte ohne Abwertung.",
      "Wenn du einen konkreten Punkt hast, schick ihn kurz rüber. Dann klären wir das inhaltlich.",
      "Wenn du wieder persönlich wirst, gibt es eine Schreibpause."
    ].join(" ");

    return { publicReply, dmReply, includeDm: true, massnahme: "ausblenden_oder_entfernen" };
  }

  if (category === "exit") {
    const publicReply = [
      "Du schreibst, dass du hier enttäuscht bist und die Community verlässt.",
      "Kritik ist hier absolut okay. Gleichzeitig hilft sie uns nur, wenn sie konkret wird.",
      "Wenn du magst, schreib in einem Satz, was für dich der Punkt war, der es gekippt hat. Dann können wir gezielt nachsteuern."
    ].join(" ");

    const dmReply = [
      "Ich melde mich kurz direkt, weil dein Kommentar nach einem echten Bruch klingt.",
      "Wenn du willst, schreib mir knapp die zwei, drei Punkte, die dich am meisten enttäuscht haben.",
      "Kein Roman. Nur das Entscheidende. Dann kann das Team daraus wirklich etwas ableiten."
    ].join(" ");

    return { publicReply, dmReply, includeDm: true, massnahme: "stehen_lassen" };
  }

  if (category === "threat") {
    const quote = pickQuote(t, [
      /(sonst[^.!?\n]{0,120})/i,
      /(ich\s+sorge\s+dafür[^.!?\n]{0,120})/i
    ]);

    const publicReply = [
      `Du schreibst: „${quote}“.`,
      "Druck oder Drohungen bringen hier nichts. Wir moderieren nach Regeln, nicht nach Einschüchterung.",
      "Lass das bitte weg und formuliere deinen Punkt sachlich. Dann reagieren wir darauf.",
      "Wenn du weiter drohst, entfernen wir den Kommentar. Bei Wiederholung sperren wir den Account zeitweise."
    ].join(" ");

    const dmReply = [
      `Ich schreibe dir kurz direkt wegen „${quote}“.`,
      "Drohungen/Druckversuche akzeptieren wir hier nicht.",
      "Formuliere deinen Kritikpunkt als Sache. Wenn das nochmal so kommt, gibt es eine Schreibpause oder Sperre."
    ].join(" ");

    return { publicReply, dmReply, includeDm: true, massnahme: "entfernen_und_ermahnen" };
  }

  // other: neutrales, aber nicht support-floskelig
  const publicReply = [
    "Dein Punkt ist angekommen.",
    "Bitte bleib sachlich und konkret, damit wir sinnvoll reagieren können.",
    "Worum genau geht es dir in einem Satz?"
  ].join(" ");

  return { publicReply, dmReply: "", includeDm: false, massnahme: "prüfen" };
}

// ------------------------- Optional Knowledge (RAG) -------------------------

function resolveKbPath() {
  // Support both local dev and Netlify bundle include
  const candidates = [
    path.join(process.cwd(), "netlify", "functions", "takt_knowledge.json"),
    path.join(__dirname, "takt_knowledge.json")
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadKb() {
  const p = resolveKbPath();
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function idf(df, N) {
  return Math.log((N + 1) / (df + 1)) + 1;
}

function retrieveSnippets(query, topK) {
  const kb = loadKb();
  if (!kb || !topK || topK <= 0) return [];

  const qTokens = tokenize(query);
  const qSet = new Set(qTokens);

  const chunks = kb.chunks || [];
  const N = chunks.length || 1;
  const df = kb.df || {};

  const scored = chunks.map((c) => {
    const tokens = c.tokens || tokenize(c.text || "");
    let score = 0;
    const tokenCounts = {};
    for (const tok of tokens) tokenCounts[tok] = (tokenCounts[tok] || 0) + 1;

    for (const tok of qSet) {
      const tf = tokenCounts[tok] || 0;
      if (!tf) continue;
      score += (1 + Math.log(tf)) * idf(df[tok] || 0, N);
    }
    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

// ------------------------- OpenAI (only for Step 1 & 2 when needed) -------------------------

async function getOpenAI() {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const STEP12_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
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
        relevante_normen: { type: "string" },
        botschaft: { type: "string" }
      },
      required: ["ingroup_outgroup", "relevante_normen", "botschaft"]
    }
  },
  required: ["step1", "step2"]
};

function buildSystemForStep12(knowledgeText) {
  return `
Du bist TAKT, ein virtueller Community-Moderator nach dem TAKT-Regelwerk.
Aufgabe: Liefere NUR Schritt 1 und Schritt 2 als JSON nach Schema.
Stil: klar, präzise, keine Floskeln, keine Behörden-Sprache, kurze Sätze.
In Schritt 2: Formuliere Normen und Botschaft als Moderationssicht (Signal an Mitlesende).
${knowledgeText ? `\nWISSENSKONTEXT (nur falls relevant):\n${knowledgeText}\n` : ""}

WICHTIG:
- Keine Schritt-3-Antworten.
- Keine Nummerierung.
- Keine Emojis.
- Keine Gedankenstriche im Satz.
`.trim();
}

async function generateStep12(text, topK) {
  const snippets = retrieveSnippets(text, topK);
  const knowledge = snippets
    .map((s) => `Quelle: ${s.source} | Abschnitt: ${s.title}\n${s.text}`)
    .join("\n\n");

  const client = await getOpenAI();
  const model = process.env.TAKT_MODEL || "gpt-4.1-mini";

  const resp = await client.responses.create({
    model,
    input: [
      { role: "system", content: buildSystemForStep12(knowledge) },
      { role: "user", content: text }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "takt_step12",
        strict: true,
        schema: STEP12_SCHEMA
      }
    },
    max_output_tokens: 400
  });

  // OpenAI SDK convenience: output_text contains the JSON string when using structured outputs
  const raw = safeTrim(resp.output_text);
  return JSON.parse(raw);
}

// ------------------------- Render -------------------------

function renderTAKT({ step0, step1, step2, step3 }) {
  const out = [];

  out.push("0. Türsteher (Moderationsblick)");
  out.push("");
  out.push(step0);
  out.push("");
  out.push("1. Analyse (Schulz von Thun – Nachricht entschlüsseln)");
  out.push("");
  out.push(`Sachebene: ${step1.sachebene}`);
  out.push("");
  out.push(`Selbstoffenbarung: ${step1.selbstoffenbarung}`);
  out.push("");
  out.push(`Beziehungsebene: ${step1.beziehungsebene}`);
  out.push("");
  out.push(`Appell: ${step1.appell}`);
  out.push("");
  out.push("2. Kompass (SIDE Modell – Community-Dynamik)");
  out.push("");
  out.push(`Ingroup / Outgroup (vermutet): ${step2.ingroup_outgroup}`);
  out.push("");
  out.push(`Relevante Norm(en): ${step2.relevante_normen}`);
  out.push("");
  out.push(`Gewünschte Botschaft an die Community: ${step2.botschaft}`);
  out.push("");
  out.push("3. Tonart (GFK – Antwortvorschlag)");
  out.push("");
  out.push("Öffentliche Moderatorenantwort:");
  out.push("");
  out.push(step3.publicReply);
  out.push("");

  if (step3.includeDm && safeTrim(step3.dmReply)) {
    out.push("Optionale Direktnachricht an das Mitglied:");
    out.push("");
    out.push(step3.dmReply);
    out.push("");
  }

  out.push("Maßnahmenempfehlung");
  out.push("");
  // kurze, handlungsorientierte Empfehlung
  if (step3.massnahme === "ausblenden_oder_entfernen") {
    out.push("Kommentar ausblenden/entfernen (persönlicher Angriff).");
    out.push("Öffentlich kurz Grenze setzen, optional per DM erklären.");
    out.push("Bei Wiederholung: Schreibpause oder weitere Konsequenzen nach Hausregeln.");
  } else if (step3.massnahme === "entfernen_und_ermahnen") {
    out.push("Kommentar entfernen (Druck/Drohung).");
    out.push("Kurz Grenze setzen, optional per DM nachschärfen.");
    out.push("Bei Wiederholung: Schreibpause oder Sperre.");
  } else if (step3.massnahme === "stehen_lassen") {
    out.push("Beitrag stehen lassen, nicht eskalieren.");
    out.push("Kurz öffentlich antworten und um konkrete Punkte bitten.");
    out.push("Optional per DM nach zwei, drei Punkten fragen.");
  } else {
    out.push(`Empfohlene Moderationsmaßnahme: ${step3.massnahme}`);
  }

  return out.join("\n");
}

// ------------------------- Handler -------------------------

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, {});
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const text =
      safeTrim(body.text) ||
      safeTrim(body.kommentar) ||
      safeTrim(body.Kommentar) ||
      safeTrim(body.comment) ||
      "";

    if (!text) return json(400, { error: "Missing 'text'." });

    const mode = safeTrim(body.mode) || "website";
    const { category } = classify(text);

    // Step 0 & 3 always deterministic
    const step0 = step0Text(category, text);
    const step3 = step3Templates(category, text);

    // Step 1 & 2: templates for common categories; else model-assisted
    let step12 = step1_2_fromTemplates(category, text);
    if (!step12) {
      // RAG topK: in website-mode default small (performance); allow override
      const envTopK = Number(process.env.TAKT_RAG_TOPK ?? "0");
      const requestedTopK = body.rag_topk != null ? Number(body.rag_topk) : null;
      let topK = requestedTopK != null && !Number.isNaN(requestedTopK) ? requestedTopK : envTopK;
      if (Number.isNaN(topK) || topK < 0) topK = 0;
      if (mode === "website") topK = Math.min(topK, 3);

      // If no API key, fallback to minimal generic analysis
      if (!process.env.OPENAI_API_KEY) {
        step12 = {
          step1: {
            sachebene: "Der Kommentar enthält eine Aussage/Position des Nutzers.",
            selbstoffenbarung: "Es zeigt sich eine Emotion oder Haltung.",
            beziehungsebene: "Der Ton setzt eine Beziehungsebene.",
            appell: "Der Nutzer möchte eine Reaktion oder Änderung."
          },
          step2: {
            ingroup_outgroup: "Noch unklar; ggf. Nutzer vs. Community/Moderation.",
            relevante_normen: "Respektvoller Ton, Kritik an Inhalten statt an Personen.",
            botschaft: "Kritik ist möglich, aber respektvoll und konkret."
          }
        };
      } else {
        step12 = await generateStep12(text, topK);
      }
    }

    const output = renderTAKT({
      step0,
      step1: step12.step1,
      step2: step12.step2,
      step3
    });

    return json(200, { output });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
