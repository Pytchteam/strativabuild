// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static site from /public
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
// Your Sheet ID (hard-coded). You can still override with env var.
const SHEET_ID_FALLBACK = "1rxqvrZV27sJUD4uYoKXITs_wtCEpCY0aQm9JQWftqJI";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || SHEET_ID_FALLBACK;

// IMPORTANT:
// LEADS_RANGE_NAME must exist as a *Named Range* in that spreadsheet,
// OR change this to an A1 range like: "Sheet2!A:AB"
const LEADS_RANGE_NAME = process.env.LEADS_RANGE_NAME || "RANGEREBUILDLEADS";

const STAGE_DEFAULT = process.env.STAGE_DEFAULT || "New";
const NOTES_DEFAULT = process.env.NOTES_DEFAULT || "Created via Rebuild Web Form";

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function generateLeadId() {
  const num = Math.floor(Math.random() * 90000) + 10000;
  return `RB${num}`;
}

async function getSheetsClient() {
  // Cloud Run best practice: Application Default Credentials
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------
app.post("/api/rb/lead", async (req, res) => {
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
      return res
        .status(500)
        .json({ success: false, error: "Server not configured (SPREADSHEET_ID missing)." });
    }

    const leadId = formData.leadId || generateLeadId();
    const timestamp = new Date().toISOString();

    const row = [
      timestamp,                          // 1 Timestamp
      leadId,                             // 2 Lead ID
      formData.fullName || "",            // 3 Full Name
      formData.primaryPhone || "",        // 4 Primary Phone
      formData.email || "",               // 5 Email
      formData.preferredChannel || "",    // 6 Preferred Channel
      formData.parish || "",              // 7 Parish
      formData.community || "",           // 8 Community
      formData.propertyStatus || "",      // 9 Property Status
      formData.rebuildType || "",         // 10 Rebuild Type
      toNumber(formData.hurricaneImpactLevel),     // 11 Hurricane Impact Level
      toNumber(formData.projectPriority),          // 12 Project Priority
      toNumber(formData.estimatedBudget),          // 13 Estimated Project Budget
      toNumber(formData.comfortableMonthly),       // 14 Comfortable Monthly Payment
      toNumber(formData.desiredTimelineMonths),    // 15 Desired Start Timeline (Months)
      formData.nhtContributor || "",       // 16 NHT Contributor
      formData.nhtProduct || "",           // 17 NHT Product Interest
      formData.otherFinancing || "",       // 18 Other Financing Preference
      formData.employmentType || "",       // 19 Employment Type
      formData.incomeRange || "",          // 20 Approx Net Monthly Income Range
      formData.hasOverseasSponsor || "",   // 21 Has Overseas Sponsor
      formData.sponsorCountry || "",       // 22 Sponsor Country
      formData.willingVisit || "",         // 23 Willing to Book Site Visit
      formData.visitWindow || "",          // 24 Preferred Site Visit Window
      formData.hearAboutUs || "",          // 25 How Did You Hear About Us
      toNumber(formData.leadScore),        // 26 Lead Score
      STAGE_DEFAULT,                       // 27 Stage
      NOTES_DEFAULT,                       // 28 Internal Notes
    ];

    const sheets = await getSheetsClient();

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: LEADS_RANGE_NAME,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return res.json({ success: true, leadId });
  } catch (err) {
    console.error("Error saving lead:", err?.message || err);
    return res.status(500).json({ success: false, error: "Server error saving lead." });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Running on port ${port}`));
