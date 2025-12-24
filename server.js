// server.js (Cloud Run -> Google Sheets API writer, auto sheet + headers, sane CORS, tolerant payload mapping)
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------------------------------------------------------------------
// BODY PARSING
// ---------------------------------------------------------------------
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------
// Set in Cloud Run env vars (comma-separated):
//   CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
// If omitted, we allow same-origin usage (your form served from Cloud Run) and localhost.
const DEFAULT_ALLOWED = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ALLOWED, ...CORS_ORIGINS])];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // If request has an Origin header (browser), allow only if it matches our allowlist.
  // If no Origin header (Postman/server-to-server), let it pass.
  if (origin) {
    const allowed =
      ALLOWED_ORIGINS.includes(origin) ||
      // also allow same Cloud Run origin automatically
      origin === `https://${req.headers.host}`;

    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------
// STATIC SITE
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------------------------------------------------------------------
// CONFIG (Cloud Run > Variables & Secrets)
// ---------------------------------------------------------------------
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || ""; // strongly recommended via env var
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
  // Uses the Cloud Run service account automatically (ADC)
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

async function ensureLeadsSheetAndHeaders(sheets) {
  // 1) Ensure the tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = (meta.data.sheets || []).find(
    (s) => s.properties?.title === LEADS_SHEET_NAME
  );

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: LEADS_SHEET_NAME } } }],
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

    // Freeze header row (optional)
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

// payload mapping helper (accept old + new keys)
function pick(formData, keys, fallback = "") {
  for (const k of keys) {
    const v = formData?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return fallback;
}

// ---------------------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    spreadsheetConfigured: !!SPREADSHEET_ID,
    sheetName: LEADS_SHEET_NAME,
    range: LEADS_RANGE_NAME,
    allowedOrigins: ALLOWED_ORIGINS,
  });
});

// ---------------------------------------------------------------------
// API - Receive lead from frontend, write to Google Sheets
// ---------------------------------------------------------------------
app.post("/api/rb/lead", async (req, res) => {
  const traceId = makeTraceId();

  try {
    if (!SPREADSHEET_ID) {
      return res.status(500).json({
        success: false,
        error: "Server not configured (SPREADSHEET_ID missing).",
        debug: { traceId },
      });
    }

    const formData = req.body || {};

    // Normalize required fields
    const fullName = String(pick(formData, ["fullName"], "")).trim();
    const primaryPhone = String(pick(formData, ["primaryPhone"], "")).trim();
    const preferredChannel = String(pick(formData, ["preferredChannel"], "")).trim();

    if (!fullName || !primaryPhone || !preferredChannel) {
      return res.status(400).json({
        success: false,
        error: "Missing required contact details (name, phone, preferred channel).",
        debug: { traceId, receivedKeys: Object.keys(formData || {}) },
      });
    }

    // Normalize “mixed naming” fields from frontend
    const estimatedBudget = toNumber(pick(formData, ["estimatedBudget"], 0));
    const comfortableMonthly = toNumber(
      pick(formData, ["comfortableMonthly", "monthlyPayment"], 0)
    );
    const desiredTimelineMonths = toNumber(
      pick(formData, ["desiredTimelineMonths", "startTimelineMonths"], 0)
    );
    const hasOverseasSponsor = String(
      pick(formData, ["hasOverseasSponsor", "overseasSponsor"], "")
    ).trim();

    const sheets = await getSheetsClient();
    await ensureLeadsSheetAndHeaders(sheets);

    const leadId = String(pick(formData, ["leadId"], generateLeadId()));
    const timestamp = new Date().toISOString();

    const row = [
      timestamp,
      leadId,
      fullName,
      primaryPhone,
      String(pick(formData, ["email"], "")),
      preferredChannel,
      String(pick(formData, ["parish"], "")),
      String(pick(formData, ["community"], "")),
      String(pick(formData, ["propertyStatus"], "")),
      String(pick(formData, ["rebuildType"], "")),
      toNumber(pick(formData, ["hurricaneImpactLevel"], 0)),
      toNumber(pick(formData, ["projectPriority"], 0)),
      estimatedBudget,
      comfortableMonthly,
      desiredTimelineMonths,
      String(pick(formData, ["nhtContributor"], "")),
      String(pick(formData, ["nhtProduct"], "")),
      String(pick(formData, ["otherFinancing"], "")),
      String(pick(formData, ["employmentType"], "")),
      String(pick(formData, ["incomeRange"], "")),
      hasOverseasSponsor,
      String(pick(formData, ["sponsorCountry"], "")),
      String(pick(formData, ["willingVisit"], "")),
      String(pick(formData, ["visitWindow"], "")),
      String(pick(formData, ["hearAboutUs"], "")),
      toNumber(pick(formData, ["leadScore"], 0)),
      String(pick(formData, ["stage"], STAGE_DEFAULT)),
      String(pick(formData, ["notes"], NOTES_DEFAULT)),
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
    const status = err?.code || err?.response?.status || 500;
    const message = err?.message || "Unknown error";

    console.error("Sheets write error:", {
      traceId,
      status,
      message,
      details: err?.response?.data || err?.errors || null,
    });

    return res.status(500).json({
      success: false,
      error: "Failed to write to Google Sheets.",
      debug: { traceId, status, message },
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`Running on port ${port}`));

