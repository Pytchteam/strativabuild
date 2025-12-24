// server.js (Cloud Run -> Google Sheets API writer, with auto sheet + headers)
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
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || ""; // REQUIRED
const LEADS_SHEET_NAME = process.env.LEADS_SHEET_NAME || "Leads";
const LEADS_RANGE_NAME = process.env.LEADS_RANGE_NAME || `${LEADS_SHEET_NAME}!A:AB`;

const STAGE_DEFAULT = process.env.STAGE_DEFAULT || "New";
const NOTES_DEFAULT = process.env.NOTES_DEFAULT || "Created via Rebuild Web Form";

// ---------------------------------------------------------------------
// HEADERS (A..AB = 28 columns)
// ---------------------------------------------------------------------
const LEADS_HEADERS = [
  "Timestamp",                 // A
  "Lead ID",                   // B
  "Full Name",                 // C
  "Phone",                     // D
  "Email",                     // E
  "Preferred Channel",         // F
  "Parish",                    // G
  "Community",                 // H
  "Property Status",           // I
  "Rebuild Type",              // J
  "Hurricane Impact Level",    // K
  "Project Priority",          // L
  "Estimated Budget",          // M
  "Comfortable Monthly",       // N
  "Desired Timeline Months",   // O
  "NHT Contributor",           // P
  "NHT Product",               // Q
  "Other Financing",           // R
  "Employment Type",           // S
  "Income Range",              // T
  "Has Overseas Sponsor",      // U
  "Sponsor Country",           // V
  "Willing Visit",             // W
  "Visit Window",              // X
  "Hear About Us",             // Y
  "Lead Score",                // Z
  "Stage",                     // AA
  "Notes",                     // AB
];

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

function makeTraceId() {
  return crypto.randomUUID?.() || String(Date.now());
}

async function getSheetsClient() {
  // Uses the Cloud Run service account automatically (Application Default Credentials)
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

async function ensureLeadsSheetAndHeaders(sheets) {
  // 1) Ensure the "Leads" sheet/tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = (meta.data.sheets || []).find(
    (s) => s.properties?.title === LEADS_SHEET_NAME
  );

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: LEADS_SHEET_NAME } } },
        ],
      },
    });
  }

  // 2) If A1:AB1 is empty, write headers
  const headerRange = `${LEADS_SHEET_NAME}!A1:AB1`;
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: headerRange,
  });

  const row = (current.data.values && current.data.values[0]) || [];
  const hasAnyHeader = row.some((cell) => String(cell || "").trim() !== "");

  if (!hasAnyHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: headerRange,
      valueInputOption: "RAW",
      requestBody: { values: [LEADS_HEADERS] },
    });

    // Optional: freeze header row
    const meta2 = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheet = (meta2.data.sheets || []).find(
      (s) => s.properties?.title === LEADS_SHEET_NAME
    );
    const sheetId = sheet?.properties?.sheetId;
    if (typeof sheetId === "number") {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: "gridProperties.frozenRowCount",
              },
            },
          ],
        },
      });
    }
  }
}

// Quick config check endpoint
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    spreadsheetConfigured: !!SPREADSHEET_ID,
    spreadsheetId: SPREADSHEET_ID ? "set" : "missing",
    range: LEADS_RANGE_NAME,
    sheetName: LEADS_SHEET_NAME,
  });
});

// ---------------------------------------------------------------------
// API - Receive lead from frontend, write to Google Sheets
// ---------------------------------------------------------------------
app.post("/api/rb/lead", async (req, res) => {
  const traceId = makeTraceId();

  try {
    const formData = req.body || {};

    // Required fields
    if (!formData.fullName || !formData.primaryPhone || !formData.preferredChannel) {
      return res.status(400).json({
        success: false,
        error: "Missing required contact details (name, phone, preferred channel).",
        debug: { traceId },
      });
    }

    if (!SPREADSHEET_ID) {
      return res.status(500).json({
        success: false,
        error: "Server not configured (SPREADSHEET_ID missing).",
        debug: { traceId },
      });
    }

    const sheets = await getSheetsClient();

    // Ensure tab + headers exist before writing
    await ensureLeadsSheetAndHeaders(sheets);

    const leadId = formData.leadId || generateLeadId();
    const timestamp = new Date().toISOString();

    // Match your 28 columns (A..AB)
    const row = [
      timestamp,
      leadId,
      formData.fullName || "",
      formData.primaryPhone || "",
      formData.email || "",
      formData.preferredChannel || "",
      formData.parish || "",
      formData.community || "",
      formData.propertyStatus || "",
      formData.rebuildType || "",
      toNumber(formData.hurricaneImpactLevel),
      toNumber(formData.projectPriority),
      toNumber(formData.estimatedBudget),
      toNumber(formData.comfortableMonthly),
      toNumber(formData.desiredTimelineMonths),
      formData.nhtContributor || "",
      formData.nhtProduct || "",
      formData.otherFinancing || "",
      formData.employmentType || "",
      formData.incomeRange || "",
      formData.hasOverseasSponsor || "",
      formData.sponsorCountry || "",
      formData.willingVisit || "",
      formData.visitWindow || "",
      formData.hearAboutUs || "",
      toNumber(formData.leadScore),
      formData.stage || STAGE_DEFAULT,
      formData.notes || NOTES_DEFAULT,
    ];

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: LEADS_RANGE_NAME,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return res.json({
      success: true,
      leadId,
      updatedRange: result?.data?.updates?.updatedRange || null,
      debug: { traceId },
    });
  } catch (err) {
    const status = err?.code || err?.response?.status;
    const message = err?.message || "Unknown error";
    const details = err?.response?.data || err?.errors || null;

    console.error("Sheets write error:", { traceId, status, message, details });

    return res.status(500).json({
      success: false,
      error: "Failed to write to Google Sheets.",
      debug: { traceId, status: status || null, message },
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`Running on port ${port}`));
