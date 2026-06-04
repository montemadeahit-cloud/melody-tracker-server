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

const upload = multer({ storage: multer.memoryStorage() });

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

// In-memory rate limiter — max 3 signups per IP per hour
const signupAttempts = new Map();
function checkSignupRate(ip) {
  const now = Date.now(), window = 60*60*1000, max = 3;
  const entry = signupAttempts.get(ip);
  if (!entry || now - entry.firstAt > window) { signupAttempts.set(ip, { count:1, firstAt:now }); return true; }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// ── Supabase helpers ──────────────────────────────────────────
async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`,"Prefer":"return=representation"}, body:JSON.stringify(row),
  }); return r.json();
}
async function sbSelect(table, filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers:{"apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`},
  }); return r.json();
}
async function sbUpdate(table, filter, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method:"PATCH", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`}, body:JSON.stringify(row),
  }); return r.json();
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

// ── ACRCloud ──────────────────────────────────────────────────
async function identify(buffer, filename, mimetype) {
  const timestamp = Math.floor(Date.now()/1000);
  const sig = crypto.createHmac("sha1",ACR_SECRET).update(`POST\n/v1/identify\n${ACR_KEY}\naudio\n1\n${timestamp}`).digest("base64");
  const form = new FormData();
  form.append("sample",buffer,{filename,contentType:mimetype});
  form.append("access_key",ACR_KEY); form.append("data_type","audio");
  form.append("signature_version","1"); form.append("signature",sig);
  form.append("sample_bytes",buffer.length.toString()); form.append("timestamp",timestamp.toString());
  const res = await fetch(`https://${ACR_HOST}/v1/identify`,{method:"POST",body:form});
  return res.json();
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
app.get("/", (req, res) => res.json({ status:"ok", acrHost:ACR_HOST||"MISSING", keySet:!!ACR_KEY, secretSet:!!ACR_SECRET, supabase:!!SUPABASE_URL, stripe:!!STRIPE_KEY }));

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
    if (authData.error) return res.status(400).json({ error:authData.error.message||authData.error });
    const userId = authData.user?.id, accessToken = authData.access_token;
    if (!userId) return res.status(400).json({ error:"Could not create account." });

    await sbInsert("profiles", { id:userId, username, trial_start:new Date().toISOString(), tier:"trial", submissions_used:0, email_monitors_used:0, submissions_reset_at:new Date().toISOString(), signup_ip:ip });

    if (RESEND_KEY) sendEmail(email, "Welcome to TrackMyPlacements 🎵", welcomeEmailHtml(username)).catch(console.error);

    if (accessToken) return res.json({ access_token:accessToken, user:{ id:userId, email:authData.user.email, username } });

    const siRes  = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY}, body:JSON.stringify({ email, password }) });
    const siData = await siRes.json();
    if (siData.error) return res.status(400).json({ error:"Account created! Please sign in." });
    res.json({ access_token:siData.access_token, user:{ id:siData.user.id, email:siData.user.email, username } });
  } catch(e) { console.error("Signup error:",e.message); res.status(500).json({ error:e.message }); }
});

