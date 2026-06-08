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
const FROM_EMAIL       = process.env.FROM_EMAIL || "TrackMyPlacements <alerts@trackmyplacements.com>";
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

// ── Comped accounts ───────────────────────────────────────────
// Usernames in this set are always granted full Tier 2 access,
// regardless of trial/Stripe state. Matched case-insensitively.
const COMP_TIER2 = new Set(["montemadethis"]);

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
  if (!r.ok) {
    // Parse error detail from Supabase if available
    let detail = text;
    try { const j = JSON.parse(text); detail = j.message || j.details || j.hint || text; } catch(e) {}
    throw new Error(`sbInsert(${table}) HTTP ${r.status}: ${detail.slice(0,300)}`);
  }
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
// 4 slices at music-structure-aware positions:
//   15% — just past the intro
//   38% — first verse/hook entry
//   62% — mid-track hook (most distinctive)
//   85% — second chorus / outro drop
// All slices are ~25s — more waveform = higher confidence.
// Short files skip slicing and send as-is.
// Medium files also get a full-buffer pass for maximum coverage.
const SLICE_BYTES    = 32 * 1024 * 25;  // ~25s at 256kbps equiv
const MIN_SCAN_BYTES = 32 * 1024 * 15;  // skip slicing if file is under ~15s
const FULL_PASS_MAX  = 32 * 1024 * 90;  // include full buffer pass if file is under ~90s
function getSlices(buffer) {
  if (buffer.length <= MIN_SCAN_BYTES) return [buffer];
  const s   = SLICE_BYTES;
  const len = buffer.length;
  const offsets = [0.15, 0.38, 0.62, 0.85].map(p => Math.floor(len * p));
  const slices = offsets.map(o => buffer.slice(o, Math.min(o + s, len)));
  // Also include the full buffer as an extra pass for shorter tracks
  if (len <= FULL_PASS_MAX) slices.push(buffer);
  return slices;
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
// De-dupes by normalised title (strips feat/prod/remix suffixes),
// keeps highest score per title across all engines and segments.
function normaliseTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/\s*[\(\[].*(feat|ft|prod|remix|edit|version|remaster|explicit|clean|radio).*[\)\]]/gi, "")
    .replace(/\s*-\s*(feat|ft|prod|remix|edit|version|remaster|explicit|clean|radio).*/gi, "")
    .trim();
}
function mergeAllResults(responses) {
  const primary   = responses.find(r => r?.status?.code === 0) || responses[0] || {};
  const musicMap  = new Map();
  const hummingMap = new Map();

  for (const r of responses) {
    for (const m of (r?.metadata?.music || [])) {
      const key = normaliseTitle(m.title);
      if (!key) continue;
      const existing = musicMap.get(key);
      // Keep highest score, but prefer the entry that has more DSP metadata
      if (!existing) {
        musicMap.set(key, m);
      } else {
        const existingDsp = (existing.external_metadata?.spotify?.track?.id ? 1 : 0) + (existing.external_metadata?.youtube?.vid ? 1 : 0);
        const newDsp      = (m.external_metadata?.spotify?.track?.id ? 1 : 0) + (m.external_metadata?.youtube?.vid ? 1 : 0);
        if ((m.score || 0) > (existing.score || 0) || newDsp > existingDsp) {
          // Merge: take highest score but union DSP metadata
          const merged = { ...existing, ...m, score: Math.max(m.score || 0, existing.score || 0) };
          merged.external_metadata = { ...existing.external_metadata, ...m.external_metadata };
          musicMap.set(key, merged);
        }
      }
    }
    for (const m of (r?.metadata?.humming || [])) {
      const key = normaliseTitle(m.title);
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

// ── Shazam (via RapidAPI) ─────────────────────────────────────
// Third fingerprint engine — different algorithm and database to ACRCloud/AudD.
// Particularly strong on rap/trap/R&B instrumentals.
// Requires RAPIDAPI_KEY env var.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
async function identifyShazam(buffer, filename) {
  if (!RAPIDAPI_KEY) return null;
  try {
    const form = new FormData();
    form.append("upload_file", buffer, { filename, contentType: "audio/mpeg" });
    const res = await fetch("https://shazam-song-recognizer.p.rapidapi.com/recognize/file", {
      method: "POST",
      headers: {
        "x-rapidapi-key":  RAPIDAPI_KEY,
        "x-rapidapi-host": "shazam-song-recognizer.p.rapidapi.com",
      },
      body: form,
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Shazam returns { track: { title, subtitle, key, sections, hub } }
    const track = data?.track;
    if (!track || !track.title) return null;
    const external_metadata = {};
    // Extract Spotify link from hub actions if present
    const spotifyAction = track.hub?.actions?.find(a => a.uri && a.uri.includes("spotify"));
    if (spotifyAction) {
      const spotifyId = spotifyAction.uri.split("/track/")[1]?.split("?")[0];
      if (spotifyId) external_metadata.spotify = { track: { id: spotifyId } };
    }
    // Extract Apple Music link
    const appleAction = track.hub?.actions?.find(a => a.uri && a.uri.includes("apple"));
    if (appleAction) external_metadata.itunes = { uri: appleAction.uri };
    const norm = {
      title:             track.title,
      artists:           track.subtitle ? [{ name: track.subtitle }] : [],
      release_date:      null,
      score:             90, // Shazam doesn't return a confidence score — treat hits as high confidence
      external_metadata,
      _source:           "shazam",
    };
    return { status: { code: 0, msg: "Success" }, metadata: { music: [norm], humming: [] } };
  } catch(e) {
    console.error("Shazam error:", e.message);
    return null;
  }
}

// ── Fan-out: all slices × all three engines, fully parallel ───
async function scanAllEngines(buffer, filename, mimetype) {
  const slices = getSlices(buffer);
  // Fire all ACRCloud slices + AudD + Shazam on every slice simultaneously
  const tasks = [
    ...slices.map(s => identifyACR(s, filename, mimetype)),
    ...slices.map(s => identifyAudd(s, filename)),
    ...slices.map(s => identifyShazam(s, filename)),
  ];
  const results = await Promise.all(tasks);
  const valid   = results.filter(Boolean);
  console.log(`Scan engines (${slices.length} slices × 3 engines = ${tasks.length} tasks):`, results.map((r,i) => {
    if (!r) return `task${i}:skipped`;
    return `task${i}:code=${r?.status?.code},hits=${r?.metadata?.music?.length||0},src=${r?.metadata?.music?.[0]?._source||"acr"}`;
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
  // Waveform bars as inline SVG (matches the app logo exactly)
  const logoSvg = `<svg width="20" height="20" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:8px;"><rect x="0" y="25" width="8" height="31" rx="4" fill="#FFFFFF"/><rect x="11" y="17" width="8" height="39" rx="4" fill="#FFFFFF"/><rect x="22" y="7" width="8" height="49" rx="4" fill="#FFFFFF"/><rect x="33" y="14" width="8" height="42" rx="4" fill="#eeeae2"/><rect x="44" y="24" width="8" height="32" rx="4" fill="#eeeae2"/></svg>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
  <title>TrackMyPlacements</title>
</head>
<body style="margin:0;padding:0;background:#090910;-webkit-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#090910;padding:32px 16px 48px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;">

      <!-- Top accent line -->
      <tr><td style="height:2px;background:linear-gradient(90deg,rgba(255,255,255,0) 0%,#ffffff 40%,#ffffff 60%,rgba(255,255,255,0) 100%);border-radius:1px;font-size:0;">&nbsp;</td></tr>

      <!-- Card -->
      <tr><td style="background:linear-gradient(180deg,#17171f 0%,#111118 100%);border:1px solid rgba(255,255,255,0.1);border-top:1px solid rgba(255,255,255,0.2);border-radius:18px;overflow:hidden;">

        <!-- Header -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td style="padding:28px 32px 24px;border-bottom:1px solid rgba(255,255,255,0.07);">
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="vertical-align:middle;padding-right:8px;">${logoSvg}</td>
                  <td style="vertical-align:middle;">
                    <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;color:#eeeae2;letter-spacing:-.2px;">TrackMy<span style="color:#ffffff;">Placements</span></span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:28px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;">
              ${content}
            </td>
          </tr>
        </table>

      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:20px 4px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.3);line-height:1.7;">
              <a href="${APP_URL}" style="color:rgba(255,255,255,0.45);text-decoration:none;font-weight:600;letter-spacing:.01em;">trackmyplacements.com</a>
              <span style="color:rgba(255,255,255,0.18);margin:0 8px;">·</span>
              <span style="color:rgba(255,255,255,0.25);">Placement Location Engine</span>
            </td>
          </tr>
        </table>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function placementEmailHtml(filename, title, artist, spotifyId, youtubeId) {
  const link = spotifyId ? `https://open.spotify.com/track/${spotifyId}` : youtubeId ? `https://youtube.com/watch?v=${youtubeId}` : null;
  const platformLabel = spotifyId ? "Listen on Spotify" : youtubeId ? "Watch on YouTube" : null;
  const platformBg = spotifyId ? "#1DB954" : youtubeId ? "#FF0000" : "#ffffff";
  const platformColor = spotifyId || youtubeId ? "#ffffff" : "#050508";
  return baseEmail(`
    <!-- Label -->
    <div style="display:inline-block;padding:4px 12px;background:rgba(78,196,122,0.12);border:1px solid rgba(78,196,122,0.28);border-radius:999px;margin-bottom:18px;">
      <span style="font-size:11px;font-weight:600;color:#4ec47a;letter-spacing:.04em;">● Placement found</span>
    </div>

    <!-- Track info card -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-top:1px solid rgba(255,255,255,0.18);border-radius:14px;margin-bottom:24px;">
      <tr><td style="padding:20px 22px;">
        <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.4);letter-spacing:.13em;text-transform:uppercase;margin-bottom:10px;">Recognized as</div>
        <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-.4px;line-height:1.2;margin-bottom:5px;">${title}</div>
        <div style="font-size:13px;color:rgba(238,234,226,0.5);">${artist || "Unknown artist"}</div>
      </td></tr>
    </table>

    <!-- Your beat label -->
    <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.13em;margin-bottom:6px;">Your beat</div>
    <div style="font-size:14px;font-weight:600;color:#eeeae2;margin-bottom:26px;line-height:1.4;">${filename}</div>

    <!-- CTA button -->
    ${link ? `<a href="${link}" style="display:inline-block;background:${platformBg};color:${platformColor};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:700;font-size:13px;padding:12px 22px;border-radius:10px;text-decoration:none;letter-spacing:.03em;">${platformLabel} ↗</a>` : ""}

    <!-- Dashboard CTA -->
    <p style="margin:22px 0 0;font-size:12px;color:rgba(255,255,255,0.38);line-height:1.75;">Head to your dashboard to verify this placement and add it to your catalog.</p>
  `);
}

function passwordResetEmailHtml(resetUrl) {
  return baseEmail(`
    <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.35);letter-spacing:.13em;text-transform:uppercase;margin-bottom:14px;">Account security</div>
    <div style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-.4px;margin-bottom:14px;line-height:1.2;">Reset your password</div>
    <p style="font-size:14px;color:rgba(238,234,226,0.55);line-height:1.8;margin:0 0 26px;">Click the button below to set a new password. This link expires in <span style="color:#ffffff;font-weight:600;">1 hour</span>.</p>
    <a href="${resetUrl}" style="display:inline-block;background:#ffffff;color:#050508;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:700;font-size:13px;padding:12px 22px;border-radius:10px;text-decoration:none;letter-spacing:.03em;">Set new password ↗</a>
    <p style="margin:22px 0 0;font-size:12px;color:rgba(255,255,255,0.3);line-height:1.6;">Didn't request this? You can safely ignore this email — your account is unchanged.</p>
  `);
}

function welcomeEmailHtml(username) {
  const features = [
    ["🪪", "Fingerprint registered", "A permanent, content-based ID assigned the moment you upload. It lives in our system forever."],
    ["🔍", "Instant scan", "Your beat is checked immediately across Spotify, Apple Music, YouTube, TikTok & more."],
    ["📡", "Daily rescan", "We run your full library every day. You'll get an email the moment something surfaces."],
    ["✓",  "Verified catalog", "Confirmed placements are logged and shareable — your track record, backed by data."],
  ];
  return baseEmail(`
    <!-- Greeting -->
    <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.35);letter-spacing:.13em;text-transform:uppercase;margin-bottom:14px;">Welcome</div>
    <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-.5px;line-height:1.15;margin-bottom:16px;">You're in,<br/>@${username}.</div>
    <p style="font-size:14px;color:rgba(238,234,226,0.5);line-height:1.85;margin:0 0 28px;">Right now your beats have no identifier on the internet — that's why placements are hard to track. Upload one and we assign it a unique ID, scan it immediately across all major platforms, and email you the moment it surfaces anywhere.</p>

    <!-- Divider -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
      <tr><td style="height:1px;background:rgba(255,255,255,0.1);font-size:0;">&nbsp;</td></tr>
    </table>

    <!-- Features -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px;">
      ${features.map(([icon, label, body], i) => `
      <tr>
        <td style="width:32px;vertical-align:top;padding:0 0 18px;font-size:16px;color:#ffffff;">${icon}</td>
        <td style="vertical-align:top;padding:0 0 18px 12px;${i < features.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.07);padding-bottom:18px;' : ''}">
          <div style="font-size:13px;font-weight:700;color:#ffffff;margin-bottom:3px;">${label}</div>
          <div style="font-size:12px;color:rgba(238,234,226,0.45);line-height:1.65;">${body}</div>
        </td>
      </tr>`).join("")}
    </table>

    <!-- CTA -->
    <a href="${APP_URL}" style="display:inline-block;background:#ffffff;color:#050508;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:700;font-size:13px;padding:13px 26px;border-radius:10px;text-decoration:none;letter-spacing:.03em;">Scan your first beat ↗</a>
  `);
}

// ── Subscription status ───────────────────────────────────────
async function getSubscriptionStatus(user_id) {
  const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
  const profile  = profiles?.[0];
  if (!profile) return { hasAccess:false, trialActive:false, subscriptionActive:false, daysLeft:0, submissionsUsed:0, submissionLimit:25, emailMonitorsUsed:0, emailMonitorLimit:0 };

  // Comped accounts — always full Tier 2, never gated by trial/billing.
  if (profile.username && COMP_TIER2.has(profile.username.toLowerCase())) {
    const compLimits = getLimits("tier2");
    return {
      hasAccess: true, trialActive: false, subscriptionActive: true, pastDue: false,
      daysLeft: 9999, trialEnd: new Date(Date.now() + 9999*24*60*60*1000).toISOString(),
      tier: "tier2", tierLabel: compLimits.label,
      submissionsUsed: profile.submissions_used || 0, submissionLimit: compLimits.submissions,
      emailMonitorsUsed: profile.email_monitors_used || 0, emailMonitorLimit: compLimits.emailMonitors,
    };
  }

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
  shazam:!!RAPIDAPI_KEY,
  spotifyId:!!process.env.SPOTIFY_CLIENT_ID,
  spotifySecret:!!process.env.SPOTIFY_CLIENT_SECRET,
  appUrl:APP_URL,
}));

// ── Auth: sign up ─────────────────────────────────────────────
const DEV_EMAILS = ["montemadeahit@gmail.com"];

app.post("/auth/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username||!email||!password) return res.status(400).json({ error:"All fields required." });

    const isDev = DEV_EMAILS.includes((email||"").toLowerCase().trim());
    const ip = getIP(req);
    if (!isDev && !checkSignupRate(ip)) return res.status(429).json({ error:"Too many accounts created from this connection. Try again later." });

    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:"Username already taken." });

    // Block if this IP already has an active trial — skip for dev
    if (!isDev) {
      const ipProfiles = await sbSelect("profiles", `signup_ip=eq.${encodeURIComponent(ip)}`);
      if (Array.isArray(ipProfiles)&&ipProfiles.length>0) {
        for (const p of ipProfiles) {
          if (p.subscription_status==="active") continue;
          const te = new Date((p.trial_start ? new Date(p.trial_start) : new Date(p.created_at)).getTime() + 3*24*60*60*1000);
          if (new Date() < te) return res.status(429).json({ error:"A free trial is already active from this network. Subscribe to continue." });
        }
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
      // Notify admin of new signup — bold, branded, high-contrast
      sendEmail("trackmyplacements@gmail.com", `New signup: @${username}`, baseEmail(`
        <!-- Badge -->
        <div style="display:inline-flex;align-items:center;gap:7px;padding:5px 13px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);border-radius:999px;margin-bottom:22px;">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#4ec47a;box-shadow:0 0 8px 2px rgba(78,196,122,0.5);"></span>
          <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.7);letter-spacing:.1em;text-transform:uppercase;">New signup</span>
        </div>

        <!-- Username — the hero line -->
        <div style="font-size:36px;font-weight:800;color:#ffffff;letter-spacing:-.8px;line-height:1.1;margin-bottom:6px;">@${username}</div>

        <!-- Divider -->
        <div style="height:1px;background:rgba(255,255,255,0.08);margin:20px 0;"></div>

        <!-- Details table -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
              <span style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.1em;">Email</span>
            </td>
            <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;">
              <span style="font-size:13px;color:#eeeae2;font-weight:500;">${email}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
              <span style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.1em;">Signed up</span>
            </td>
            <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;">
              <span style="font-size:13px;color:#eeeae2;font-weight:500;">${new Date().toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",timeZone:"America/New_York"})} ET</span>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 0;">
              <span style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.1em;">IP</span>
            </td>
            <td style="padding:10px 0;text-align:right;">
              <span style="font-size:12px;color:rgba(238,234,226,0.45);font-family:monospace;">${ip}</span>
            </td>
          </tr>
        </table>

        <!-- CTA -->
        <a href="${APP_URL}" style="display:inline-block;background:#ffffff;color:#050508;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:700;font-size:13px;padding:12px 22px;border-radius:10px;text-decoration:none;letter-spacing:.03em;">View dashboard ↗</a>
      `)).catch(console.error);
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

// ── Support / Feedback ────────────────────────────────────────
app.post("/support", async (req, res) => {
  try {
    const { name, email, message, username, userId } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: "Message required." });

    const senderName  = name || username || "Anonymous";
    const replyEmail  = email || null;
    const subject     = `Support: ${senderName} — ${message.trim().slice(0, 60)}${message.trim().length > 60 ? "…" : ""}`;

    const html = `
      <div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
        <div style="background:#f4f4f5;border-radius:10px;padding:20px 24px;margin-bottom:16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:8px;">From</div>
          <div style="font-size:15px;font-weight:600;">${senderName}</div>
          ${replyEmail ? `<div style="font-size:13px;color:#555;margin-top:2px;">${replyEmail}</div>` : ""}
          ${userId ? `<div style="font-size:11px;color:#aaa;margin-top:4px;">User ID: ${userId}</div>` : ""}
        </div>
        <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:10px;padding:20px 24px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:10px;">Message</div>
          <div style="font-size:15px;line-height:1.75;white-space:pre-wrap;">${message.trim()}</div>
        </div>
        <div style="margin-top:12px;font-size:11px;color:#aaa;">Sent via TrackMyPlacements support form</div>
      </div>
    `;

    if (!RESEND_KEY) {
      console.warn("Support email skipped — RESEND_KEY not set.");
      return res.json({ ok: true }); // Don't block the user if email isn't configured
    }

    // Always send to the FROM_EMAIL address (verified sender domain) — avoids Resend
    // "can only send to your own email" restriction on free plans.
    // Set reply_to so you can reply directly to the user from your inbox.
    const payload = {
      from:    FROM_EMAIL,
      to:      [FROM_EMAIL, "trackmyplacements@gmail.com"],
      subject,
      html,
      ...(replyEmail ? { reply_to: replyEmail } : {}),
    };

    const r = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
      body:    JSON.stringify(payload),
    });
    const d = await r.json();
    console.log("Support email response:", r.status, JSON.stringify(d));

    if (!r.ok) {
      // Log the real error for debugging but never expose it to the user
      console.error("Resend error sending support email:", JSON.stringify(d));
      return res.status(500).json({ error: "send_failed" });
    }

    res.json({ ok: true });
  } catch(e) {
    console.error("Support email error:", e.message);
    res.status(500).json({ error: "send_failed" });
  }
});

// ── Spotify track lookup (for user-submitted links) ──────────
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
let spotifyToken = null, spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry - 60000) return spotifyToken;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  const d = await r.json();
  if (!d.access_token) return null;
  spotifyToken = d.access_token;
  spotifyTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000;
  return spotifyToken;
}

// Best-effort artist extraction from a Spotify track page's HTML.
// Tries several markup strategies in order of reliability and returns the
// first that yields something sane. Returns "" if nothing usable is found.
function extractSpotifyArtist(html) {
  if (!html) return "";
  const clean = (s) => (s || "")
    .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").trim();

  // 1) JSON-LD byArtist — most structured when present.
  try {
    const ld = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (ld) {
      const data = JSON.parse(ld[1]);
      const arr = Array.isArray(data) ? data : [data];
      for (const node of arr) {
        const by = node?.byArtist;
        if (by) {
          const names = (Array.isArray(by) ? by : [by]).map((a) => a?.name).filter(Boolean);
          if (names.length) return clean(names.join(", "));
        }
      }
    }
  } catch (e) { /* fall through */ }

  // 2) music:musician meta tags (one per artist).
  const musicians = [...html.matchAll(/<meta[^>]+property=["']music:musician["'][^>]+content=["']([^"']+)["']/gi)]
    .map((m) => clean(m[1])).filter(Boolean);
  if (musicians.length) return musicians.join(", ");

  // 3) og:description — historically "Artist · Song · year". Take the part
  //    before the first separator, guarding against generic boilerplate.
  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (ogDesc) {
    const first = clean(ogDesc[1]).split(/\s*[·•|]\s*/)[0];
    const lower = first.toLowerCase();
    if (first && !lower.startsWith("listen to") && !lower.startsWith("song ") && lower !== "song" && lower !== "spotify") {
      return first;
    }
  }
  return "";
}

app.get("/spotify-track/:id", async (req, res) => {
  try {
    const id = req.params.id.split("?")[0].split("#")[0];
    if (!id || !/^[A-Za-z0-9]{10,30}$/.test(id)) return res.status(400).json({ error: "Invalid track ID." });

    // Primary: Spotify Web API — richest data (artist, album, popularity).
    const token = await getSpotifyToken();
    if (token) {
      try {
        const r = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (r.ok) {
          const t = await r.json();
          return res.json({
            id:          t.id,
            title:       t.name,
            artist:      t.artists?.map(a => a.name).join(", ") || "",
            album:       t.album?.name || "",
            releaseDate: t.album?.release_date || null,
            popularity:  t.popularity || null,
            spotifyUrl:  t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
            source:      "api",
          });
        }
        // Non-OK (e.g. token edge cases) — fall through to oEmbed.
      } catch(apiErr) { console.error("Spotify API error, falling back to oEmbed:", apiErr.message); }
    }

    // Fallback: public endpoints, NO credentials required, so link
    // verification still works when SPOTIFY_CLIENT_ID/SECRET aren't set.
    // oEmbed gives us the title + thumbnail; the public track page's
    // Open Graph / JSON-LD tags let us best-effort recover the artist.
    // NOTE: this is best-effort — Spotify can change their page markup at
    // any time. Setting SPOTIFY_CLIENT_ID/SECRET is the reliable path and
    // always wins above. If you're seeing blank artists, set those vars.
    const oembedUrl = "https://open.spotify.com/oembed?url=" + encodeURIComponent("https://open.spotify.com/track/" + id);
    const oe = await fetch(oembedUrl);
    if (oe.ok) {
      const o = await oe.json();
      let title  = o.title || "Spotify track";
      let artist = "";

      // Best-effort: pull the artist from the public track page metadata.
      try {
        const pageRes = await fetch(`https://open.spotify.com/track/${id}`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TrackMyPlacements/1.0)" },
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          artist = extractSpotifyArtist(html) || "";
        }
      } catch (scrapeErr) {
        console.error("Spotify artist scrape failed (non-fatal):", scrapeErr.message);
      }

      return res.json({
        id,
        title,
        artist,
        album:       "",
        releaseDate: null,
        popularity:  null,
        spotifyUrl:  `https://open.spotify.com/track/${id}`,
        thumbnail:   o.thumbnail_url || null,
        source:      artist ? "oembed+scrape" : "oembed",
      });
    }

    return res.status(404).json({ error: "Track not found." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Apple Music track lookup (iTunes Search API — no credentials needed) ──
app.get("/apple-track", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url parameter." });

    // Require a specific track — Apple Music track URLs always have ?i=TRACK_ID
    const trackIdMatch = url.match(/[?&]i=(\d+)/);
    if (!trackIdMatch) {
      return res.status(400).json({ error: "Please paste a link to a specific song, not an album. In Apple Music, tap the three dots on the song → Share → Copy Link." });
    }
    const trackId = trackIdMatch[1];

    const r = await fetch(`https://itunes.apple.com/lookup?id=${trackId}&entity=song&limit=1`);
    if (!r.ok) return res.status(404).json({ error: "Apple Music lookup failed." });
    const data = await r.json();
    const track = (data.results || []).find(x => x.wrapperType === "track" || x.kind === "song");

    if (!track || !track.trackName) return res.status(404).json({ error: "Track not found on Apple Music." });

    return res.json({
      id:          String(track.trackId),
      title:       track.trackName,
      artist:      track.artistName || "",
      album:       track.collectionName || "",
      releaseDate: track.releaseDate ? track.releaseDate.slice(0, 10) : null,
      trackUrl:    track.trackViewUrl || url,
      artwork:     track.artworkUrl100 || null,
      source:      "itunes",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── YouTube track lookup (oEmbed — no credentials needed) ──
app.get("/youtube-track", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url parameter." });

    // Extract video ID from various YouTube URL formats
    const videoIdMatch = url.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
    if (!videoIdMatch) return res.status(400).json({ error: "Could not extract a video ID from this YouTube link." });
    const videoId = videoIdMatch[1];

    // YouTube oEmbed — returns title and author (channel name), no auth needed
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + videoId)}&format=json`;
    const r = await fetch(oembedUrl);
    if (!r.ok) return res.status(404).json({ error: "Video not found or not embeddable." });
    const data = await r.json();

    // Parse "Song Name - Artist Name (Official Video)" style titles
    // Attempts to extract a clean song title and artist from the YouTube title
    let title  = data.title || "YouTube video";
    let artist = data.author_name || "";

    // Common pattern: "Artist - Song Title" or "Song Title - Artist"
    const dashSplit = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dashSplit) {
      // Heuristic: if author_name appears in part1, part2 is the song title
      if (artist && dashSplit[1].toLowerCase().includes(artist.toLowerCase().split(" ")[0]?.toLowerCase())) {
        title  = dashSplit[2].replace(/\s*[\(\[].*(official|video|audio|lyrics|music|hd|4k|vevo).*/gi, "").trim();
        artist = dashSplit[1].trim();
      } else {
        title  = dashSplit[1].replace(/\s*[\(\[].*(official|video|audio|lyrics|music|hd|4k|vevo).*/gi, "").trim();
        artist = dashSplit[2].trim();
      }
    }
    // Strip trailing tags like "(Official Music Video)" from title
    title = title.replace(/\s*[\(\[].*(official|video|audio|lyrics|music|hd|4k|vevo|feat|ft).*$/gi, "").trim();

    return res.json({
      id:       videoId,
      title,
      artist,
      trackUrl: `https://www.youtube.com/watch?v=${videoId}`,
      source:   "youtube_oembed",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SoundCloud track lookup (oEmbed — no credentials needed) ──
app.get("/soundcloud-track", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url parameter." });

    // Validate it looks like a SoundCloud track URL
    if (!url.includes("soundcloud.com")) return res.status(400).json({ error: "Please paste a SoundCloud track link." });

    // SoundCloud oEmbed — free, returns title and author_name
    const oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const r = await fetch(oembedUrl);
    if (!r.ok) return res.status(404).json({ error: "Track not found on SoundCloud." });
    const data = await r.json();

    // SoundCloud oEmbed title is typically "Song Title by Artist Name"
    let title  = data.title || "SoundCloud track";
    let artist = data.author_name || "";

    // Strip the " by Artist" suffix that SoundCloud appends to oEmbed titles
    const bySuffix = title.match(/^(.+?)\s+by\s+(.+)$/i);
    if (bySuffix) {
      title  = bySuffix[1].trim();
      artist = bySuffix[2].trim() || artist;
    }

    return res.json({
      id:       encodeURIComponent(url),
      title,
      artist,
      trackUrl: url,
      source:   "soundcloud_oembed",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Fingerprint knowledge base ────────────────────────────────
// Global, append-only table: fingerprint_id → verified placement.
// Independent of any user's beat library — survives deletions, teaches
// the algorithm permanently. Written on every human verification and on
// every high-confidence auto-match. Read before ACRCloud on every scan.
//
// Required Supabase SQL (run once):
//   CREATE TABLE IF NOT EXISTS fingerprint_knowledge (
//     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//     fingerprint_id  text NOT NULL,
//     title           text NOT NULL,
//     artist          text,
//     spotify_id      text,
//     youtube_id      text,
//     track_url       text,
//     platform        text,
//     verified_by     uuid,          -- user_id who first verified (nullable)
//     verified_at     timestamptz DEFAULT now(),
//     confidence      integer DEFAULT 100,
//     source          text DEFAULT 'user_verified'
//   );
//   CREATE UNIQUE INDEX IF NOT EXISTS fingerprint_knowledge_fp_title
//     ON fingerprint_knowledge (fingerprint_id, lower(title));

async function knowledgeGet(fingerprint_id) {
  try {
    const rows = await sbSelect(
      "fingerprint_knowledge",
      `fingerprint_id=eq.${encodeURIComponent(fingerprint_id)}&order=confidence.desc&limit=1`
    );
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch(e) { console.error("knowledgeGet error:", e.message); return null; }
}

async function knowledgeWrite({ fingerprint_id, title, artist, spotify_id, youtube_id, track_url, platform, verified_by, confidence, source }) {
  if (!fingerprint_id || !title) return;
  try {
    // Upsert by fingerprint_id + normalised title — idempotent, safe to call repeatedly
    const existing = await sbSelect(
      "fingerprint_knowledge",
      `fingerprint_id=eq.${encodeURIComponent(fingerprint_id)}&title=ilike.${encodeURIComponent(title.trim())}`
    );
    if (Array.isArray(existing) && existing.length > 0) {
      // Update DSP data if we now have richer info
      const row = existing[0];
      const patch = {};
      if (spotify_id  && !row.spotify_id)  patch.spotify_id  = spotify_id;
      if (youtube_id  && !row.youtube_id)  patch.youtube_id  = youtube_id;
      if (track_url   && !row.track_url)   patch.track_url   = track_url;
      if (artist      && !row.artist)      patch.artist      = artist;
      if (confidence  && confidence > (row.confidence || 0)) patch.confidence = confidence;
      if (Object.keys(patch).length > 0) {
        await sbUpdate("fingerprint_knowledge", `id=eq.${row.id}`, patch);
      }
    } else {
      await sbInsert("fingerprint_knowledge", {
        fingerprint_id,
        title:       title.trim(),
        artist:      artist  || null,
        spotify_id:  spotify_id  || null,
        youtube_id:  youtube_id  || null,
        track_url:   track_url   || null,
        platform:    platform    || null,
        verified_by: verified_by || null,
        confidence:  confidence  || 100,
        source:      source      || "user_verified",
      });
    }
    console.log(`Knowledge written: ${fingerprint_id} → "${title}"`);
  } catch(e) { console.error("knowledgeWrite error:", e.message); }
}

// ── Manual placement verification (user-submitted platform link) ──
// When a scan finds NO match but the producer knows where the beat is
// placed, they paste a platform link in the UI. The frontend verifies
// it via the appropriate lookup endpoint, then calls this to PERSIST it
// onto the beat record — flipping status to "placed" and storing the DSP
// data so it becomes a real, durable placement (visible in Library, survives reload).
app.post("/verify-placement", async (req, res) => {
  try {
    const { user_id, fingerprint_id, beat_id, spotify_id, youtube_id, platform, track_url, title, artist } = req.body;
    if (!user_id || (!fingerprint_id && !beat_id)) return res.status(400).json({ error: "Missing user_id and a beat reference (fingerprint_id or beat_id)." });
    if (!title) return res.status(400).json({ error: "Missing track title." });

    // Locate the beat — by id if provided, otherwise by its permanent fingerprint
    let beats;
    if (beat_id) {
      beats = await sbSelect("beats", `id=eq.${beat_id}&user_id=eq.${user_id}`);
    } else {
      beats = await sbSelect("beats", `user_id=eq.${user_id}&fingerprint_id=eq.${encodeURIComponent(fingerprint_id)}`);
    }
    if (!Array.isArray(beats) || beats.length === 0) return res.status(404).json({ error: "Beat not found for this user." });
    const beat = beats[0];

    // Build update payload — store whichever DSP ID we have
    const updatePayload = {
      status:       "placed",
      last_result:  title,
      last_artist:  artist || null,
      last_scanned: new Date().toISOString(),
    };
    if (spotify_id)  updatePayload.spotify_id  = spotify_id;
    if (youtube_id)  updatePayload.youtube_id  = youtube_id;
    if (track_url && !spotify_id && !youtube_id) updatePayload.track_url = track_url;

    const updated = await sbUpdate("beats", `id=eq.${beat.id}`, updatePayload);
    console.log("Manual placement verified:", beat.id, "→", title, platform || "spotify", spotify_id || youtube_id || track_url || "(no id)");

    // ── Write to permanent knowledge base ──────────────────────
    // This is the key learning step — regardless of what happens to this
    // user's library, the knowledge that fingerprint X = song Y is now
    // stored permanently and will benefit every future scan of this beat.
    await knowledgeWrite({
      fingerprint_id: beat.fingerprint_id || fingerprint_id,
      title, artist, spotify_id, youtube_id, track_url, platform,
      verified_by: user_id,
      confidence:  100,
      source:      "user_verified",
    });

    res.json({ success: true, beat: Array.isArray(updated) ? updated[0] : (updated || { id: beat.id }) });
  } catch (e) { console.error("verify-placement error:", e.message); res.status(500).json({ error: e.message }); }
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

    // ── Step 1: Hash the file immediately — this is the universal beat identity ──
    // Must happen before ANY other logic so every code path has access to it.
    const audioHash     = computeAudioHash(req.file.buffer);
    const fingerprintId = audioHash;

    // Normalize MIME type — iOS reports .m4a files as video/mp4 which confuses
    // some services. Treat any video/mp4 upload as audio/mp4 for processing.
    const normalizedMime = req.file.mimetype === "video/mp4" ? "audio/mp4" : req.file.mimetype;
    req.file.mimetype = normalizedMime;

    // ── Step 2: Knowledge base lookup — runs for EVERY scan, EVERY user ──────────
    // This is the core of the learning system. Checks the permanent
    // fingerprint_knowledge table before doing anything else — no ACR call,
    // no duplicate check, no library lookup needed if we already know the answer.
    const knownPlacement = await knowledgeGet(fingerprintId);
    if (knownPlacement) {
      console.log(`Knowledge base hit: ${fingerprintId} → "${knownPlacement.title}"`);

      if (user_id && SUPABASE_URL) {
        try {
          // Check if this user already has this beat — if so just update last_scanned
          const userExisting = await sbSelect("beats", `user_id=eq.${user_id}&fingerprint_id=eq.${encodeURIComponent(fingerprintId)}`);
          if (Array.isArray(userExisting) && userExisting.length > 0) {
            await sbUpdate("beats", `id=eq.${userExisting[0].id}`, {
              last_scanned: new Date().toISOString(),
              // Patch in DSP data if this beat record was missing it
              ...(knownPlacement.spotify_id && !userExisting[0].spotify_id ? { spotify_id: knownPlacement.spotify_id } : {}),
              ...(knownPlacement.youtube_id && !userExisting[0].youtube_id ? { youtube_id: knownPlacement.youtube_id } : {}),
              status: "placed",
              last_result: knownPlacement.title,
              last_artist: knownPlacement.artist || userExisting[0].last_artist || null,
            });
          } else {
            // New user scanning this beat — register it for them immediately as placed
            const storagePath = `${user_id}/${req.file.originalname}`;
            await storageUpload(storagePath, req.file.buffer, req.file.mimetype);
            await sbInsert("beats", {
              user_id,
              filename:       req.file.originalname,
              storage_path:   storagePath,
              status:         "placed",
              last_scanned:   new Date().toISOString(),
              last_result:    knownPlacement.title,
              last_artist:    knownPlacement.artist    || null,
              spotify_id:     knownPlacement.spotify_id || null,
              youtube_id:     knownPlacement.youtube_id || null,
              track_url:      knownPlacement.track_url  || null,
              uploaded_at:    new Date().toISOString(),
              fingerprint_id: fingerprintId,
              audio_hash:     audioHash,
            });
            // Only increment submission count for brand-new registrations
            const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
            const profile   = profiles?.[0];
            if (profile) await sbUpdate("profiles", `id=eq.${user_id}`, { submissions_used: (profile.submissions_used || 0) + 1 });
          }
        } catch (regErr) { console.error("Knowledge-base beat registration error (non-fatal):", regErr.message); }
      }

      const injected = {
        title:    knownPlacement.title,
        artists:  knownPlacement.artist ? [{ name: knownPlacement.artist }] : [],
        score:    100,
        release_date: null,
        external_metadata: {
          ...(knownPlacement.spotify_id ? { spotify: { track: { id: knownPlacement.spotify_id } } } : {}),
          ...(knownPlacement.youtube_id ? { youtube: { vid: knownPlacement.youtube_id } }           : {}),
        },
        _source:      "knowledge_base",
        _fromLibrary: true,
      };
      return res.json({
        status:         { code: 0, msg: "Success" },
        metadata:       { music: [injected], humming: [] },
        fingerprint_id: fingerprintId,
        bpm:            null,
        audio_key:      null,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Step 3: Per-user access + quota checks (only reached if knowledge base missed) ──
    if (user_id && SUPABASE_URL) {
      const status = await getSubscriptionStatus(user_id);
      if (!status.hasAccess) return res.status(403).json({ error: status.pastDue ? "Your payment is past due. Please update billing to continue scanning." : "Your free trial has ended. Subscribe to continue scanning." });
      if (status.submissionLimit!==null && status.submissionsUsed>=status.submissionLimit) return res.status(403).json({ error:`Submission limit reached (${status.submissionsUsed}/${status.submissionLimit}). Upgrade to scan more beats.` });

      const DAILY_CAP = 50;
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayBeats = await sbSelect("beats", `user_id=eq.${user_id}&created_at=gte.${todayStart.toISOString()}`);
      if (Array.isArray(todayBeats) && todayBeats.length >= DAILY_CAP) {
        return res.status(429).json({ error:`Daily limit of ${DAILY_CAP} uploads reached. Come back tomorrow.` });
      }

      // Re-test: beat already in this user's library — run a fresh scan and inject
      // any existing verified placement so the result is always up to date.
      const existing = await sbSelect("beats", `user_id=eq.${user_id}&fingerprint_id=eq.${encodeURIComponent(fingerprintId)}`);
      if (Array.isArray(existing) && existing.length > 0) {
        const beat = existing[0];
        const freshAcrData = await scanAllEngines(req.file.buffer, req.file.originalname, req.file.mimetype);
        await sbUpdate("beats", `id=eq.${beat.id}`, { last_scanned: new Date().toISOString() });

        const retestData = JSON.parse(JSON.stringify(freshAcrData || { status:{ code:1001, msg:"No result" }, metadata:{ music:[], humming:[] } }));
        if (beat.status === "placed" && beat.last_result) {
          const injected = {
            title:    beat.last_result,
            artists:  beat.last_artist ? [{ name: beat.last_artist }] : [],
            score:    100,
            release_date: null,
            external_metadata: {
              ...(beat.spotify_id ? { spotify: { track: { id: beat.spotify_id } } } : {}),
              ...(beat.youtube_id ? { youtube: { vid: beat.youtube_id } }           : {}),
            },
            _source:      "verified_placement",
            _fromLibrary: true,
          };
          const existingTitles = (retestData.metadata?.music || []).map(m => (m.title||"").toLowerCase().trim());
          if (!existingTitles.includes((beat.last_result||"").toLowerCase().trim())) {
            if (!retestData.metadata) retestData.metadata = { music: [], humming: [] };
            retestData.metadata.music = [injected, ...(retestData.metadata.music || [])];
          }
          retestData.status = { code: 0, msg: "Success" };
        }
        const clientKey = req.body.client_key || null;
        const clientBpm = req.body.client_bpm ? parseFloat(req.body.client_bpm) : null;
        const md = retestData?.metadata || {};
        const rBpm = md.beats?.bpm || md.music?.[0]?.bpm || null;
        const rKey = md.music?.[0]?.key?.note ? (md.music[0].key.note + (md.music[0].key.scale ? " " + md.music[0].key.scale : "")) : null;
        return res.json({ ...retestData, fingerprint_id: beat.fingerprint_id || fingerprintId, bpm: rBpm || clientBpm, audio_key: rKey || clientKey, _retest: true });
      }
    }

    // Fan out across 5 slices × 2 engines (ACRCloud + AudD), all in parallel
    const acrData = await scanAllEngines(req.file.buffer, req.file.originalname, req.file.mimetype);

    // Extract BPM, key, duration from ACRCloud response if available
    // Fall back to client-side detected values if ACRCloud didn't return them
    const clientKey = req.body.client_key || null;
    const clientBpm = req.body.client_bpm ? parseFloat(req.body.client_bpm) : null;

    // Pull producer_since from profile to filter out pre-career results
    let producerSinceYear = null;
    if (user_id) {
      try {
        const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
        producerSinceYear = profiles?.[0]?.producer_since ? parseInt(profiles[0].producer_since) : null;
      } catch(e) { /* non-fatal */ }
    }

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
        // Quality filter — must match the frontend's "confident" threshold exactly:
        // score >= 99 AND a confirmed DSP ID (Spotify, YouTube, or Deezer).
        // Anything below this is a "possible" match on the frontend and must NOT
        // write "placed" to the DB — the user has to verify it manually first.
        const BAD_TITLES = ["unknown","untitled","","no title","n/a","na","null","undefined"];
        function hasDspId(m) {
          return !!(
            m.external_metadata?.spotify?.track?.id ||
            m.external_metadata?.youtube?.vid ||
            m.external_metadata?.deezer?.track?.id
          );
        }
        function isGoodMatch(m) {
          if (!m) return false;
          const score = m.score || 100;
          if (score < 99) return false;          // must be high-confidence
          if (!hasDspId(m)) return false;        // must have a verifiable DSP link
          const title = (m.title || "").toLowerCase().trim();
          if (BAD_TITLES.includes(title)) return false;
          if (title.includes("untitled")) return false;
          // Filter out releases that predate when the user started producing
          if (producerSinceYear) {
            const releaseDate = m.release_date || m.external_metadata?.spotify?.album?.release_date || null;
            if (releaseDate) {
              const releaseYear = new Date(releaseDate).getFullYear();
              if (!isNaN(releaseYear) && releaseYear < producerSinceYear) return false;
            }
          }
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

        // ── Storage upload — non-blocking ───────────────────────
        // Failures here must NEVER prevent the beat from being saved to the DB.
        // The audio file is only needed for rescanning; the library entry is
        // what the user sees and must always be created.
        let uploadedPath = null;
        try {
          await storageUpload(storagePath, req.file.buffer, req.file.mimetype);
          uploadedPath = storagePath;
          console.log(`Storage upload OK: ${storagePath}`);
        } catch(uploadErr) {
          console.error("Storage upload failed (non-fatal — beat will still be saved):", uploadErr.message);
        }

        // ── Beat DB insert — this is the critical step ──────────
        // Always runs regardless of whether storage upload succeeded.
        let insertedBeat = null;
        try {
          const insertResult = await sbInsert("beats", {
            user_id,
            filename:       req.file.originalname,
            storage_path:   uploadedPath,   // null if upload failed — rescan will skip it
            status:         "monitoring",
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
          insertedBeat = Array.isArray(insertResult) ? insertResult[0] : insertResult;
          console.log(`Beat saved to DB: ${insertedBeat?.id || "(no id returned)"} — "${req.file.originalname}" user=${user_id}`);
        } catch(insertErr) {
          console.error("CRITICAL: Beat DB insert failed:", insertErr.message, "user=", user_id, "file=", req.file.originalname);
        }

        // Append to fingerprint log on profile (non-fatal)
        try {
          const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
          const profile  = profiles?.[0];
          const existing = profile?.fingerprint_log || [];
          const entry    = { id: fingerprintId, hash: audioHash, filename: req.file.originalname, registered_at: new Date().toISOString() };
          if (!existing.find(function(e){ return e.id === fingerprintId; })) {
            await sbUpdate("profiles", `id=eq.${user_id}`, { fingerprint_log: [...existing, entry] });
          }
        } catch(logErr) { console.error("Fingerprint log error (non-fatal):", logErr.message); }

        // Increment submission counter (non-fatal)
        try {
          const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
          const profile   = profiles?.[0];
          if (profile) await sbUpdate("profiles", `id=eq.${user_id}`, { submissions_used:(profile.submissions_used||0)+1 });
        } catch(countErr) { console.error("Submission count error (non-fatal):", countErr.message); }

        // Teach the knowledge base from high-confidence auto-matches (non-fatal)
        if (matched && title) {
          knowledgeWrite({
            fingerprint_id: fingerprintId,
            title,
            artist:     artist     || null,
            spotify_id: spotifyId  || null,
            youtube_id: youtubeId  || null,
            verified_by: user_id,
            confidence:  95,
            source:      "auto_scan",
          }).catch(e => console.error("Knowledge write from auto-scan (non-fatal):", e.message));
        }
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

app.post("/profile/producer-since", async (req, res) => {
  try {
    const { user_id, producer_since } = req.body;
    if (!user_id || !producer_since) return res.status(400).json({ error:"Missing fields." });
    await sbUpdate("profiles", `id=eq.${user_id}`, { producer_since: parseInt(producer_since) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Rescan (twice daily) ───────────────────────────────────────
// Hit POST /rescan with header x-rescan-secret on a cron schedule.
// Recommended: 0 6 * * * and 0 18 * * * (6am + 6pm UTC) for ~12h detection window.
// Each call uses the full 3-engine fan-out (ACRCloud + AudD + Shazam).
const rescanLog = { lastRun: null, lastResult: null };

app.get("/rescan/status", (req, res) => {
  if (req.headers["x-rescan-secret"]!==RESCAN_SECRET) return res.status(401).json({ error:"Unauthorized" });
  res.json({ lastRun: rescanLog.lastRun, lastResult: rescanLog.lastResult });
});

app.post("/rescan", async (req, res) => {
  if (req.headers["x-rescan-secret"]!==RESCAN_SECRET) return res.status(401).json({ error:"Unauthorized" });
  try {
    const beats = await sbSelect("beats","status=eq.monitoring&order=last_scanned.asc");
    if (!Array.isArray(beats)||beats.length===0) {
      rescanLog.lastRun = new Date().toISOString();
      rescanLog.lastResult = { message:"No beats to rescan.", count:0 };
      return res.json(rescanLog.lastResult);
    }
    console.log(`Rescanning ${beats.length} beats (3 engines × up to 6 slices each)...`);
    let newMatches=0, scanned=0, skipped=0;
    for (const beat of beats) {
      try {
        if (!beat.storage_path) { skipped++; continue; }
        const status=await getSubscriptionStatus(beat.user_id);
        if (!status.hasAccess) { console.log(`Skipping ${beat.id} — no access`); skipped++; continue; }
        const buffer=await storageDownload(beat.storage_path);
        if (!buffer) { skipped++; continue; }
        // Pull producer_since for this user to filter pre-career results
        let rescanProducerSince = null;
        try {
          const rProfiles = await sbSelect("profiles", `id=eq.${beat.user_id}`);
          rescanProducerSince = rProfiles?.[0]?.producer_since ? parseInt(rProfiles[0].producer_since) : null;
        } catch(e) { /* non-fatal */ }
        const acrData=await scanAllEngines(buffer, beat.filename, "audio/mpeg");
        const rawMatched = acrData?.status?.code===0;
        const scanMusic  = acrData?.metadata?.music || [];
        // Same confident threshold as frontend and scan endpoint:
        // score >= 99 AND a confirmed DSP ID required to write "placed".
        function hasDspIdRescan(m) {
          return !!(
            m.external_metadata?.spotify?.track?.id ||
            m.external_metadata?.youtube?.vid ||
            m.external_metadata?.deezer?.track?.id
          );
        }
        function isGoodRescanMatch(m) {
          if (!m) return false;
          if ((m.score||100) < 99) return false;   // high-confidence only
          if (!hasDspIdRescan(m)) return false;     // must have a verifiable DSP link
          const t = (m.title||"").toLowerCase().trim();
          const badT = ["unknown","untitled","","no title","n/a","na","null","undefined"];
          if (badT.includes(t)||t.includes("untitled")) return false;
          if (rescanProducerSince) {
            const releaseDate = m.release_date || m.external_metadata?.spotify?.album?.release_date || null;
            if (releaseDate) {
              const releaseYear = new Date(releaseDate).getFullYear();
              if (!isNaN(releaseYear) && releaseYear < rescanProducerSince) return false;
            }
          }
          return true;
        }
        const goodRescanMusic = rawMatched ? scanMusic.filter(isGoodRescanMatch) : [];
        const matched = goodRescanMusic.length > 0;
        const bestRescan = matched ? goodRescanMusic[0] : null;
        scanned++;
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
        // Stagger requests — slightly longer gap to respect rate limits across 3 engines
        await new Promise(r=>setTimeout(r,700));
      } catch(e) { console.error(`Rescan error beat ${beat.id}:`,e.message); skipped++; }
    }
    const result = { message:"Rescan complete.", total:beats.length, scanned, skipped, newMatches };
    rescanLog.lastRun = new Date().toISOString();
    rescanLog.lastResult = result;
    res.json(result);
  } catch(e) { console.error("Rescan error:",e.message); res.status(500).json({ error:e.message }); }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
  // IMPORTANT: profiles table needs a `fingerprint_log` JSONB column.
  // Run this in Supabase SQL editor if not already added:
  // ALTER TABLE profiles ADD COLUMN IF NOT EXISTS fingerprint_log JSONB DEFAULT '[]'::jsonb;
  console.log("Note: ensure profiles.fingerprint_log JSONB column exists in Supabase.");
});
