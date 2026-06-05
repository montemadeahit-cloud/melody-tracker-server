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

app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const ACR_HOST         = process.env.ACR_HOST;
const ACR_KEY          = process.env.ACR_KEY;
const ACR_SECRET       = process.env.ACR_SECRET;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY       = process.env.RESEND_API_KEY;
const FROM_EMAIL       = process.env.FROM_EMAIL || "alerts@trackmyplacements.com";
const RESCAN_SECRET    = process.env.RESCAN_SECRET || "rescan-secret";
const STRIPE_KEY       = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_T1  = process.env.STRIPE_PRICE_ID;
const STRIPE_PRICE_T2  = process.env.STRIPE_PRICE_ID_TIER2;
const STRIPE_WEBHOOK   = process.env.STRIPE_WEBHOOK_SECRET;
const APP_URL          = process.env.APP_URL || "https://trackmyplacements.com";

// ── Tier limits ───────────────────────────────────────────────
const LIMITS = {
  trial: { submissions: 25,   emailMonitors: 0,    label: "Free Trial" },
  tier1: { submissions: 100,  emailMonitors: 100,  label: "Tier 1"     },
  tier2: { submissions: null, emailMonitors: null, label: "Tier 2"     },
};
function getLimits(tier) { return LIMITS[tier] || LIMITS.trial; }

// ── IP helpers ────────────────────────────────────────────────
function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress
    || "unknown";
}

// In-memory rate limiter — max 5 signups per IP per hour
const signupAttempts = new Map();
function checkSignupRate(ip) {
  const now = Date.now(), window = 60*60*1000, max = 5;
  const entry = signupAttempts.get(ip);
  if (!entry || now - entry.firstAt > window) { signupAttempts.set(ip, { count:1, firstAt:now }); return true; }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}
// Clear rate limit for an IP (call this if you get locked out during testing)
app.get("/admin/reset-ratelimit", (req, res) => {
  signupAttempts.clear();
  res.json({ cleared: true });
});

// ── Supabase helpers ──────────────────────────────────────────
async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`,"Prefer":"return=representation"}, body:JSON.stringify(row),
  });
  const text = await r.text();
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); } catch(e) { console.error("sbInsert parse error:", table, r.status, text.slice(0,200)); return null; }
}
async function sbSelect(table, filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers:{"apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`},
  });
  const text = await r.text();
  if (!text || !text.trim()) { console.error("sbSelect empty response:", r.status, table, filter); return []; }
  try { return JSON.parse(text); } catch(e) { console.error("sbSelect parse error:", table, r.status, text.slice(0,200)); return []; }
}
async function sbUpdate(table, filter, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method:"PATCH", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`}, body:JSON.stringify(row),
  });
  const text = await r.text();
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); } catch(e) { return null; }
}
async function sbDelete(table, filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method:"DELETE", headers:{"apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`},
  }); return r.ok;
}

// ── Supabase Storage ──────────────────────────────────────────
async function storageUpload(path, buffer, mimetype) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${path}`, {
    method:"POST", headers:{"Content-Type":mimetype,"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`}, body:buffer,
  }); return r.json();
}
async function storageDownload(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${path}`, {
    headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`},
  }); if (!r.ok) return null; return r.buffer();
}
async function storageDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${path}`, {
    method:"DELETE", headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`},
  }); return r.ok;
}

// ── Audio segment slicer ──────────────────────────────────────
// 5 slices at music-structure-aware positions:
//   10% — just past the intro
//   25% — first verse/hook entry
//   45% — mid-track hook (most distinctive)
//   62% — second chorus / bridge
//   78% — late verse, before outro
// All slices are ~20s. Short files skip slicing and send as-is.
const SLICE_BYTES    = 32 * 1024 * 20;  // ~20s at 256kbps equiv
const MIN_SCAN_BYTES = 32 * 1024 * 15;  // skip slicing if file is under ~15s
function getSlices(buffer) {
  if (buffer.length <= MIN_SCAN_BYTES) return [buffer];
  const s   = SLICE_BYTES;
  const len = buffer.length;
  const offsets = [0.10, 0.25, 0.45, 0.62, 0.78].map(p => Math.floor(len * p));
  return offsets.map(o => buffer.slice(o, Math.min(o + s, len)));
}

// ── Result normaliser ─────────────────────────────────────────
// Converts an AudD result into the same shape as an ACRCloud music entry
// so both engines feed into the same merge function.
function normaliseAuddResult(r) {
  if (!r || !r.title) return null;
  const score = r.score != null ? r.score * 100 : 85; // AudD returns 0–1
  const external_metadata = {};
  if (r.spotify?.id)         external_metadata.spotify = { track: { id: r.spotify.id }, popularity: r.spotify.popularity || null };
  if (r.itunes?.trackId)     external_metadata.itunes  = { track: { id: r.itunes.trackId } };
  if (r.deezer?.id)          external_metadata.deezer  = { track: { id: String(r.deezer.id) } };
  if (r.youtube?.videoid)    external_metadata.youtube = { vid: r.youtube.videoid };
  return {
    title:             r.title,
    artists:           r.artist ? [{ name: r.artist }] : [],
    release_date:      r.release_date || null,
    score,
    external_metadata,
    _source:           "audd",
  };
}

