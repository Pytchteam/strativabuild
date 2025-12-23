// server.js (Cloud Run -> Apps Script writer)
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

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
const APPS_SCRIPT_EXEC_URL = process.env.APPS_SCRIPT_EXEC_URL || "https://script.google.com/macros/s/AKfycbwkZC4gly9UPnJ9nX_vh7lh-p4E-j_PhCOpdE-xCdRx4fCLcDcX71ZHYUGA9UGE_-Et/exec"; // <-- ADD THIS in Cloud Run env vars
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

// Quick config check endpoint
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    appsScriptConfigured: !!APPS_SCRIPT_EXEC_URL,
    appsScriptUrl: APPS_SCRIPT_EXEC_URL ? "set" : "missing",
    stageDefault: STAGE_DEFAULT,
  });
});

// ---------------------------------------------------------------------
// API - Receive lead from frontend, forward to Apps Script Web App
// ---------------------------------------------------------------------
app.post("/api/rb/lead", async (req, res) => {
  try {
    const formData = req.body || {};

    // Required fields (same as your current server)
    if (!formData.fullName || !formData.primaryPhone || !formData.preferredChannel) {
      return res.status(400).json({
        success: false,
        error: "Missing required contact details (name, phone, preferred channel).",
      });
    }

    if (!APPS_SCRIPT_EXEC_URL) {
      return res.status(500).json({
        success: false,
        error: "Server not configured (APPS_SCRIPT_EXEC_URL missing).",
      });
    }

    const leadId = formData.leadId || generateLeadId();
    const timestamp = new Date().toISOString();

    // IMPORTANT:
    // - Keep your existing field names.
    // - We just add leadId/timestamp/stage/notes so your sheet can store them.
    const payload = {
      ...formData,
      leadId,
      timestamp,
      stage: formData.stage || STAGE_DEFAULT,
      notes: formData.notes || NOTES_DEFAULT,
      // Optional metadata (nice for debugging)
      source: "cloudrun",
      userAgent: req.get("user-agent") || "",
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
    };

    // Forward to Apps Script (writer)
    const r = await fetch(APPS_SCRIPT_EXEC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = null; }

    if (!r.ok) {
      return res.status(502).json({
        success: false,
        error: "Apps Script writer failed.",
        debug: { status: r.status, body: text?.slice(0, 500) },
      });
    }

    // If Apps Script returns JSON, pass it through; otherwise return success
    return res.json({
      success: true,
      leadId,
      writer: json || { ok: true, raw: text?.slice(0, 200) },
    });
  } catch (err) {
    console.error("Error forwarding lead:", { message: err?.message, err });
    return res.status(500).json({
      success: false,
      error: "Server error forwarding lead.",
      debug: { message: err?.message || "Unknown error" },
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`Running on port ${port}`));
