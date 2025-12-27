/**
 * Netlify Function (CommonJS): /.netlify/functions/takt
 *
 * Request body (min):
 *   { "text": "..." }
 *
 * Optional:
 *   {
 *     "text": "...",
 *     "mode": "website",
 *     "options": {
 *       "public_variants": 1,
 *       "dm_variants": 0,
 *       "debug": true
 *     }
 *   }
 *
 * Uses OpenAI Vector Stores + file_search for Regelwerk/Brandvoice.
 * GitHub Actions updates TAKT_VECTOR_STORE_ID on Netlify.
 *
 * IMPORTANT:
 * - file_search is ALWAYS enforced via tool_choice.
 * - Debug can include file_search results via include: ["file_search_call.results"].
 */

const DEFAULT_MODEL = process.env.TAKT_MODEL || "gpt-4.1-mini";
const MAX_CHARS = Number(process.env.TAKT_MAX_CHARS || 2000);
const RAG_TOPK = Math.max(0, Number(process.env.TAKT_RAG_TOPK || 6));

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function safeTrim(s) {
  return (s || "").toString().trim();
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

/**
 * Hard, short "contract" prompt.
 * Long details stay in the vector store and are retrieved via file_search.
 */
function buildCoreSystem() {
  return [
    "Du bist TAKT, ein Online-Moderations- und Deeskalationsassistent.",
    "Du arbeitest praxisnah, deeskalierend, respektvoll und lösungsorientiert.",
    "Du folgst verbindlich dem TAKT-Regelwerk (Schritt 0–3) und setzt die Brand Voice in Schritt 3 strikt um.",
    "Bei Konflikt gilt: Regelwerk hat Vorrang vor Brand Voice.",
    "",
    "Ausgabeformat MUSS exakt diese vier Abschnitte enthalten (Überschriften exakt wie hier):",
    "0. Türsteher (Moderationsblick)",
    "1. Analyse (Schulz von Thun – Nachricht entschlüsseln)",
    "2. Kompass (SIDE Modell – Community-Dynamik)",
    "3. Tonart (GFK – Antwortvorschlag)",
    "",
    "WICHTIGER ARBEITSAUFTRAG (verbindlich):",
    "Du MUSST vor jeder Antwort das Tool file_search nutzen und dabei BEIDE Dokumente berücksichtigen:",
    "- Dokument 1: regelwerk (TAKT-Regelwerk Schritt 0–3)",
    "- Dokument 2: brandvoice (Ton & Stilregeln für Schritt 3)",
    "",
    "Vorgehen (immer gleich):",
    "1) Suche gezielt nach 'Türsteher', 'Analyse', 'Kompass', 'Tonart' im Regelwerk und lade passende Passagen.",
    "2) Suche gezielt nach 'Ton', 'Stil', 'Do/Don't', 'Formulierungen', 'Blacklist/Whitelist' in der Brand Voice und lade passende Passagen.",
    "3) Formuliere die Antwort NUR auf Basis der geladenen Passagen.",
    "4) Wenn du keine passenden Passagen findest: STOPP und gib aus: 'Regelwerk/Brand Voice konnte nicht geladen werden – bitte Sync prüfen.'",
    "",
    "Regelpriorität: Regelwerk > Brand Voice.",
    "",
    "Schritt 3 (GFK) muss IMMER so klingen:",
    "- Erst 1 kurzer Satz: Emotion/Frust anerkennen, ohne zu loben (z. B. „Klingt frustrierend.“).",
    "- Dann 1 konkrete Rückfrage: „Was genau…?“ / „Woran machst du das fest…?“",
    "- Optional 1 Normsatz, aber weich formuliert: „Mit konkreten Punkten können wir besser reagieren.“",
    "- KEIN Tadel, KEINE Belehrung, KEIN Shaming. Vermeide Formulierungen wie „bringt uns nicht weiter“, „so pauschal“, „wirkt abwertend“.",
    "- Keine Imperative wie „Formuliere…“ oder „Bitte konkretisiere…“ – lieber als Einladung/Option formulieren.",
    "- Maximal 2 Sätze pro Variante.",
    "",
    "Blacklist: keine Floskeln (z. B. „Danke für deinen Beitrag“, „Wir hören…“, „Wir wünschen uns…“, „Wir freuen uns…“).",
    "Blacklist: keine Behörden-/Prozesssprache (z. B. „prüfen Maßnahmen“, „es wird geprüft“, „Befund“, „Vorgang“, „Drohanzeige“).",
    "Wenn ein Regelverstoß vorliegt: klare Grenze setzen und Konsequenz in natürlicher Sprache nennen (aktiv, nicht vage).",
    "",
    "Keine Meta-Erklärungen über dein Vorgehen.",
    "Keine Quellen, keine Verweise, keine Klammer-Zitate im Output.",
    "Keine Emojis.",
    "Keine Gedankenstriche.",
  ].join("\n");
}

function buildUserInstruction({ text, mode, publicVariants, dmVariants }) {
  return [
    "Analysiere den folgenden Kommentar strikt nach TAKT.",
    "Wichtig:",
    `- Modus: ${mode || "website"}`,
    `- Erzeuge ${publicVariants} öffentliche Moderatorenantwort(en) als Varianten.`,
    `- Erzeuge ${dmVariants} Direktnachricht(en) an das Mitglied als Varianten (wenn 0, lasse den DM-Block weg).`,
    "- Verbindlich: Nutze Regelwerk UND Brand Voice aus file_search als Grundlage.",
    "- Wenn Regelwerk/Brand Voice nicht geladen werden kann: brich ab und melde das (kein Raten).",
    "- Schritt 3: pro Variante maximal 2 Sätze (kurz).",
    "- Schritt 3: zuerst Frust anerkennen (1 Satz), dann eine konkrete Frage stellen (1 Satz).",
    "- Keine erzieherischen Formulierungen, keine Abwertung, keine Belehrung.",
    "- Halte Schritt 3 handlungsorientiert und klar. Wenn ein Regelverstoß vorliegt, setze eine klare Grenze und nenne die Konsequenz in natürlicher Sprache.",
    "- Vermeide Floskeln wie „Danke für deinen Beitrag“.",
    "",
    "Kommentar:",
    text,
  ].join("\n");
}

async function getOpenAIClient() {
  // OpenAI SDK is ESM-only in newer versions. Use dynamic import inside CommonJS.
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Extract file_search results from a Responses API response.
 * We keep this defensive because shapes can vary slightly by SDK/version.
 */
function extractFileSearchResults(response) {
  const out = Array.isArray(response?.output) ? response.output : [];
  const calls = out.filter((x) => x && x.type === "file_search_call");

  const results = [];
  for (const c of calls) {
    const r = c.results || c.file_search_call?.results || [];
    if (Array.isArray(r)) results.push(...r);
  }
  return results;
}

exports.handler = async (event) => {
  try {
    if ((event.httpMethod || "").toUpperCase() === "OPTIONS") {
      return json(204, {});
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const text = safeTrim(body.text);
    const mode = safeTrim(body.mode) || "website";
    const options = body.options || {};

    if (!text) return json(400, { error: "Missing text" });
    if (text.length > MAX_CHARS) return json(400, { error: `Text too long (max ${MAX_CHARS})` });

    const publicVariants = clampInt(options.public_variants, 1, 4, 1);
    const dmVariants = clampInt(options.dm_variants, 0, 4, 0);
    const debug = !!options.debug;

    const vectorStoreId = safeTrim(process.env.TAKT_VECTOR_STORE_ID);
    if (!vectorStoreId) {
      return json(500, { error: "Missing TAKT_VECTOR_STORE_ID on server. Sync workflow not run yet." });
    }

    const client = await getOpenAIClient();

    const req = {
      model: DEFAULT_MODEL,
      temperature: 0.3, // Weniger „generisches Support-Blabla“, stabilere Formulierungen
      input: [
        { role: "system", content: buildCoreSystem() },
        { role: "user", content: buildUserInstruction({ text, mode, publicVariants, dmVariants }) },
      ],
      tools: [
        {
          type: "file_search",
          vector_store_ids: [vectorStoreId],
          max_num_results: RAG_TOPK,
        },
      ],

      // ALWAYS enforce retrieval
      tool_choice: { type: "file_search" },

      max_output_tokens: 900,
    };

    // Debug: include tool results in response object
    if (debug) {
      req.include = ["file_search_call.results"];
    }

    const response = await client.responses.create(req);
    const output = (response.output_text || "").trim();

    if (!debug) {
      return json(200, { output });
    }

    const fsResults = extractFileSearchResults(response)
      .slice(0, 12)
      .map((r) => ({
        score: r.score,
        file_id: r.file_id || r.file?.id,
        filename: r.filename || r.file?.filename,
        text_preview: (r.text || r.content || "").toString().slice(0, 600),
      }));

    const touchedFiles = Array.from(
      new Set(fsResults.map((r) => (r.filename || "").toLowerCase()).filter(Boolean))
    );

    return json(200, {
      output,
      debug: {
        vector_store_id: vectorStoreId,
        rag_topk: RAG_TOPK,
        tool_choice: "force:file_search",
        file_search_results_count: fsResults.length,
        touched_files: touchedFiles,
        has_regelwerk: touchedFiles.some((x) => x.includes("regelwerk")),
        has_brandvoice: touchedFiles.some((x) => x.includes("brandvoice")),
        file_search_results: fsResults,
      },
    });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