// ── Merge results from all engines + all slices ───────────────
// De-dupes by title (case-insensitive), keeps highest score per title,
// marks the source engine on each result for debugging.
function mergeAllResults(responses) {
  const primary   = responses.find(r => r?.status?.code === 0) || responses[0] || {};
  const musicMap  = new Map();
  const hummingMap = new Map();

  for (const r of responses) {
    for (const m of (r?.metadata?.music || [])) {
      const key = (m.title || "").toLowerCase().trim();
      if (!key) continue;
      const existing = musicMap.get(key);
      if (!existing || (m.score || 0) > (existing.score || 0)) musicMap.set(key, m);
    }
    for (const m of (r?.metadata?.humming || [])) {
      const key = (m.title || "").toLowerCase().trim();
      if (!key) continue;
      const existing = hummingMap.get(key);
      if (!existing || (m.score || 0) > (existing.score || 0)) hummingMap.set(key, m);
    }
  }

  const music   = [...musicMap.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  const humming = [...hummingMap.values()].sort((a, b) => (b.score || 0) - (a.score || 0));

  return {
    ...primary,
    status:   music.length > 0 ? { code: 0, msg: "Success" } : (primary?.status || { code: 1001, msg: "No result" }),
    metadata: { ...(primary?.metadata || {}), music, humming },
  };
}
// Creates a unique content-based ID from the audio file itself
// This is stored permanently so the beat can be identified in future
function computeAudioHash(buffer) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return "TMP-" + hash.slice(0, 32).toUpperCase();
}

// ── ACRCloud ──────────────────────────────────────────────────
async function identifyACR(buffer, filename, mimetype) {
  const timestamp = Math.floor(Date.now()/1000);
  const sig = crypto.createHmac("sha1",ACR_SECRET).update(`POST\n/v1/identify\n${ACR_KEY}\naudio\n1\n${timestamp}`).digest("base64");
  const form = new FormData();
  form.append("sample", buffer, { filename, contentType: mimetype });
  form.append("access_key",        ACR_KEY);
  form.append("data_type",         "audio");
  form.append("signature_version", "1");
  form.append("signature",         sig);
  form.append("sample_bytes",      buffer.length.toString());
  form.append("timestamp",         timestamp.toString());
  form.append("return",            "music,beats,genre,bpm,key");
  const res = await fetch(`https://${ACR_HOST}/v1/identify`, { method:"POST", body:form });
  return res.json();
}

// ── AudD ──────────────────────────────────────────────────────
// Second fingerprint engine — different database, parallel to ACRCloud.
// Returns results normalised into ACRCloud music-entry shape.
const AUDD_KEY = process.env.AUDD_API_TOKEN;
async function identifyAudd(buffer, filename) {
  if (!AUDD_KEY) return null;
  try {
    const form = new FormData();
    form.append("file",    buffer, { filename, contentType: "audio/mpeg" });
    form.append("api_token", AUDD_KEY);
    form.append("return",    "spotify,deezer,itunes,youtube");
    const res  = await fetch("https://api.audd.io/", { method:"POST", body:form });
    const data = await res.json();
    if (data?.status !== "success" || !data?.result) return null;
    const norm = normaliseAuddResult(data.result);
    if (!norm) return null;
    // Wrap in ACRCloud envelope shape so mergeAllResults handles it uniformly
    return { status: { code: 0, msg: "Success" }, metadata: { music: [norm], humming: [] } };
  } catch(e) {
    console.error("AudD error:", e.message);
    return null;
  }
}

// ── Fan-out: all slices × both engines, fully parallel ────────
async function scanAllEngines(buffer, filename, mimetype) {
  const slices = getSlices(buffer);
  // Fire every ACRCloud slice + AudD on the best slice (middle) simultaneously
  const middleSlice = slices[Math.floor(slices.length / 2)];
  const tasks = [
    ...slices.map(s => identifyACR(s, filename, mimetype)),
    identifyAudd(middleSlice, filename),
  ];
  const results = await Promise.all(tasks);
  const valid   = results.filter(Boolean);
  console.log("Scan engines:", results.map((r,i) => {
    if (!r) return `task${i}:skipped`;
    return `task${i}:code=${r?.status?.code},hits=${r?.metadata?.music?.length||0}`;
  }));
  return mergeAllResults(valid);
}

// Keep backward-compat alias used by rescan route
async function identify(buffer, filename, mimetype) {
  return identifyACR(buffer, filename, mimetype);
}

