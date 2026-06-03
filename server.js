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
  allowedHeaders: ["Content-Type", "Authorization", "x-rescan-secret", "stripe-signature"],
}));

// Raw body for Stripe webhook — must come before express.json()
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const ACR_HOST          = process.env.ACR_HOST;
const ACR_KEY           = process.env.ACR_KEY;
const ACR_SECRET        = process.env.ACR_SECRET;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY        = process.env.RESEND_API_KEY;
const FROM_EMAIL        = process.env.FROM_EMAIL || "alerts@trackmyplacements.com";
const RESCAN_SECRET     = process.env.RESCAN_SECRET || "rescan-secret";
const STRIPE_KEY        = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_T1   = process.env.STRIPE_PRICE_ID;
const STRIPE_PRICE_T2   = process.env.STRIPE_PRICE_ID_TIER2;
const STRIPE_WEBHOOK    = process.env.STRIPE_WEBHOOK_SECRET;
const APP_URL           = process.env.APP_URL || "https://trackmyplacements.com";

// ── Tier limits ───────────────────────────────────────────────
const LIMITS = {
  trial: { submissions: 25,  emailMonitors: 0,        unlimited: false },
  tier1: { submissions: 100, emailMonitors: 100,       unlimited: false },
  tier2: { submissions: null, emailMonitors: null,     unlimited: true  },
};

function getLimits(tier) {
  return LIMITS[tier] || LIMITS.trial;
}

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

async function sbUpdate(table, filter, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { "Content-Type":"application/json", "apikey":SUPABASE_KEY, "Authorization":`Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify(row),
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

// ── Supabase Storage ──────────────────────────────────────────
async function storageUpload(path, buffer, mimetype) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${path}`, {
    method: "POST",
    headers: { "Content-Type": mimetype, "apikey": SUPABASE_SERVICE, "Authorization": `Bearer ${SUPABASE_SERVICE}` },
    body: buffer,
  });
  return r.json();
}

