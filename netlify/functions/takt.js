export default async function handler() {
  const hasKey = !!process.env.OPENAI_API_KEY;

  return new Response(
    JSON.stringify({
      status: "ok",
      openai_key_present: hasKey
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}