// ── Stripe ────────────────────────────────────────────────────
async function stripeRequest(path, method="GET", body=null) {
  const opts = { method, headers:{"Authorization":`Bearer ${STRIPE_KEY}`,"Content-Type":"application/x-www-form-urlencoded"} };
  if (body) opts.body = new URLSearchParams(body).toString();
  const r = await fetch(`https://api.stripe.com/v1${path}`,opts); return r.json();
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  try {
    const r = await fetch("https://api.resend.com/emails",{
      method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${RESEND_KEY}`},
      body:JSON.stringify({from:FROM_EMAIL,to,subject,html}),
    }); const d=await r.json(); console.log("Email sent:",JSON.stringify(d)); return d;
  } catch(e) { console.error("Email error:",e.message); }
}

function baseEmail(content) {
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#16161a;color:#f0ece4;border-radius:16px;">
    <div style="font-size:22px;font-weight:700;margin-bottom:4px;">TrackMy<span style="color:#F5A800;">Placements</span></div>
    <div style="font-size:11px;color:#6b7385;letter-spacing:.1em;text-transform:uppercase;margin-bottom:28px;">Placement Location Engine</div>
    ${content}
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:#6b7385;">
      <a href="${APP_URL}" style="color:#F5A800;">trackmyplacements.com</a>
    </div>
  </div>`;
}

function placementEmailHtml(filename, title, artist, spotifyId, youtubeId) {
  const link = spotifyId ? `https://open.spotify.com/track/${spotifyId}` : youtubeId ? `https://youtube.com/watch?v=${youtubeId}` : null;
  return baseEmail(`
    <div style="background:rgba(245,168,0,0.08);border:1px solid rgba(245,168,0,0.2);border-radius:12px;padding:20px;margin-bottom:20px;">
      <div style="font-size:13px;color:#F5A800;margin-bottom:10px;text-transform:uppercase;letter-spacing:.08em;">Placement detected</div>
      <div style="font-size:18px;font-weight:700;margin-bottom:4px;">${title}</div>
      <div style="font-size:14px;color:rgba(240,236,228,0.6);">${artist||"Unknown artist"}</div>
    </div>
    <div style="font-size:13px;color:rgba(240,236,228,0.6);margin-bottom:6px;">Your beat</div>
    <div style="font-size:14px;font-weight:600;margin-bottom:20px;">${filename}</div>
    ${link?`<a href="${link}" style="display:inline-block;background:#F5A800;color:#0e0e10;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px;text-decoration:none;">Listen to the track ↗</a>`:""}
  `);
}

function passwordResetEmailHtml(resetUrl) {
  return baseEmail(`
    <div style="font-size:18px;font-weight:700;margin-bottom:12px;">Reset your password</div>
    <p style="font-size:14px;color:rgba(240,236,228,0.7);line-height:1.7;margin-bottom:24px;">We received a request to reset your password. This link expires in <strong style="color:#f0ece4;">1 hour</strong>.</p>
    <a href="${resetUrl}" style="display:inline-block;background:#F5A800;color:#0e0e10;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px;text-decoration:none;">Reset my password ↗</a>
    <p style="margin-top:20px;font-size:12px;color:#6b7385;">If you didn't request this, ignore this email.</p>
  `);
}

function welcomeEmailHtml(username) {
  return baseEmail(`
    <div style="font-size:18px;font-weight:700;margin-bottom:12px;">Welcome, ${username} 🎵</div>
    <p style="font-size:14px;color:rgba(240,236,228,0.7);line-height:1.7;margin-bottom:20px;">Your free 3-day trial is active. Upload your beats and we'll scan them instantly.</p>
    <div style="background:rgba(245,168,0,0.08);border:1px solid rgba(245,168,0,0.2);border-radius:12px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:13px;font-weight:600;color:#F5A800;margin-bottom:8px;">Your trial includes</div>
      <div style="font-size:13px;color:rgba(240,236,228,0.7);line-height:1.8;">✓ 25 beat submissions<br/>✓ Locate undetected placements<br/>✓ Build your catalog</div>
    </div>
    <a href="${APP_URL}" style="display:inline-block;background:#F5A800;color:#0e0e10;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px;text-decoration:none;">Start scanning ↗</a>
  `);
}

// ── Subscription status ───────────────────────────────────────
async function getSubscriptionStatus(user_id) {
  const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
  const profile  = profiles?.[0];
  if (!profile) return { hasAccess:false, trialActive:false, subscriptionActive:false, daysLeft:0, submissionsUsed:0, submissionLimit:25, emailMonitorsUsed:0, emailMonitorLimit:0 };

  const trialStart = profile.trial_start ? new Date(profile.trial_start) : new Date();
  const trialEnd   = new Date(trialStart.getTime() + 3*24*60*60*1000);
  const now        = new Date();
  const trialActive        = now < trialEnd && profile.subscription_status !== "active";
  const daysLeft           = Math.max(0, Math.ceil((trialEnd - now)/(1000*60*60*24)));
  const subscriptionActive = profile.subscription_status === "active";
  const pastDue            = profile.subscription_status === "past_due";
  const tier               = subscriptionActive ? (profile.tier||"tier1") : (trialActive ? "trial" : null);

  // Monthly reset for paid tiers
  let submissionsUsed = profile.submissions_used || 0;
  let emailMonitorsUsed = profile.email_monitors_used || 0;
  if (subscriptionActive && profile.submissions_reset_at) {
    const oneMonth = new Date(new Date(profile.submissions_reset_at).getTime() + 30*24*60*60*1000);
    if (now > oneMonth) {
      submissionsUsed = 0; emailMonitorsUsed = 0;
      await sbUpdate("profiles", `id=eq.${user_id}`, { submissions_used:0, email_monitors_used:0, submissions_reset_at:now.toISOString() });
    }
  }

  const limits = getLimits(tier || "trial");
  return {
    hasAccess: (trialActive || subscriptionActive) && !pastDue,
    trialActive, subscriptionActive, pastDue, daysLeft,
    trialEnd: trialEnd.toISOString(), tier, tierLabel: limits.label,
    submissionsUsed, submissionLimit: limits.submissions,
    emailMonitorsUsed, emailMonitorLimit: limits.emailMonitors,
  };
}

// ── Health ────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status:"ok",
  acrHost:ACR_HOST||"MISSING",
  keySet:!!ACR_KEY,
  secretSet:!!ACR_SECRET,
  supabaseUrl:!!SUPABASE_URL,
  supabaseKey:!!SUPABASE_KEY,
  supabaseService:!!SUPABASE_SERVICE,
  stripe:!!STRIPE_KEY,
  stripePriceT1:!!STRIPE_PRICE_T1,
  stripePriceT2:!!STRIPE_PRICE_T2,
  stripeWebhook:!!STRIPE_WEBHOOK,
  resend:!!RESEND_KEY,
  appUrl:APP_URL,
}));