async function storageDownload(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${path}`, {
    headers: { "apikey": SUPABASE_SERVICE, "Authorization": `Bearer ${SUPABASE_SERVICE}` },
  });
  if (!r.ok) return null;
  return r.buffer();
}

async function storageDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${path}`, {
    method: "DELETE",
    headers: { "apikey": SUPABASE_SERVICE, "Authorization": `Bearer ${SUPABASE_SERVICE}` },
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

// ── Stripe ────────────────────────────────────────────────────
async function stripeRequest(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const r = await fetch(`https://api.stripe.com/v1${path}`, opts);
  return r.json();
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":`Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    const d = await r.json();
    console.log("Email sent:", JSON.stringify(d));
    return d;
  } catch(e) { console.error("Email error:", e.message); }
}

function placementEmailHtml(filename, title, artist, spotifyId, youtubeId) {
  const listenLink = spotifyId
    ? `https://open.spotify.com/track/${spotifyId}`
    : youtubeId ? `https://youtube.com/watch?v=${youtubeId}` : null;
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#16161a;color:#f0ece4;border-radius:16px;">
    <div style="font-size:22px;font-weight:700;margin-bottom:4px;">TrackMy<span style="color:#c8a96e;">Placements</span></div>
    <div style="font-size:11px;color:#6b7385;letter-spacing:.1em;text-transform:uppercase;margin-bottom:28px;">Placement Location Engine</div>
    <div style="background:rgba(200,169,110,0.08);border:1px solid rgba(200,169,110,0.2);border-radius:12px;padding:20px;margin-bottom:20px;">
      <div style="font-size:13px;color:#c8a96e;margin-bottom:10px;text-transform:uppercase;letter-spacing:.08em;">Placement detected</div>
      <div style="font-size:18px;font-weight:700;margin-bottom:4px;">${title}</div>
      <div style="font-size:14px;color:rgba(240,236,228,0.6);">${artist||"Unknown artist"}</div>
    </div>
    <div style="font-size:13px;color:rgba(240,236,228,0.6);margin-bottom:6px;">Your beat</div>
    <div style="font-size:14px;font-weight:600;margin-bottom:20px;">${filename}</div>
    ${listenLink ? `<a href="${listenLink}" style="display:inline-block;background:linear-gradient(135deg,#c8a96e,#e8c98e);color:#1a1400;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px;text-decoration:none;">Listen to the track ↗</a>` : ""}
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:#6b7385;">
      You're receiving this because you submitted this beat to TrackMyPlacements.<br/>
      <a href="https://trackmyplacements.com" style="color:#c8a96e;">trackmyplacements.com</a>
    </div>
  </div>`;
}

function passwordResetEmailHtml(resetUrl) {
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#16161a;color:#f0ece4;border-radius:16px;">
    <div style="font-size:22px;font-weight:700;margin-bottom:4px;">TrackMy<span style="color:#c8a96e;">Placements</span></div>
    <div style="font-size:11px;color:#6b7385;letter-spacing:.1em;text-transform:uppercase;margin-bottom:28px;">Password Reset</div>
    <p style="font-size:14px;color:rgba(240,236,228,0.7);line-height:1.7;margin-bottom:24px;">We received a request to reset your password. Click the button below to set a new one. This link expires in 1 hour.</p>
    <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#c8a96e,#e8c98e);color:#1a1400;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px;text-decoration:none;">Reset my password ↗</a>
    <p style="margin-top:24px;font-size:12px;color:#6b7385;">If you didn't request this, you can safely ignore this email.</p>
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:#6b7385;">
      <a href="https://trackmyplacements.com" style="color:#c8a96e;">trackmyplacements.com</a>
    </div>
  </div>`;
}

// ── Subscription helpers ──────────────────────────────────────
async function getSubscriptionStatus(user_id) {
  const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
  const profile  = profiles?.[0];
  if (!profile) return { hasAccess: false, trialActive: false, subscriptionActive: false, daysLeft: 0, submissionsUsed: 0, submissionLimit: 25 };

  const trialStart  = profile.trial_start ? new Date(profile.trial_start) : new Date();
  const trialEnd    = new Date(trialStart.getTime() + 3 * 24 * 60 * 60 * 1000);
  const now         = new Date();
  const trialActive = now < trialEnd && profile.subscription_status !== "active";
  const daysLeft    = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));

  // Use stored subscription_status — fast, no Stripe call needed
  const subscriptionActive = profile.subscription_status === "active";
  const tier = subscriptionActive ? (profile.tier || "tier1") : (trialActive ? "trial" : null);

  // Check if monthly submissions need reset (paid tiers reset monthly)
  let submissionsUsed = profile.submissions_used || 0;
  if (subscriptionActive && profile.submissions_reset_at) {
    const resetAt   = new Date(profile.submissions_reset_at);
    const oneMonth  = new Date(resetAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (now > oneMonth) {
      submissionsUsed = 0;
      await sbUpdate("profiles", `id=eq.${user_id}`, { submissions_used: 0, submissions_reset_at: now.toISOString() });
    }
  }

  const limits = getLimits(tier || "trial");
  const submissionLimit = limits.submissions; // null = unlimited

  return {
    hasAccess: trialActive || subscriptionActive,
    trialActive,
    subscriptionActive,
    daysLeft,
    trialEnd: trialEnd.toISOString(),
    tier,
    submissionsUsed,
    submissionLimit,       // null for tier2 (unlimited)
    emailMonitorsUsed: profile.email_monitors_used || 0,
    emailMonitorLimit: limits.emailMonitors, // null for tier2, 0 for trial
  };
}

// ── Health ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status:"ok", acrHost:ACR_HOST||"MISSING", keySet:!!ACR_KEY, secretSet:!!ACR_SECRET, supabase:!!SUPABASE_URL, stripe:!!STRIPE_KEY });
});

