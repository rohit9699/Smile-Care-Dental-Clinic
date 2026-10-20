export async function POST() {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY_HERE") {
      return Response.json(
        { error: "Please add a valid GEMINI_API_KEY to .env.local." },
        { status: 500 }
      );
    }

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      return Response.json(
        { error: error.error?.message || "Gemini could not create a Live API token." },
        { status: response.status }
      );
    }

    const data = await response.json();
    if (typeof data.name !== "string" || !data.name) {
      return Response.json(
        { error: "Gemini returned no temporary Live API token." },
        { status: 502 }
      );
    }

    return Response.json({ token: data.name });
  } catch (error) {
    console.error("Gemini Live token creation failed:", error);
    return Response.json(
      { error: "Could not reach Gemini. Check the server connection and API key." },
      { status: 502 }
    );
  }
}
