import OpenAI from "openai";

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST with JSON { text }" }), {
        status: 405,
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = await req.json().catch(() => ({}));
    const text = String(body.text || "").trim();

    if (!text) {
      return new Response(JSON.stringify({ error: "Missing 'text'." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (text.length > 2000) {
      return new Response(JSON.stringify({ error: "Text too long (max 2000 chars for beta)." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const system = [
      "You are a test endpoint for TAKT.",
      "Return exactly one short sentence that confirms you received the input.",
      "Do not add extra formatting."
    ].join(" ");

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: text }
      ],
      max_output_tokens: 80
    });

    return new Response(JSON.stringify({ output: r.output_text }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
