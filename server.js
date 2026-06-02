const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const crypto     = require("crypto");
const fetch      = require("node-fetch");
const FormData   = require("form-data");

const app  = express();
const port = process.env.PORT || 8080;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const ACR_HOST      = process.env.ACR_HOST;
const ACR_KEY       = process.env.ACR_KEY;
const ACR_SECRET    = process.env.ACR_SECRET;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

// ── Supabase helper ──────────────────────────────────────────
async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer": "return=representation",
    },
    body: JSON.stringify(row),
  });
  return res.json();
}

async function sbSelect(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    },
  });
  return res.json();
}

async function sbUpdate(table, filter, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(row),
  });
  return res.json();
}

// ── ACRCloud identify ────────────────────────────────────────
async function identify(buffer, filename, mimetype) {
  const timestamp    = Math.floor(Date.now() / 1000);
  const stringToSign = `POST\n/v1/identify\n${ACR_KEY}\naudio\n1\n${timestamp}`;
  const signature    = crypto.createHmac("sha1", ACR_SECRET).update(stringToSign).digest("base64");

  const form = new FormData();
  form.append("sample",            buffer, { filename, contentType: mimetype });
  form.append("access_key",        ACR_KEY);
  form.append("data_type",         "audio");
  form.append("signature_version", "1");
  form.append("signature",         signature);
  form.append("sample_bytes",      buffer.length.toString());
  form.append("timestamp",         timestamp.toString());

  const res = await fetch(`https://${ACR_HOST}/v1/identify`, { method: "POST", body: form });
  return res.json();
}

// ── Health check ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    acrHost:   ACR_HOST    || "MISSING",
    keySet:    !!ACR_KEY,
    secretSet: !!ACR_SECRET,
    supabase:  !!SUPABASE_URL,
  });
});

// ── Scan endpoint ────────────────────────────────────────────
app.post("/scan", upload.single("file"), async (req, res) => {
  try {
    if (!ACR_HOST || !ACR_KEY || !ACR_SECRET)
      return res.status(500).json({ error: "ACRCloud credentials not configured." });
    if (!req.file)
      return res.status(400).json({ error: "No file uploaded." });

    const { user_id, username } = req.body;

    // Save beat record to Supabase if user is logged in
    let beatId = null;
    if (user_id && SUPABASE_URL) {
      const inserted = await sbInsert("beats", {
        user_id,
        filename: req.file.originalname,
        status: "scanning",
        uploaded_at: new Date().toISOString(),
      });
      beatId = inserted?.[0]?.id || null;
      console.log("Beat saved:", beatId);
    }

    // Run ACRCloud scan
    const acrData = await identify(req.file.buffer, req.file.originalname, req.file.mimetype);
    console.log("ACRCloud response:", JSON.stringify(acrData));

    // Update beat record with result
    if (beatId && SUPABASE_URL) {
      const matched = acrData?.status?.code === 0;
      const resultTitle = matched ? acrData?.metadata?.music?.[0]?.title : null;
      await sbUpdate("beats", `id=eq.${beatId}`, {
        last_scanned: new Date().toISOString(),
        last_result:  resultTitle,
        status:       matched ? "placed" : "monitoring",
      });
    }

    res.json(acrData);
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: "Scan failed: " + err.message });
  }
});

// ── Get user's beats ─────────────────────────────────────────
app.get("/beats/:user_id", async (req, res) => {
  try {
    if (!SUPABASE_URL) return res.status(500).json({ error: "Supabase not configured." });
    const beats = await sbSelect("beats", `user_id=eq.${req.params.user_id}&order=uploaded_at.desc`);
    res.json(beats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