// ── Auth: sign up ─────────────────────────────────────────────
app.post("/auth/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username||!email||!password) return res.status(400).json({ error:"All fields required." });

    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:"Username already taken." });

    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "apikey":SUPABASE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const authData = await authRes.json();
    console.log("Signup response:", JSON.stringify(authData));

    if (authData.error) return res.status(400).json({ error: authData.error.message || authData.error });

    const userId      = authData.user?.id;
    const accessToken = authData.access_token;

    if (!userId) return res.status(400).json({ error:"Could not create account." });

    // Save profile with trial_start and default tier
    await sbInsert("profiles", {
      id: userId,
      username,
      trial_start: new Date().toISOString(),
      tier: "trial",
      submissions_used: 0,
      email_monitors_used: 0,
      submissions_reset_at: new Date().toISOString(),
    });

    if (accessToken) {
      return res.json({ access_token: accessToken, user: { id: userId, email: authData.user.email, username } });
    }

    const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "apikey":SUPABASE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const signInData = await signInRes.json();
    if (signInData.error) return res.status(400).json({ error: "Account created! Please sign in." });

    res.json({ access_token: signInData.access_token, user: { id: signInData.user.id, email: signInData.user.email, username } });
  } catch(e) {
    console.error("Signup error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Auth: sign in ─────────────────────────────────────────────
app.post("/auth/signin", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:"All fields required." });

    const profiles = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (!Array.isArray(profiles)||profiles.length===0) return res.status(400).json({ error:"Username not found." });
    const profile = profiles[0];

    const userRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${profile.id}`, {
      headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` },
    });
    const userData = await userRes.json();
    const email    = userData?.email;
    if (!email) return res.status(400).json({ error:"Could not find account." });

    const signInRes  = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "apikey":SUPABASE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const signInData = await signInRes.json();
    if (signInData.error||signInData.error_description) return res.status(400).json({ error:signInData.error_description||signInData.error?.message||"Sign in failed." });

    res.json({ access_token:signInData.access_token, user:{ id:signInData.user.id, email:signInData.user.email, username:profile.username } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Auth: forgot password ─────────────────────────────────────
app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error:"Email required." });

    // Trigger Supabase password reset — sends their built-in email
    // We override with our own email below if RESEND_KEY is set
    const resetRes = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "apikey":SUPABASE_KEY },
      body: JSON.stringify({ email }),
    });

    // Always return success so we don't leak whether an email exists
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Auth: reset password (exchange token for new password) ────
app.post("/auth/reset-password", async (req, res) => {
  try {
    const { access_token, new_password } = req.body;
    if (!access_token||!new_password) return res.status(400).json({ error:"Missing fields." });
    if (new_password.length < 6) return res.status(400).json({ error:"Password must be 6+ characters." });

    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: { "Content-Type":"application/json", "apikey":SUPABASE_KEY, "Authorization":`Bearer ${access_token}` },
      body: JSON.stringify({ password: new_password }),
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message || data.error });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Scan ──────────────────────────────────────────────────────
app.post("/scan", upload.single("file"), async (req, res) => {
  try {
    if (!ACR_HOST||!ACR_KEY||!ACR_SECRET) return res.status(500).json({ error:"ACRCloud credentials not configured." });
    if (!req.file) return res.status(400).json({ error:"No file uploaded." });

    const { user_id } = req.body;

    // Check access + submission limits
    if (user_id && SUPABASE_URL) {
      const status = await getSubscriptionStatus(user_id);

      if (!status.hasAccess) {
        return res.status(403).json({ error:"Your free trial has ended. Subscribe to continue scanning." });
      }

      // Enforce submission limit (null = unlimited)
      if (status.submissionLimit !== null && status.submissionsUsed >= status.submissionLimit) {
        return res.status(403).json({ error:`Submission limit reached (${status.submissionsUsed}/${status.submissionLimit}). Upgrade your plan to scan more beats.` });
      }

      // Check duplicate filename
      const existing = await sbSelect("beats", `user_id=eq.${user_id}&filename=eq.${encodeURIComponent(req.file.originalname)}`);
      if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:`"${req.file.originalname}" has already been submitted.` });
    }

    const acrData = await identify(req.file.buffer, req.file.originalname, req.file.mimetype);
    console.log("ACRCloud:", JSON.stringify(acrData));

    if (user_id && SUPABASE_URL) {
      try {
        const matched      = acrData?.status?.code===0;
        const resultTitle  = matched ? acrData?.metadata?.music?.[0]?.title : null;
        const resultArtist = matched ? acrData?.metadata?.music?.[0]?.artists?.[0]?.name : null;
        const spotifyId    = matched ? acrData?.metadata?.music?.[0]?.external_metadata?.spotify?.track?.id : null;
        const youtubeId    = matched ? acrData?.metadata?.music?.[0]?.external_metadata?.youtube?.vid : null;
        const storagePath  = `${user_id}/${req.file.originalname}`;

        await storageUpload(storagePath, req.file.buffer, req.file.mimetype);
        await sbInsert("beats", {
          user_id,
          filename: req.file.originalname,
          storage_path: storagePath,
          status: matched ? "placed" : "monitoring",
          last_scanned: new Date().toISOString(),
          last_result: resultTitle,
          uploaded_at: new Date().toISOString(),
        });

        // Increment submission counter
        const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
        const profile  = profiles?.[0];
        if (profile) {
          await sbUpdate("profiles", `id=eq.${user_id}`, {
            submissions_used: (profile.submissions_used || 0) + 1,
          });
        }

        // Send placement email — only if tier allows email monitoring
        if (matched && RESEND_KEY) {
          const status = await getSubscriptionStatus(user_id);
          const canEmail = status.emailMonitorLimit === null // unlimited (tier2)
            || (status.emailMonitorLimit > 0 && status.emailMonitorsUsed < status.emailMonitorLimit);

          if (canEmail) {
            const userRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` } });
            const userData = await userRes.json();
            if (userData?.email) {
              await sendEmail(userData.email, `🎵 Placement found: "${req.file.originalname}"`, placementEmailHtml(req.file.originalname, resultTitle, resultArtist, spotifyId, youtubeId));
              if (profile && status.emailMonitorLimit !== null) {
                await sbUpdate("profiles", `id=eq.${user_id}`, { email_monitors_used: (profile.email_monitors_used || 0) + 1 });
              }
            }
          }
        }
      } catch(dbErr) { console.error("Post-scan error (non-fatal):", dbErr.message); }
    }

    res.json(acrData);
  } catch(err) { console.error("Scan error:", err.message); res.status(500).json({ error:"Scan failed: "+err.message }); }
});

// ── Stream audio ──────────────────────────────────────────────
app.get("/audio/:beat_id", async (req, res) => {
  try {
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    if (!Array.isArray(beats)||!beats[0]||!beats[0].storage_path) return res.status(404).json({ error:"Beat not found." });
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${beats[0].storage_path}`, { headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` } });
    if (!r.ok) return res.status(404).json({ error:"Audio not found." });
    res.setHeader("Content-Type", r.headers.get("content-type")||"audio/mpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    r.body.pipe(res);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Get beats ─────────────────────────────────────────────────
app.get("/beats/:user_id", async (req, res) => {
  try {
    const beats = await sbSelect("beats", `user_id=eq.${req.params.user_id}&order=uploaded_at.desc`);
    res.json(Array.isArray(beats)?beats:[]);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Delete beat ───────────────────────────────────────────────
app.delete("/beats/:beat_id", async (req, res) => {
  try {
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    if (Array.isArray(beats)&&beats.length>0&&beats[0].storage_path) await storageDelete(beats[0].storage_path);
    const ok = await sbDelete("beats", `id=eq.${req.params.beat_id}`);
    res.json({ success:ok });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Subscribe ─────────────────────────────────────────────────
app.post("/subscribe", async (req, res) => {
  try {
    const { user_id, tier } = req.body;
    if (!user_id) return res.status(400).json({ error:"Missing user_id." });
    if (!STRIPE_KEY) return res.status(500).json({ error:"Stripe not configured." });

    const priceId = tier==="tier2" ? STRIPE_PRICE_T2 : STRIPE_PRICE_T1;
    if (!priceId) return res.status(500).json({ error:"Price not configured." });

    const userRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` } });
    const userData = await userRes.json();
    const email    = userData?.email;
    if (!email) return res.status(400).json({ error:"User not found." });

    // Retry profile lookup up to 3 times
    let profile = null;
    for (let i = 0; i < 3; i++) {
      const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
      if (Array.isArray(profiles) && profiles.length > 0 && profiles[0].id) { profile = profiles[0]; break; }
      await new Promise(r => setTimeout(r, 500));
    }

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeRequest("/customers", "POST", { email, "metadata[user_id]":user_id });
      customerId = customer.id;
      if (profile) await sbUpdate("profiles", `id=eq.${user_id}`, { stripe_customer_id:customerId });
    }

    const session = await stripeRequest("/checkout/sessions", "POST", {
      customer: customerId,
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][user_id]": user_id,
      "subscription_data[metadata][tier]": tier || "tier1",
      success_url: `${APP_URL}?subscribed=true`,
      cancel_url:  `${APP_URL}?cancelled=true`,
    });

    if (session.error) return res.status(400).json({ error: session.error.message });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Subscription status ───────────────────────────────────────
app.get("/subscription/:user_id", async (req, res) => {
  try {
    const status = await getSubscriptionStatus(req.params.user_id);
    res.json(status);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Cancel subscription ───────────────────────────────────────
app.post("/cancel", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error:"Missing user_id." });
    const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
    const profile  = profiles?.[0];
    if (!profile?.stripe_customer_id) return res.status(400).json({ error:"No subscription found." });
    const subs = await stripeRequest(`/subscriptions?customer=${profile.stripe_customer_id}&status=active`);
    if (!subs.data?.length) return res.status(400).json({ error:"No active subscription found." });
    const cancelled = await stripeRequest(`/subscriptions/${subs.data[0].id}`, "POST", { cancel_at_period_end:"true" });
    if (cancelled.error) return res.status(400).json({ error:cancelled.error.message });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Stripe webhook ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const sig     = req.headers["stripe-signature"];
    const payload = req.body.toString();

    if (STRIPE_WEBHOOK) {
      const elements = sig.split(",").reduce((acc, el) => { const p=el.split("="); acc[p[0]]=p[1]; return acc; }, {});
      const ts       = elements["t"];
      const sigHash  = elements["v1"];
      const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK).update(`${ts}.${payload}`).digest("hex");
      if (expected!==sigHash) { console.error("Webhook signature mismatch"); return res.status(400).json({ error:"Invalid signature" }); }
    }

    const event = JSON.parse(payload);
    console.log("Webhook event:", event.type);

    // Subscription activated (checkout completed or renewed)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId  = session.metadata?.user_id || session.subscription_data?.metadata?.user_id;
      const tier    = session.metadata?.tier || "tier1";
      if (userId) {
        await sbUpdate("profiles", `id=eq.${userId}`, {
          subscription_status: "active",
          tier,
          submissions_used: 0,
          submissions_reset_at: new Date().toISOString(),
          email_monitors_used: 0,
        });
        console.log("Activated:", userId, "tier:", tier);
      }
    }

    // Also handle subscription-level metadata (more reliable for tier)
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub    = event.data.object;
      const userId = sub.metadata?.user_id;
      const tier   = sub.metadata?.tier || "tier1";
      if (userId && sub.status === "active") {
        await sbUpdate("profiles", `id=eq.${userId}`, {
          subscription_status: "active",
          tier,
        });
        console.log("Subscription active:", userId, "tier:", tier, "status:", sub.status);
      }
      // Handle past_due — cut off access
      if (userId && sub.status === "past_due") {
        await sbUpdate("profiles", `id=eq.${userId}`, { subscription_status: "past_due" });
        console.log("Past due:", userId);
      }
    }

    // Subscription cancelled or payment permanently failed
    if (event.type === "customer.subscription.deleted") {
      const sub    = event.data.object;
      const userId = sub.metadata?.user_id;
      if (userId) {
        await sbUpdate("profiles", `id=eq.${userId}`, { subscription_status: "cancelled", tier: "trial" });
        console.log("Cancelled:", userId);
      }
    }

    // Invoice payment failed — mark past_due
    if (event.type === "invoice.payment_failed") {
      const invoice    = event.data.object;
      const customerId = invoice.customer;
      if (customerId) {
        const profiles = await sbSelect("profiles", `stripe_customer_id=eq.${customerId}`);
        const userId   = profiles?.[0]?.id;
        if (userId) {
          await sbUpdate("profiles", `id=eq.${userId}`, { subscription_status: "past_due" });
          console.log("Payment failed, marked past_due:", userId);
        }
      }
    }

    res.json({ received: true });
  } catch(e) { console.error("Webhook error:", e.message); res.status(400).json({ error:e.message }); }
});