// ── Auth: sign up ─────────────────────────────────────────────
app.post("/auth/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username||!email||!password) return res.status(400).json({ error:"All fields required." });

    const ip = getIP(req);
    if (!checkSignupRate(ip)) return res.status(429).json({ error:"Too many accounts created from this connection. Try again later." });

    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:"Username already taken." });

    // Block if this IP already has an active trial
    const ipProfiles = await sbSelect("profiles", `signup_ip=eq.${encodeURIComponent(ip)}`);
    if (Array.isArray(ipProfiles)&&ipProfiles.length>0) {
      for (const p of ipProfiles) {
        if (p.subscription_status==="active") continue;
        const te = new Date((p.trial_start ? new Date(p.trial_start) : new Date(p.created_at)).getTime() + 3*24*60*60*1000);
        if (new Date() < te) return res.status(429).json({ error:"A free trial is already active from this network. Subscribe to continue." });
      }
    }

    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY}, body:JSON.stringify({ email, password }),
    });
    const authData = await authRes.json();
    console.log("Signup response status:", authRes.status, "user:", authData.user?.id, "error:", authData.error?.message);

    if (authData.error) return res.status(400).json({ error:authData.error.message||authData.error });

    const userId      = authData.user?.id;
    const accessToken = authData.access_token;

    if (!userId) {
      console.error("Signup returned no user ID:", JSON.stringify(authData).slice(0,400));
      return res.status(400).json({ error:"Account could not be created. This email may already be registered — try signing in instead." });
    }

    // Insert profile — wrapped in try/catch so auth account isn't lost if this fails
    try {
      const insertResult = await sbInsert("profiles", {
        id: userId,
        username,
        trial_start: new Date().toISOString(),
        tier: "trial",
        submissions_used: 0,
        email_monitors_used: 0,
        submissions_reset_at: new Date().toISOString(),
        signup_ip: ip,
        subscription_status: "trial",
      });
      console.log("Profile insert result:", JSON.stringify(insertResult)?.slice(0,200));
    } catch(profileErr) {
      console.error("Profile insert failed:", profileErr.message);
      // Don't block signup — user can still sign in, profile will be missing but recoverable
    }

    // Send branded welcome email (non-blocking)
    if (RESEND_KEY) {
      sendEmail(email, "Welcome to TrackMyPlacements 🎵", welcomeEmailHtml(username)).catch(console.error);
    }

    if (accessToken) return res.json({ access_token:accessToken, user:{ id:userId, email:authData.user?.email||email, username } });

    const siRes  = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY}, body:JSON.stringify({ email, password }) });
    const siData = await siRes.json();
    if (siData.error) return res.status(400).json({ error:"Account created! Please sign in." });
    res.json({ access_token:siData.access_token, user:{ id:siData.user?.id||userId, email:siData.user?.email||email, username } });
  } catch(e) { console.error("Signup error:",e.message); res.status(500).json({ error:e.message }); }
});

