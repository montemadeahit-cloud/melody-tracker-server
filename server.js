const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const crypto     = require("crypto");
const fetch      = require("node-fetch");
const FormData   = require("form-data");

const app  = express();
const port = process.env.PORT || 8080;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const ACR_HOST         = process.env.ACR_HOST;
const ACR_KEY          = process.env.ACR_KEY;
const ACR_SECRET       = process.env.ACR_SECRET;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;

// ── Supabase helpers ──────────────────────────────────────────
async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { "Content-Type":"application/json", "apikey":SUPABASE_KEY, "Authorization":`Bearer ${SUPABASE_KEY}`, "Prefer":"return=representation" },
    body: JSON.stringify(row),
  });
  return r.json();
}

async function sbSelect(table, filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: { "apikey":SUPABASE_KEY, "Authorization":`Bearer ${SUPABASE_KEY}` },
  });
  return r.json();
}

async function sbDelete(table, filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: { "apikey":SUPABASE_KEY, "Authorization":`Bearer ${SUPABASE_KEY}` },
  });
  return r.ok;
}

// ── ACRCloud ──────────────────────────────────────────────────
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
  const res = await fetch(`https://${ACR_HOST}/v1/identify`, { method:"POST", body:form });
  return res.json();
}

// ── Health ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status:"ok", acrHost:ACR_HOST||"MISSING", keySet:!!ACR_KEY, secretSet:!!ACR_SECRET, supabase:!!SUPABASE_URL });
});

// ── Auth: sign up ─────────────────────────────────────────────
app.post("/auth/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error:"All fields required." });

    // Check username not taken
    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(existing) && existing.length > 0) return res.status(400).json({ error:"Username already taken." });

    // Create user via admin API (auto-confirms email)
    const authRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const authData = await authRes.json();
    console.log("Admin create user result:", JSON.stringify(authData));
    if (authData.error) return res.status(400).json({ error: authData.error.message || authData.error });

    const userId = authData.id || authData.user?.id;
    if (!userId) return res.status(400).json({ error: "Could not create account. Please try again." });

    // Save profile with username
    const profileResult = await sbInsert("profiles", { id: userId, username });
    console.log("Profile insert result:", JSON.stringify(profileResult));

    // Sign them in immediately
    const signInRes  = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "apikey":SUPABASE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const signInData = await signInRes.json();
    if (signInData.error) return res.status(400).json({ error: signInData.error.message || "Signup succeeded but sign in failed. Please sign in manually." });

    res.json({ access_token: signInData.access_token, user: { id: signInData.user.id, email: signInData.user.email, username } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auth: sign in with username ───────────────────────────────
app.post("/auth/signin", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error:"All fields required." });

    // Look up email from username using service key
    const profiles = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    console.log("Looking up username:", username, "Result:", JSON.stringify(profiles));
    if (!Array.isArray(profiles) || profiles.length === 0) return res.status(400).json({ error:"Username not found." });
    const profile = profiles[0];

    // Get email via admin API
    const userRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${profile.id}`, {
      headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` },
    });
    const userData = await userRes.json();
    const email    = userData?.email;
    if (!email) return res.status(400).json({ error:"Could not find account." });

    // Sign in with email + password
    const signInRes  = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "apikey":SUPABASE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const signInData = await signInRes.json();
    if (signInData.error || signInData.error_description) return res.status(400).json({ error: signInData.error_description || signInData.error?.message || "Sign in failed." });

    res.json({ access_token: signInData.access_token, user: { id: signInData.user.id, email: signInData.user.email, username: profile.username } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scan ──────────────────────────────────────────────────────
app.post("/scan", upload.single("file"), async (req, res) => {
  try {
    if (!ACR_HOST || !ACR_KEY || !ACR_SECRET) return res.status(500).json({ error:"ACRCloud credentials not configured." });
    if (!req.file) return res.status(400).json({ error:"No file uploaded." });

    const { user_id } = req.body;

    // Run scan first
    const acrData = await identify(req.file.buffer, req.file.originalname, req.file.mimetype);
    console.log("ACRCloud:", JSON.stringify(acrData));

    // Save to DB in background
    if (user_id && SUPABASE_URL) {
      try {
        const matched     = acrData?.status?.code === 0;
        const resultTitle = matched ? acrData?.metadata?.music?.[0]?.title : null;
        await sbInsert("beats", {
          user_id,
          filename:     req.file.originalname,
          status:       matched ? "placed" : "monitoring",
          last_scanned: new Date().toISOString(),
          last_result:  resultTitle,
          uploaded_at:  new Date().toISOString(),
        });
      } catch(dbErr) {
        console.error("Supabase save failed (non-fatal):", dbErr.message);
      }
    }

    res.json(acrData);
  } catch(err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error:"Scan failed: " + err.message });
  }
});

// ── Get beats ─────────────────────────────────────────────────
app.get("/beats/:user_id", async (req, res) => {
  try {
    const beats = await sbSelect("beats", `user_id=eq.${req.params.user_id}&order=uploaded_at.desc`);
    res.json(Array.isArray(beats) ? beats : []);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete beat ───────────────────────────────────────────────
app.delete("/beats/:beat_id", async (req, res) => {
  try {
    const ok = await sbDelete("beats", `id=eq.${req.params.beat_id}`);
    res.json({ success: ok });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, "0.0.0.0", () => console.log(`Server listening on 0.0.0.0:${port}`));