// ── Profiles ──────────────────────────────────────────────────
app.post("/profile", async (req, res) => {
  try {
    const { user_id, username } = req.body;
    if (!user_id||!username) return res.status(400).json({ error:"Missing fields." });
    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:"Username already taken." });
    const result = await sbInsert("profiles", { id:user_id, username });
    res.json(result);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get("/profile/:user_id", async (req, res) => {
  try {
    const profile = await sbSelect("profiles", `id=eq.${req.params.user_id}`);
    res.json(Array.isArray(profile)?profile[0]||null:null);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Daily rescan ──────────────────────────────────────────────
app.post("/rescan", async (req, res) => {
  const secret = req.headers["x-rescan-secret"];
  if (secret!==RESCAN_SECRET) return res.status(401).json({ error:"Unauthorized" });
  try {
    const beats = await sbSelect("beats", "status=eq.monitoring&order=last_scanned.asc");
    if (!Array.isArray(beats)||beats.length===0) return res.json({ message:"No beats to rescan.", count:0 });
    console.log(`Rescanning ${beats.length} beats...`);
    let newMatches = 0;

    for (const beat of beats) {
      try {
        if (!beat.storage_path) continue;

        // Only rescan if user has active access
        const status = await getSubscriptionStatus(beat.user_id);
        if (!status.hasAccess) { console.log(`Skipping beat ${beat.id} — user has no access`); continue; }

        const buffer = await storageDownload(beat.storage_path);
        if (!buffer) continue;
        const acrData = await identify(buffer, beat.filename, "audio/mpeg");
        const matched = acrData?.status?.code===0;

        if (matched) {
          const title     = acrData?.metadata?.music?.[0]?.title;
          const artist    = acrData?.metadata?.music?.[0]?.artists?.[0]?.name;
          const spotifyId = acrData?.metadata?.music?.[0]?.external_metadata?.spotify?.track?.id;
          const youtubeId = acrData?.metadata?.music?.[0]?.external_metadata?.youtube?.vid;

          if (title !== beat.last_result) {
            await sbUpdate("beats", `id=eq.${beat.id}`, { status:"placed", last_scanned:new Date().toISOString(), last_result:title });

            // Only send email if tier allows it
            const canEmail = RESEND_KEY && (
              status.emailMonitorLimit === null ||
              (status.emailMonitorLimit > 0 && status.emailMonitorsUsed < status.emailMonitorLimit)
            );

            if (canEmail) {
              const userRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${beat.user_id}`, { headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` } });
              const userData = await userRes.json();
              if (userData?.email) {
                await sendEmail(userData.email, `🎵 New placement found: "${beat.filename}"`, placementEmailHtml(beat.filename, title, artist, spotifyId, youtubeId));
                newMatches++;
                // Increment email monitor counter if not unlimited
                if (status.emailMonitorLimit !== null) {
                  const profiles = await sbSelect("profiles", `id=eq.${beat.user_id}`);
                  const profile  = profiles?.[0];
                  if (profile) await sbUpdate("profiles", `id=eq.${beat.user_id}`, { email_monitors_used: (profile.email_monitors_used || 0) + 1 });
                }
              }
            }
          }
        } else {
          await sbUpdate("beats", `id=eq.${beat.id}`, { last_scanned:new Date().toISOString() });
        }
        await new Promise(r => setTimeout(r, 500));
      } catch(e) { console.error(`Error rescanning beat ${beat.id}:`, e.message); }
    }

    res.json({ message:"Rescan complete.", total:beats.length, newMatches });
  } catch(e) { console.error("Rescan error:", e.message); res.status(500).json({ error:e.message }); }
});

app.listen(port, "0.0.0.0", () => console.log(`Server listening on 0.0.0.0:${port}`));