// ── Auth: sign in ─────────────────────────────────────────────
app.post("/auth/signin", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:"All fields required." });
    const profiles = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (!Array.isArray(profiles)||profiles.length===0) {
      // Also try looking up by checking if username matches an auth user with that email pattern
      return res.status(400).json({ error:"Username not found. If you just signed up, your account may still be setting up — please wait a moment and try again." });
    }
    const profile = profiles[0];
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${profile.id}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
    const userData = await userRes.json();
    if (!userData?.email) return res.status(400).json({ error:"Could not find account." });
    const siRes  = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY}, body:JSON.stringify({ email:userData.email, password }) });
    const siData = await siRes.json();
    if (siData.error||siData.error_description) return res.status(400).json({ error:siData.error_description||siData.error?.message||"Sign in failed." });
    const userId = siData.user?.id || profile.id;
    const userEmail = siData.user?.email || userData.email;
    res.json({ access_token:siData.access_token, user:{ id:userId, email:userEmail, username:profile.username } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Auth: forgot password (Resend branded) ────────────────────
app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error:"Email required." });

    // Generate a password reset link via Supabase admin API
    const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method:"POST",
      headers:{"Content-Type":"application/json","apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`},
      body:JSON.stringify({ type:"recovery", email, options:{ redirectTo:`${APP_URL}?type=recovery` } }),
    });
    const linkData = await linkRes.json();
    console.log("Reset link response:", JSON.stringify(linkData));

    if (linkData.action_link && RESEND_KEY) {
      await sendEmail(email, "Reset your TrackMyPlacements password", passwordResetEmailHtml(linkData.action_link));
    } else if (!linkData.action_link) {
      // Fallback: trigger Supabase's built-in recovery email
      await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method:"POST",
        headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY},
        body:JSON.stringify({ email }),
      });
    }

    // Always return success — never leak whether email exists
    res.json({ success:true });
  } catch(e) {
    console.error("Forgot password error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ── Auth: reset password ──────────────────────────────────────
app.post("/auth/reset-password", async (req, res) => {
  try {
    const { access_token, new_password } = req.body;
    if (!access_token||!new_password) return res.status(400).json({ error:"Missing fields." });
    if (new_password.length<6) return res.status(400).json({ error:"Password must be 6+ characters." });
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method:"PUT", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY,"Authorization":`Bearer ${access_token}`}, body:JSON.stringify({ password:new_password }),
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error:data.error.message||data.error });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Scan ──────────────────────────────────────────────────────
app.post("/scan", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File size is too large. Consider uploading an .mp3" });
    }
    if (err) return res.status(400).json({ error: "Upload error: " + err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!ACR_HOST||!ACR_KEY||!ACR_SECRET) return res.status(500).json({ error:"ACRCloud credentials not configured." });
    if (!req.file) return res.status(400).json({ error:"No file uploaded." });
    const { user_id } = req.body;

    if (user_id && SUPABASE_URL) {
      const status = await getSubscriptionStatus(user_id);
      if (!status.hasAccess) return res.status(403).json({ error: status.pastDue ? "Your payment is past due. Please update billing to continue scanning." : "Your free trial has ended. Subscribe to continue scanning." });
      if (status.submissionLimit!==null && status.submissionsUsed>=status.submissionLimit) return res.status(403).json({ error:`Submission limit reached (${status.submissionsUsed}/${status.submissionLimit}). Upgrade to scan more beats.` });
      const existing = await sbSelect("beats", `user_id=eq.${user_id}&filename=eq.${encodeURIComponent(req.file.originalname)}`);
      if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:`"${req.file.originalname}" has already been submitted.` });
    }

    // Hash the FULL file — permanent fingerprint ID is always based on the complete audio
    const audioHash     = computeAudioHash(req.file.buffer);
    const fingerprintId = audioHash;

    // Fan out across 5 slices × 2 engines (ACRCloud + AudD), all in parallel
    const acrData = await scanAllEngines(req.file.buffer, req.file.originalname, req.file.mimetype);

    // Extract BPM, key, duration from ACRCloud response if available
    // Fall back to client-side detected values if ACRCloud didn't return them
    const clientKey = req.body.client_key || null;
    const clientBpm = req.body.client_bpm ? parseFloat(req.body.client_bpm) : null;

    // Extract BPM from filename — producers commonly include it at the end
    // Matches patterns like: "mysong 140bpm.mp3", "beat_95 BPM.wav", "trap140.mp3", "[140]", "(95bpm)"
    let filenameBpm = null;
    const bpmMatch = req.file.originalname.match(/[\s_\-\[\(](\d{2,3})[\s_\-\]\)]?(?:bpm)?(?:\.|$)/i)
      || req.file.originalname.match(/(\d{2,3})\s*bpm/i)
      || req.file.originalname.match(/[\s_\-](\d{2,3})(?:\.|_|-|\s|$)/i);
    if (bpmMatch) {
      const candidate = parseInt(bpmMatch[1]);
      // Sanity check — realistic BPM range
      if (candidate >= 60 && candidate <= 200) filenameBpm = candidate;
    }
    const metadata  = acrData?.metadata || {};
    const acrBpm    = metadata.beats?.bpm || metadata.music?.[0]?.bpm || null;
    const acrKey    = metadata.music?.[0]?.key?.note
      ? (metadata.music[0].key.note + (metadata.music[0].key.scale ? " " + metadata.music[0].key.scale : ""))
      : null;
    const durationMs = metadata.music?.[0]?.duration_ms || null;
    console.log("BPM sources — ACR:", metadata.beats?.bpm, "client:", clientBpm, "filename:", filenameBpm);

    // Priority: ACRCloud (most accurate) → filename (explicit) → client-detected (analyzed)
    const bpm      = acrBpm || filenameBpm || clientBpm;
    const audioKey = acrKey || clientKey;

    if (user_id && SUPABASE_URL) {
      try {
        // Quality filter — only block truly garbage results, allow missing artist
        const BAD_TITLES = ["unknown","untitled","","no title","n/a","na","null","undefined"];
        function isGoodMatch(m) {
          if (!m) return false;
          const score = m.score || 100;
          if (score < 90) return false;
          const title = (m.title || "").toLowerCase().trim();
          if (BAD_TITLES.includes(title)) return false;
          if (title.includes("untitled")) return false;
          return true;
        }
        const rawMatched = acrData?.status?.code === 0;
        const musicList  = acrData?.metadata?.music || [];
        const goodMusic  = rawMatched ? musicList.filter(isGoodMatch) : [];
        const matched    = goodMusic.length > 0;
        const bestMatch  = matched ? goodMusic[0] : null;
        const title      = bestMatch?.title || null;
        const artist     = bestMatch?.artists?.[0]?.name || null;
        const spotifyId  = bestMatch?.external_metadata?.spotify?.track?.id || null;
        const youtubeId  = bestMatch?.external_metadata?.youtube?.vid || null;
        const storagePath = `${user_id}/${req.file.originalname}`;

        await storageUpload(storagePath, req.file.buffer, req.file.mimetype);
        await sbInsert("beats", {
          user_id,
          filename:       req.file.originalname,
          storage_path:   storagePath,
          status:         matched ? "placed" : "monitoring",
          last_scanned:   new Date().toISOString(),
          last_result:    title,
          last_artist:    artist || null,
          spotify_id:     spotifyId || null,
          youtube_id:     youtubeId || null,
          uploaded_at:    new Date().toISOString(),
          fingerprint_id: fingerprintId,
          audio_hash:     audioHash,
          bpm:            bpm || null,
          audio_key:      audioKey || null,
          duration_ms:    durationMs || null,
        });

        // Increment submission counter
        const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
        const profile   = profiles?.[0];
        if (profile) await sbUpdate("profiles", `id=eq.${user_id}`, { submissions_used:(profile.submissions_used||0)+1 });

        // Email if tier allows
        if (matched && RESEND_KEY && profile) {
          const st = await getSubscriptionStatus(user_id);
          const canEmail = st.emailMonitorLimit===null || (st.emailMonitorLimit>0 && st.emailMonitorsUsed<st.emailMonitorLimit);
          if (canEmail) {
            const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
            const uData = await uRes.json();
            if (uData?.email) {
              await sendEmail(uData.email, `🎵 Placement found: "${req.file.originalname}"`, placementEmailHtml(req.file.originalname, title, artist, spotifyId, youtubeId));
              if (st.emailMonitorLimit!==null) await sbUpdate("profiles", `id=eq.${user_id}`, { email_monitors_used:(profile.email_monitors_used||0)+1 });
            }
          }
        }
      } catch(dbErr) { console.error("Post-scan error (non-fatal):",dbErr.message); }
    }

    // Return ACR data with fingerprint ID appended so frontend can display it
    res.json({ ...acrData, fingerprint_id: fingerprintId, bpm, audio_key: audioKey });
  } catch(err) { console.error("Scan error:",err.message); res.status(500).json({ error:"Scan failed: "+err.message }); }
});

