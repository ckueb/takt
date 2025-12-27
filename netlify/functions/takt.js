/**
 * Netlify Function (CommonJS): /.netlify/functions/takt
 *
 * Request body (min):
 *   { "text": "..." }
 *
 * Optional:
 *   { "text": "...", "mode": "website", "options": { "public_variants": 2, "dm_variants": 1 } }
 *
 * This variant uses OpenAI Vector Stores + file_search for Regelwerk/Brandvoice/Instructions.
 * Weekly updates are handled by GitHub Actions updating TAKT_VECTOR_STORE_ID on Netlify.
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
    "Du folgst verbindlich dem TAKT-Regelwerk (Schritt 0–3) und setzt die Brand Voice in Schritt 3 um.",
    "Bei Konflikt gilt: Regelwerk hat Vorrang vor Brand Voice.",
    "",
    "Ausgabeformat MUSS exakt diese vier Abschnitte enthalten:",
    "0. Türsteher (Moderationsblick)",
    "1. Analyse (Schulz von Thun – Nachricht entschlüsseln)",
    "2. Kompass (SIDE Modell – Community-Dynamik)",
    "3. Tonart (GFK – Antwortvorschlag)",
    "",
    "Sprache: natürlich, klar, auf Augenhöhe. Keine Behörden- oder Lehrerzimmer-Sprache. Keine Emojis.",
    "Nutze bei Bedarf das Tool file_search, um Regeln/Brandvoice/Instructions sicher zu treffen.",
  ].join("\n");
}

function buildUserInstruction({ text, mode, publicVariants, dmVariants }) {
  const header = [
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
  return header;
}

async function getOpenAIClient() {
  // OpenAI SDK is ESM-only in newer versions. Use dynamic import inside CommonJS.
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

    const vectorStoreId = safeTrim(process.env.TAKT_VECTOR_STORE_ID);
    if (!vectorStoreId) {
      return json(500, { error: "Missing TAKT_VECTOR_STORE_ID on server. Sync workflow not run yet." });
    }

    const client = await getOpenAIClient();

    const response = await client.responses.create({
      model: DEFAULT_MODEL,
      input: [
        { role: "system", content: buildCoreSystem() },
        { role: "user", content: buildUserInstruction({ text, mode, publicVariants, dmVariants }) },
      ],
      tools: [{
        type: "file_search",
        vector_store_ids: [vectorStoreId],
        max_num_results: RAG_TOPK,
      }],
      max_output_tokens: 900,
    });

    return json(200, { output: (response.output_text || "").trim() });
  } catch (e) {
    console.error("TAKT function error:", e);
    return json(500, { error: "Serverfehler. Bitte später erneut versuchen." });
  }
};