// ── Auth: sign in ─────────────────────────────────────────────
app.post("/auth/signin", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:"All fields required." });
    const profiles = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (!Array.isArray(profiles)||profiles.length===0) return res.status(400).json({ error:"Username not found." });
    const profile = profiles[0];
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${profile.id}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
    const userData = await userRes.json();
    if (!userData?.email) return res.status(400).json({ error:"Could not find account." });
    const siRes  = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY}, body:JSON.stringify({ email:userData.email, password }) });
    const siData = await siRes.json();
    if (siData.error||siData.error_description) return res.status(400).json({ error:siData.error_description||siData.error?.message||"Sign in failed." });
    res.json({ access_token:siData.access_token, user:{ id:siData.user.id, email:siData.user.email, username:profile.username } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Auth: forgot password (Resend branded) ────────────────────
app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error:"Email required." });

    if (RESEND_KEY && SUPABASE_SERVICE) {
      try {
        const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
          method:"POST",
          headers:{"Content-Type":"application/json","apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`},
          body:JSON.stringify({ type:"recovery", email }),
        });
        const linkData = await linkRes.json();
        if (linkData.action_link) {
          await sendEmail(email, "Reset your TrackMyPlacements password", passwordResetEmailHtml(linkData.action_link));
        }
      } catch(e) { console.error("Reset link error:",e.message); }
    }
    // Always succeed — don't leak whether email exists
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
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
app.post("/scan", upload.single("file"), async (req, res) => {
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

    const acrData = await identify(req.file.buffer, req.file.originalname, req.file.mimetype);
    console.log("ACRCloud:", JSON.stringify(acrData));

    if (user_id && SUPABASE_URL) {
      try {
        const matched     = acrData?.status?.code===0;
        const title       = matched ? acrData?.metadata?.music?.[0]?.title : null;
        const artist      = matched ? acrData?.metadata?.music?.[0]?.artists?.[0]?.name : null;
        const spotifyId   = matched ? acrData?.metadata?.music?.[0]?.external_metadata?.spotify?.track?.id : null;
        const youtubeId   = matched ? acrData?.metadata?.music?.[0]?.external_metadata?.youtube?.vid : null;
        const storagePath = `${user_id}/${req.file.originalname}`;

        await storageUpload(storagePath, req.file.buffer, req.file.mimetype);
        await sbInsert("beats", { user_id, filename:req.file.originalname, storage_path:storagePath, status:matched?"placed":"monitoring", last_scanned:new Date().toISOString(), last_result:title, uploaded_at:new Date().toISOString() });

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
    res.json(acrData);
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

// ── Subscribe ─────────────────────────────────────────────────
app.post("/subscribe", async (req, res) => {
  try {
    const { user_id, tier } = req.body;
    if (!user_id) return res.status(400).json({ error:"Missing user_id." });
    if (!STRIPE_KEY) return res.status(500).json({ error:"Stripe not configured." });
    const priceId = tier==="tier2" ? STRIPE_PRICE_T2 : STRIPE_PRICE_T1;
    if (!priceId) return res.status(500).json({ error:"Price not configured." });

    const uRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
    const uData = await uRes.json();
    if (!uData?.email) return res.status(400).json({ error:"User not found." });

    let profile = null;
    for (let i=0; i<3; i++) {
      const ps = await sbSelect("profiles", `id=eq.${user_id}`);
      if (Array.isArray(ps)&&ps.length>0&&ps[0].id) { profile=ps[0]; break; }
      await new Promise(r=>setTimeout(r,500));
    }

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const cust = await stripeRequest("/customers","POST",{ email:uData.email, "metadata[user_id]":user_id });
      customerId = cust.id;
      if (profile) await sbUpdate("profiles", `id=eq.${user_id}`, { stripe_customer_id:customerId });
    }

    const session = await stripeRequest("/checkout/sessions","POST",{
      customer:customerId, mode:"subscription",
      "line_items[0][price]":priceId, "line_items[0][quantity]":"1",
      "subscription_data[metadata][user_id]":user_id, "subscription_data[metadata][tier]":tier||"tier1",
      success_url:`${APP_URL}?subscribed=true`, cancel_url:`${APP_URL}?cancelled=true`,
    });
    if (session.error) return res.status(400).json({ error:session.error.message });
    res.json({ url:session.url });
  } catch(e) { res.status(500).json({ error:e.message }); }
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

    if (event.type==="checkout.session.completed") {
      const s=event.data.object, userId=s.metadata?.user_id, tier=s.metadata?.tier||"tier1";
      if (userId) { await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"active", tier, submissions_used:0, submissions_reset_at:new Date().toISOString(), email_monitors_used:0 }); console.log("Activated:",userId,tier); }
    }
    if (event.type==="customer.subscription.created"||event.type==="customer.subscription.updated") {
      const s=event.data.object, userId=s.metadata?.user_id, tier=s.metadata?.tier||"tier1";
      if (userId) {
        if (s.status==="active") { await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"active", tier }); console.log("Sub active:",userId,tier); }
        if (s.status==="past_due") { await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"past_due" }); console.log("Past due:",userId); }
      }
    }
    if (event.type==="customer.subscription.deleted") {
      const s=event.data.object, userId=s.metadata?.user_id;
      if (userId) { await sbUpdate("profiles",`id=eq.${userId}`,{ subscription_status:"cancelled", tier:"trial" }); console.log("Cancelled:",userId); }
    }
    if (event.type==="invoice.payment_failed") {
      const cid=event.data.object.customer;
      if (cid) {
        const ps=await sbSelect("profiles",`stripe_customer_id=eq.${cid}`);
        const uid=ps?.[0]?.id;
        if (uid) { await sbUpdate("profiles",`id=eq.${uid}`,{ subscription_status:"past_due" }); console.log("Payment failed, past_due:",uid); }
      }
    }
    res.json({ received:true });
  } catch(e) { console.error("Webhook error:",e.message); res.status(400).json({ error:e.message }); }
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
        const acrData=await identify(buffer,beat.filename,"audio/mpeg");
        const matched=acrData?.status?.code===0;
        if (matched) {
          const title=acrData?.metadata?.music?.[0]?.title;
          const artist=acrData?.metadata?.music?.[0]?.artists?.[0]?.name;
          const spotifyId=acrData?.metadata?.music?.[0]?.external_metadata?.spotify?.track?.id;
          const youtubeId=acrData?.metadata?.music?.[0]?.external_metadata?.youtube?.vid;
          if (title!==beat.last_result) {
            await sbUpdate("beats",`id=eq.${beat.id}`,{ status:"placed", last_scanned:new Date().toISOString(), last_result:title });
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