// ── Stream audio ──────────────────────────────────────────────
app.get("/audio/:beat_id", async (req, res) => {
  try {
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    if (!Array.isArray(beats)||!beats[0]?.storage_path) return res.status(404).json({ error:"Beat not found." });
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${beats[0].storage_path}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
    if (!r.ok) return res.status(404).json({ error:"Audio not found." });
    res.setHeader("Content-Type", r.headers.get("content-type")||"audio/mpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    r.body.pipe(res);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Get beats ─────────────────────────────────────────────────
app.get("/beats/:user_id", async (req, res) => {
  try { const beats = await sbSelect("beats", `user_id=eq.${req.params.user_id}&order=uploaded_at.desc`); res.json(Array.isArray(beats)?beats:[]); }
  catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Delete beat ───────────────────────────────────────────────
app.delete("/beats/:beat_id", async (req, res) => {
  try {
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    if (Array.isArray(beats)&&beats.length>0&&beats[0].storage_path) await storageDelete(beats[0].storage_path);
    res.json({ success: await sbDelete("beats", `id=eq.${req.params.beat_id}`) });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Get beat fingerprint ──────────────────────────────────────
app.get("/beats/:beat_id/fingerprint", async (req, res) => {
  try {
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    const beat  = beats?.[0];
    if (!beat) return res.status(404).json({ error:"Beat not found." });
    res.json({
      fingerprint_id: beat.fingerprint_id || null,
      audio_hash:     beat.audio_hash || null,
      bpm:            beat.bpm || null,
      audio_key:      beat.audio_key || null,
      duration_ms:    beat.duration_ms || null,
      filename:       beat.filename,
      uploaded_at:    beat.uploaded_at,
      status:         beat.status,
    });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Subscribe ─────────────────────────────────────────────────
app.post("/subscribe", async (req, res) => {
  try {
    const { user_id, tier } = req.body;
    console.log("Subscribe request:", user_id, tier);
    if (!user_id) return res.status(400).json({ error:"Missing user_id." });
    if (!STRIPE_KEY) return res.status(500).json({ error:"Stripe not configured." });
    const priceId = tier==="tier2" ? STRIPE_PRICE_T2 : STRIPE_PRICE_T1;
    console.log("Price ID:", priceId, "T1:", STRIPE_PRICE_T1, "T2:", STRIPE_PRICE_T2);
    if (!priceId) return res.status(500).json({ error:"Price ID not configured. Check STRIPE_PRICE_ID env var." });

    const uRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
    const uData = await uRes.json();
    console.log("User email:", uData?.email);
    if (!uData?.email) return res.status(400).json({ error:"User not found." });

    let profile = null;
    for (let i=0; i<3; i++) {
      const ps = await sbSelect("profiles", `id=eq.${user_id}`);
      if (Array.isArray(ps)&&ps.length>0&&ps[0].id) { profile=ps[0]; break; }
      await new Promise(r=>setTimeout(r,500));
    }
    console.log("Profile:", profile?.id, "customer:", profile?.stripe_customer_id, "status:", profile?.subscription_status);

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      console.log("Creating new Stripe customer for", uData.email);
      const cust = await stripeRequest("/customers","POST",{ email:uData.email, "metadata[user_id]":user_id });
      console.log("Customer created:", cust.id, cust.error);
      if (cust.error) return res.status(400).json({ error:"Could not create customer: "+cust.error.message });
      customerId = cust.id;
      if (profile) await sbUpdate("profiles", `id=eq.${user_id}`, { stripe_customer_id:customerId });
    }

    // If already subscribed, send to Stripe billing portal to upgrade safely
    if (profile?.subscription_status === "active" && customerId) {
      console.log("Active sub found, redirecting to billing portal");
      const portal = await stripeRequest("/billing_portal/sessions", "POST", {
        customer: customerId,
        return_url: `${APP_URL}?subscribed=true`,
      });
      console.log("Portal:", portal.url, portal.error);
      if (portal.url) return res.json({ url: portal.url });
      if (portal.error) return res.status(400).json({ error: portal.error.message });
    }

    console.log("Creating checkout session for customer:", customerId, "price:", priceId);
    const session = await stripeRequest("/checkout/sessions","POST",{
      customer:customerId, mode:"subscription",
      "line_items[0][price]":priceId, "line_items[0][quantity]":"1",
      "metadata[user_id]":user_id, "metadata[tier]":tier||"tier1",
      "subscription_data[metadata][user_id]":user_id, "subscription_data[metadata][tier]":tier||"tier1",
      success_url:`${APP_URL}?subscribed=true`, cancel_url:`${APP_URL}?cancelled=true`,
    });
    console.log("Session:", session.url, session.error);
    if (session.error) return res.status(400).json({ error:session.error.message });

    if (profile && customerId) {
      await sbUpdate("profiles", `id=eq.${user_id}`, { stripe_customer_id:customerId });
    }

    res.json({ url:session.url });
  } catch(e) {
    console.error("Subscribe error:", e.message, e.stack);
    res.status(500).json({ error:e.message });
  }
});

// ── Subscription status ───────────────────────────────────────
app.get("/subscription/:user_id", async (req, res) => {
  try { res.json(await getSubscriptionStatus(req.params.user_id)); }
  catch(e) { res.status(500).json({ error:e.message }); }
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
    const cancelled = await stripeRequest(`/subscriptions/${subs.data[0].id}`,"POST",{ cancel_at_period_end:"true" });
    if (cancelled.error) return res.status(400).json({ error:cancelled.error.message });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Stripe webhook ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const sig=req.headers["stripe-signature"], payload=req.body.toString();
    if (STRIPE_WEBHOOK) {
      const el=sig.split(",").reduce((a,e)=>{const p=e.split("=");a[p[0]]=p[1];return a;},{});
      const expected=crypto.createHmac("sha256",STRIPE_WEBHOOK).update(`${el.t}.${payload}`).digest("hex");
      if (expected!==el.v1) { console.error("Webhook sig mismatch"); return res.status(400).json({ error:"Invalid signature" }); }
    }
    const event=JSON.parse(payload);
    console.log("Webhook:",event.type);

    // Helper: resolve user_id and tier from any Stripe event object
    async function resolveUser(obj) {
      let userId = obj.metadata?.user_id;
      let tier   = obj.metadata?.tier || "tier1";
      // Fall back to customer ID lookup if metadata missing
      if (!userId && obj.customer) {
        const ps = await sbSelect("profiles", `stripe_customer_id=eq.${obj.customer}`);
        userId = ps?.[0]?.id;
      }
      // Detect tier from price ID if not in metadata
      const priceId = obj.items?.data?.[0]?.price?.id || obj.plan?.id;
      if (priceId && priceId === STRIPE_PRICE_T2) tier = "tier2";
      else if (priceId) tier = "tier1";
      return { userId, tier };
    }

    if (event.type==="checkout.session.completed") {
      const s = event.data.object;
      let { userId, tier } = await resolveUser(s);
      // Also try fetching the subscription for its metadata if we still don't have user
      if (!userId && s.subscription) {
        try {
          const sub = await stripeRequest(`/subscriptions/${s.subscription}`);
          const resolved = await resolveUser(sub);
          if (resolved.userId) { userId = resolved.userId; tier = resolved.tier; }
        } catch(e) { console.error("Sub fetch error:", e.message); }
      }
      if (userId) {
        await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"active", tier, submissions_used:0, submissions_reset_at:new Date().toISOString(), email_monitors_used:0 });
        console.log("Activated:",userId,"tier:",tier);
      } else { console.error("checkout.session.completed — could not resolve user. customer:", s.customer, "metadata:", JSON.stringify(s.metadata)); }
    }

    if (event.type==="customer.subscription.created"||event.type==="customer.subscription.updated") {
      const s = event.data.object;
      const { userId, tier } = await resolveUser(s);
      if (userId) {
        // Only update to active — never mark past_due from subscription events
        // past_due is handled exclusively by invoice.payment_failed
        if (s.status==="active") {
          await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"active", tier });
          console.log("Sub active:",userId,tier);
        }
        // cancelled/unpaid — cut off access
        if (s.status==="canceled"||s.status==="unpaid") {
          await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"cancelled", tier:"trial" });
          console.log("Sub cancelled/unpaid:",userId);
        }
      }
    }

    if (event.type==="customer.subscription.deleted") {
      const s = event.data.object;
      const { userId } = await resolveUser(s);
      if (userId) { await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"cancelled", tier:"trial" }); console.log("Cancelled:",userId); }
    }

    if (event.type==="invoice.payment_failed") {
      const invoice = event.data.object;
      const cid = invoice.customer;
      // Only mark past_due after multiple failed attempts (attempt_count > 1)
      // First failure might be a temporary card issue — give them grace
      const attemptCount = invoice.attempt_count || 1;
      if (cid && attemptCount > 1) {
        const ps = await sbSelect("profiles",`stripe_customer_id=eq.${cid}`);
        const uid = ps?.[0]?.id;
        if (uid) {
          await sbUpdate("profiles",`id=eq.${uid}`,{ subscription_status:"past_due" });
          console.log("Payment failed x"+attemptCount+", past_due:",uid);
        }
      } else {
        console.log("First payment failure, not marking past_due yet. attempt:", attemptCount);
      }
    }
    res.json({ received:true });
  } catch(e) { console.error("Webhook error:",e.message); res.status(400).json({ error:e.message }); }
});

// ── Profile recovery — creates missing profile for existing auth user ──
app.post("/auth/recover-profile", async (req, res) => {
  try {
    const { user_id, username } = req.body;
    if (!user_id||!username) return res.status(400).json({ error:"Missing fields." });
    // Check profile doesn't already exist
    const existing = await sbSelect("profiles", `id=eq.${user_id}`);
    if (Array.isArray(existing)&&existing.length>0) return res.json({ exists:true, profile:existing[0] });
    // Check username not taken
    const taken = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(taken)&&taken.length>0) return res.status(400).json({ error:"Username already taken." });
    const result = await sbInsert("profiles", {
      id:user_id, username, trial_start:new Date().toISOString(),
      tier:"trial", submissions_used:0, email_monitors_used:0,
      submissions_reset_at:new Date().toISOString(), subscription_status:"trial",
    });
    console.log("Profile recovered:", user_id, username);
    res.json({ success:true, result });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Profiles ──────────────────────────────────────────────────
app.post("/profile", async (req, res) => {
  try {
    const { user_id, username } = req.body;
    if (!user_id||!username) return res.status(400).json({ error:"Missing fields." });
    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:"Username already taken." });
    res.json(await sbInsert("profiles", { id:user_id, username }));
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get("/profile/:user_id", async (req, res) => {
  try { const p=await sbSelect("profiles",`id=eq.${req.params.user_id}`); res.json(Array.isArray(p)?p[0]||null:null); }
  catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Daily rescan ──────────────────────────────────────────────
app.post("/rescan", async (req, res) => {
  if (req.headers["x-rescan-secret"]!==RESCAN_SECRET) return res.status(401).json({ error:"Unauthorized" });
  try {
    const beats = await sbSelect("beats","status=eq.monitoring&order=last_scanned.asc");
    if (!Array.isArray(beats)||beats.length===0) return res.json({ message:"No beats to rescan.",count:0 });
    console.log(`Rescanning ${beats.length} beats...`);
    let newMatches=0;
    for (const beat of beats) {
      try {
        if (!beat.storage_path) continue;
        const status=await getSubscriptionStatus(beat.user_id);
        if (!status.hasAccess) { console.log(`Skipping ${beat.id} — no access`); continue; }
        const buffer=await storageDownload(beat.storage_path);
        if (!buffer) continue;
        const acrData=await scanAllEngines(buffer, beat.filename, "audio/mpeg");
        const rawMatched = acrData?.status?.code===0;
        const scanMusic  = acrData?.metadata?.music || [];
        function isGoodRescanMatch(m) {
          if (!m) return false;
          if ((m.score||100) < 90) return false;
          const t = (m.title||"").toLowerCase().trim();
          const badT = ["unknown","untitled","","no title","n/a","na","null","undefined"];
          if (badT.includes(t)||t.includes("untitled")) return false;
          return true;
        }
        const goodRescanMusic = rawMatched ? scanMusic.filter(isGoodRescanMatch) : [];
        const matched = goodRescanMusic.length > 0;
        const bestRescan = matched ? goodRescanMusic[0] : null;
        if (matched) {
          const title     = bestRescan?.title;
          const artist    = bestRescan?.artists?.[0]?.name;
          const spotifyId = bestRescan?.external_metadata?.spotify?.track?.id;
          const youtubeId = bestRescan?.external_metadata?.youtube?.vid;
          if (title!==beat.last_result) {
            await sbUpdate("beats",`id=eq.${beat.id}`,{ status:"placed", last_scanned:new Date().toISOString(), last_result:title, last_artist:artist||null, spotify_id:spotifyId||null, youtube_id:youtubeId||null });
            const canEmail=RESEND_KEY&&(status.emailMonitorLimit===null||(status.emailMonitorLimit>0&&status.emailMonitorsUsed<status.emailMonitorLimit));
            if (canEmail) {
              const uRes=await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${beat.user_id}`,{headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`}});
              const uData=await uRes.json();
              if (uData?.email) {
                await sendEmail(uData.email,`🎵 New placement found: "${beat.filename}"`,placementEmailHtml(beat.filename,title,artist,spotifyId,youtubeId));
                newMatches++;
                if (status.emailMonitorLimit!==null) {
                  const ps=await sbSelect("profiles",`id=eq.${beat.user_id}`);
                  const p=ps?.[0];
                  if (p) await sbUpdate("profiles",`id=eq.${beat.user_id}`,{ email_monitors_used:(p.email_monitors_used||0)+1 });
                }
              }
            }
          }
        } else { await sbUpdate("beats",`id=eq.${beat.id}`,{ last_scanned:new Date().toISOString() }); }
        await new Promise(r=>setTimeout(r,500));
      } catch(e) { console.error(`Rescan error beat ${beat.id}:`,e.message); }
    }
    res.json({ message:"Rescan complete.", total:beats.length, newMatches });
  } catch(e) { console.error("Rescan error:",e.message); res.status(500).json({ error:e.message }); }
});

app.listen(port, "0.0.0.0", ()=>console.log(`Server listening on 0.0.0.0:${port}`));
