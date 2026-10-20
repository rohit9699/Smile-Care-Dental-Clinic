function doPost(e) {
  try {
    var properties = PropertiesService.getScriptProperties();
    var expectedSecret = properties.getProperty("APP_SHARED_SECRET");
    var spreadsheetId = properties.getProperty("SPREADSHEET_ID");
    if (!expectedSecret || !spreadsheetId) {
      return jsonResponse({ saved: false, error: "Apps Script properties are not configured." });
    }

    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!body.secret || body.secret !== expectedSecret) {
      return jsonResponse({ saved: false, error: "Unauthorized request." });
    }

    if (body.action === "health") {
      var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      var sheet = spreadsheet.getSheetByName("Bookings") || spreadsheet.insertSheet("Bookings");
      if (sheet.getLastRow() === 0) {
        sheet.appendRow([
          "Patient name",
          "Phone number",
          "Treatment/problem",
          "Preferred date and time",
          "Booking status",
        ]);
      }
      return jsonResponse({ ready: true });
    }

    var appointment = body.appointment || {};
    var requiredFields = ["patientName", "phone", "treatment", "preferredDateTime"];
    if (appointment.confirmed !== true || requiredFields.some(function (field) {
      return typeof appointment[field] !== "string" || !appointment[field].trim();
    })) {
      return jsonResponse({ saved: false, error: "Confirmed booking details are required." });
    }

    var values = requiredFields.map(function (field) {
      var value = appointment[field].trim();
      if (value.length > 300) throw new Error("Booking fields must be 300 characters or fewer.");
      return /^[=+\-@]/.test(value) ? "'" + value : value;
    });

    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    var sheet = spreadsheet.getSheetByName("Bookings") || spreadsheet.insertSheet("Bookings");
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Patient name",
        "Phone number",
        "Treatment/problem",
        "Preferred date and time",
        "Booking status",
      ]);
    }

    sheet.appendRow(values.concat(["Confirmed"]));
    return jsonResponse({ saved: true });
  } catch (error) {
    console.error("Booking save failed: " + error.message);
    return jsonResponse({ saved: false, error: error.message || "Could not save appointment." });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
