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
 * This variant uses OpenAI Vector Stores + file_search for Regelwerk/Brandvoice/Instructions.
 * Weekly updates are handled by GitHub Actions updating TAKT_VECTOR_STORE_ID on Netlify.
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
 * The long details stay in the vector store and are retrieved via file_search.
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
    "WICHTIG: Nutze IMMER das Tool file_search, um Regelwerk/Brandvoice/Instructions zu laden, bevor du Schritt 3 formulierst.",
    "WICHTIG: Schritt 3 ist handlungsorientiert, klar, natürlich und auf Augenhöhe.",
    "Blacklist: keine Floskeln (z. B. „Danke für deinen Beitrag“, „Wir hören…“, „Wir wünschen uns…“, „Wir freuen uns…“).",
    "Blacklist: keine Behörden-/Prozesssprache (z. B. „prüfen Maßnahmen“, „es wird geprüft“, „Befund“, „Vorgang“, „Drohanzeige“).",
    "Wenn ein Regelverstoß vorliegt: klare Grenze setzen und Konsequenz in natürlicher Sprache nennen (aktiv, nicht vage).",
    "Keine Meta-Erklärungen über dein Vorgehen. Keine Quellen, keine Verweise, keine Klammer-Zitate im Output.",
    "Keine Emojis. Keine Gedankenstriche.",
  ].join("\n");
}

function buildUserInstruction({ text, mode, publicVariants, dmVariants }) {
  return [
    "Analysiere den folgenden Kommentar strikt nach TAKT.",
    "Wichtig:",
    `- Modus: ${mode || "website"}`,
    `- Erzeuge ${publicVariants} öffentliche Moderatorenantwort(en) als Varianten.`,
    `- Erzeuge ${dmVariants} Direktnachricht(en) an das Mitglied als Varianten (wenn 0, lasse den DM-Block weg).`,
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

function extractFileSearchResults(response) {
  const out = Array.isArray(response.output) ? response.output : [];
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

    // Debug flag
    const debug = !!options.debug;

    const vectorStoreId = safeTrim(process.env.TAKT_VECTOR_STORE_ID);
    if (!vectorStoreId) {
      return json(500, { error: "Missing TAKT_VECTOR_STORE_ID on server. Sync workflow not run yet." });
    }

    const client = await getOpenAIClient();

    const req = {
      model: DEFAULT_MODEL,
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
      .slice(0, 8)
      .map((r) => ({
        score: r.score,
        file_id: r.file_id || r.file?.id,
        filename: r.filename || r.file?.filename,
        text_preview: (r.text || r.content || "").toString().slice(0, 500),
      }));

    return json(200, {
      output,
      debug: {
        vector_store_id: vectorStoreId,
        rag_topk: RAG_TOPK,
        tool_choice: "force:file_search",
        file_search_results_count: fsResults.length,
        file_search_results: fsResults,
      },
    });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
