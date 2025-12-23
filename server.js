// server.js (Cloud Run -> Google Sheets API direct writer)
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static site from /public
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------------------------------------------------------------------
// CONFIG (set these in Cloud Run > Variables & Secrets)
// ---------------------------------------------------------------------
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "";       // REQUIRED
const LEADS_RANGE = process.env.LEADS_RANGE || "Leads!A:AB";   // Make sure tab "Leads" exists
const STAGE_DEFAULT = process.env.STAGE_DEFAULT || "New";
const NOTES_DEFAULT = process.env.NOTES_DEFAULT || "Created via Rebuild Web Form";

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : "";
}

function generateLeadId() {
  const num = Math.floor(Math.random() * 90000) + 10000;
  return `RB${num}`;
}

async function getSheetsClient() {
  // Cloud Run uses its service account automatically via ADC.
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// Health check
app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    spreadsheetConfigured: !!SPREADSHEET_ID,
    spreadsheetId: SPREADSHEET_ID ? "set" : "missing",
    range: LEADS_RANGE,
  });
});

// ---------------------------------------------------------------------
// API - Save lead directly to Google Sheet
// ---------------------------------------------------------------------
app.post("/api/rb/lead", async (req, res) => {
  const traceId = crypto.randomUUID();

  try {
    const formData = req.body || {};

    // Required fields
    if (!formData.fullName || !formData.primaryPhone || !formData.preferredChannel) {
      return res.status(400).json({
        success: false,
        error: "Missing required contact details (name, phone, preferred channel).",
      });
    }

    if (!SPREADSHEET_ID) {
      return res.status(500).json({
        success: false,
        error: "Missing SPREADSHEET_ID (set Cloud Run env var).",
      });
    }

    const leadId = formData.leadId || generateLeadId();
    const timestamp = new Date().toISOString();

    // IMPORTANT: Keep your existing field names coming from frontend.
    // We’re only mapping them into a row array.
    const row = [
      timestamp,                           // 1 Timestamp
      leadId,                              // 2 Lead ID
      formData.fullName || "",             // 3 Full Name
      formData.primaryPhone || "",         // 4 Primary Phone
      formData.email || "",                // 5 Email
      formData.preferredChannel || "",     // 6 Preferred Channel
      formData.parish || "",               // 7 Parish
      formData.community || "",            // 8 Community
      formData.propertyStatus || "",       // 9 Property Status
      formData.rebuildType || "",          // 10 Rebuild Type
      toNumber(formData.hurricaneImpactLevel),  // 11 Hurricane Impact Level
      toNumber(formData.projectPriority),       // 12 Project Priority
      toNumber(formData.estimatedBudget),       // 13 Estimated Project Budget
      toNumber(formData.comfortableMonthly),    // 14 Comfortable Monthly Payment
      toNumber(formData.desiredTimelineMonths), // 15 Desired Start Timeline (Months)
      formData.nhtContributor || "",        // 16 NHT Contributor
      formData.nhtProduct || "",            // 17 NHT Product Interest
      formData.otherFinancing || "",        // 18 Other Financing Preference
      formData.employmentType || "",        // 19 Employment Type
      formData.incomeRange || "",           // 20 Approx Net Monthly Income Range
      formData.hasOverseasSponsor || "",    // 21 Has Overseas Sponsor
      formData.sponsorCountry || "",        // 22 Sponsor Country
      formData.willingVisit || "",          // 23 Willing to Book Site Visit
      formData.visitWindow || "",           // 24 Preferred Site Visit Window
      formData.hearAboutUs || "",           // 25 How Did You Hear About Us
      toNumber(formData.leadScore),         // 26 Lead Score
      formData.stage || STAGE_DEFAULT,      // 27 Stage
      formData.notes || NOTES_DEFAULT,      // 28 Internal Notes
      traceId,                              // 29 TraceId (optional but SUPER helpful)
    ];

    const sheets = await getSheetsClient();

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: LEADS_RANGE,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return res.json({
      success: true,
      leadId,
      traceId,
      updatedRange: result?.data?.updates?.updatedRange || null,
    });
  } catch (err) {
    const status = err?.code || err?.response?.status || null;
    const details = err?.response?.data || err?.errors || err;

    console.error("Sheets append failed:", {
      traceId,
      message: err?.message,
      status,
      details,
    });

    return res.status(500).json({
      success: false,
      error: "Failed to write to Google Sheets.",
      debug: { traceId, status, message: err?.message || "Unknown error" },
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`Running on port ${port}`));
