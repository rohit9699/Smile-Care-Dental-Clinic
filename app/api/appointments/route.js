function jsonError(message, status) {
  return Response.json({ error: message }, { status });
}

export async function POST(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonError("Request origin is not allowed.", 403);
  }

  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL?.trim();
  const sharedSecret = process.env.GOOGLE_SHEETS_SHARED_SECRET;
  if (!scriptUrl || !sharedSecret) {
    return jsonError("Configure GOOGLE_APPS_SCRIPT_URL and GOOGLE_SHEETS_SHARED_SECRET in .env.local.", 503);
  }

  let parsedScriptUrl;
  try {
    parsedScriptUrl = new URL(scriptUrl);
  } catch {
    return jsonError("GOOGLE_APPS_SCRIPT_URL must be a valid Apps Script Web App URL.", 500);
  }
  if (
    parsedScriptUrl.protocol !== "https:" ||
    parsedScriptUrl.hostname !== "script.google.com" ||
    !/^\/macros\/s\/[^/]+\/exec$/.test(parsedScriptUrl.pathname)
  ) {
    return jsonError("GOOGLE_APPS_SCRIPT_URL must be the deployed Web App URL ending in /macros/s/DEPLOYMENT_ID/exec.", 500);
  }
  if (sharedSecret.trim().length < 32) {
    return jsonError("GOOGLE_SHEETS_SHARED_SECRET must be at least 32 characters long.", 500);
  }

  let appointment;
  try {
    appointment = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }

  if (appointment?.action === "health") {
    try {
      const response = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: sharedSecret, action: "health" }),
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      const responseText = await response.text();
      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        console.error("Apps Script health check returned a non-JSON response:", response.status);
        return jsonError("Apps Script did not return JSON. Check the deployed /exec URL and deploy the latest script version.", 502);
      }

      if (!response.ok || result.ready !== true) {
        console.error("Apps Script health check failed:", response.status, result.error || "Unknown response");
        return jsonError(result.error || "Apps Script could not access the spreadsheet.", 502);
      }

      return Response.json({ ready: true, message: "Apps Script can access the spreadsheet and Bookings tab." });
    } catch (error) {
      const reason = error.name === "TimeoutError" || error.name === "AbortError"
        ? "Apps Script health check timed out."
        : "Could not reach Apps Script. Check the /exec URL and deployment access.";
      console.error("Apps Script health check request failed:", error.name);
      return jsonError(reason, 502);
    }
  }

  if (
    appointment?.confirmed !== true ||
    !["patientName", "phone", "treatment", "preferredDateTime"].every(
      (field) => typeof appointment[field] === "string" && appointment[field].trim()
    )
  ) {
    return jsonError("A confirmed booking with name, phone, treatment, and preferred date/time is required.", 400);
  }

  const patientName = appointment.patientName.trim();
  const phone = appointment.phone.trim();
  const treatment = appointment.treatment.trim();
  const preferredDateTime = appointment.preferredDateTime.trim();
  if ([patientName, phone, treatment, preferredDateTime].some((value) => value.length > 300)) {
    return jsonError("Booking fields must be 300 characters or fewer.", 400);
  }

  try {
    const response = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: sharedSecret,
        appointment: {
          patientName,
          phone,
          treatment,
          preferredDateTime,
          confirmed: true,
        },
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      const finalHost = new URL(response.url).hostname;
      if (finalHost === "accounts.google.com" || /sign in|sign-in|login/i.test(responseText)) {
        return jsonError("Google redirected to sign-in. Redeploy the Apps Script Web App with access set to Anyone, then use its /exec URL.", 502);
      }
      console.error("Apps Script returned a non-JSON response:", response.status, finalHost);
      return jsonError(`Apps Script returned a non-JSON response (HTTP ${response.status}). Check that the URL is the deployed /exec URL and the latest deployment includes doPost.`, 502);
    }

    if (!response.ok || result.saved !== true) {
      console.error("Apps Script booking append failed:", response.status, result.error || "Unknown response");
      return jsonError(
        result.error || "Apps Script did not confirm that the appointment was saved.",
        502
      );
    }

    return Response.json({ saved: true });
  } catch (error) {
    const reason = error.name === "TimeoutError" || error.name === "AbortError"
      ? "Apps Script request timed out. Check the Web App deployment and try again."
      : "Could not reach Apps Script. Check the /exec URL, internet connection, and deployment access.";
    console.error("Apps Script booking request failed:", error.name);
    return jsonError(reason, 502);
  }
}
