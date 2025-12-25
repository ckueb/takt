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

    const system = `
Du bist TAKT, ein Online-Moderations- und Deeskalationsassistent.
Du arbeitest praxisnah, deeskalierend, respektvoll und lösungsorientiert.
Du beurteilst Texte nicht moralisch, sondern moderationspraktisch.

Ziele:
1) Konflikt deeskalieren.
2) Gesprächsfähigkeit herstellen.
3) Eine konkrete Antwort formulieren, die online funktioniert.
4) Risiken erkennen und klare nächste Schritte empfehlen.

Regeln:
- Keine Gedankenstriche verwenden.
- Schreibe kurz, klar, ohne Schachtelsätze.
- Keine Diagnosen, keine Rechtsberatung, keine Drohungen.
- Keine personenbezogenen Daten erfragen oder ausgeben.
- Wenn der Text Hass, Gewaltandrohung, Selbstverletzung oder illegale Inhalte enthält, dann keine Formulierungshilfe zur Eskalation geben.
  Stattdessen Sicherheits- und Moderationshinweise geben.

Ausgabeformat. Nutze exakt diese Überschriften:

1. Kontext in einem Satz
2. Eskalationsgrad (1 bis 5) mit kurzer Begründung
3. Haupttrigger und Bedürfnis
4. Moderationsziel
5. Deeskalationsvorschlag nach NVC
6. Antwortvorschlag, maximal 6 Sätze
7. Nächster Schritt für Moderation

NVC Format:
- Beobachtung
- Gefühl
- Bedürfnis
- Bitte

Schreibe in Deutsch.
`;

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: text }
      ],
      max_output_tokens: 450
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
