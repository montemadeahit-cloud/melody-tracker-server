const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const crypto     = require("crypto");
const fetch      = require("node-fetch");
const FormData   = require("form-data");
const { spawn }  = require("child_process");

// ── ffmpeg binary resolution ──────────────────────────────────
// Prefer the bundled ffmpeg-static binary so transcoding NEVER depends on the
// Railway image shipping ffmpeg on PATH. Falls back to a PATH "ffmpeg" if the
// package isn't installed. (Install once: `npm install ffmpeg-static`.)
let FFMPEG_BIN = "ffmpeg";
try { const s = require("ffmpeg-static"); if (s) FFMPEG_BIN = s; } catch (_) {}

// Boot probe — log loudly whether transcoding is actually available, so a missing
// binary shows up in Railway logs on deploy instead of silently storing raw WAVs.
(() => {
  try {
    const probe = spawn(FFMPEG_BIN, ["-version"]);
    probe.on("error", e => console.error(`⚠️  FFMPEG UNAVAILABLE ("${FFMPEG_BIN}") — lossless uploads will be STORED UNCONVERTED. ${e.message}`));
    probe.stdout.once("data", d => console.log(`✓ ffmpeg ready (${FFMPEG_BIN}): ${d.toString().split("\n")[0]}`));
  } catch (e) { console.error("ffmpeg boot probe failed:", e.message); }
})();

// ── Global crash guards ───────────────────────────────────────
// Prevent ANY unhandled error or rejected promise from killing the process.
// Railway will restart the container on crash, but that causes downtime.
// Log everything so bugs are still visible in Railway logs.
process.on("uncaughtException",  (err) => console.error("UNCAUGHT EXCEPTION:", err?.message, err?.stack));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err?.message || err));

const app  = express();
const port = process.env.PORT || 8080;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-rescan-secret", "stripe-signature"],
}));

app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// Baseline security headers
app.use(function(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
});

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

// Security-critical env checks — warn loudly on deploy if anything's missing/weak.
if (!STRIPE_WEBHOOK) console.error("⚠️  SECURITY: STRIPE_WEBHOOK_SECRET not set — Stripe webhooks are processed WITHOUT signature verification. Anyone could forge subscription events. Set it now.");
if (!process.env.RESCAN_SECRET) console.error("⚠️  SECURITY: RESCAN_SECRET not set — falling back to a guessable default. Set a strong RESCAN_SECRET.");
if (!process.env.ADMIN_SECRET) console.warn("ℹ️  ADMIN_SECRET not set — /admin endpoints fall back to RESCAN_SECRET.");

// ── Tier limits ───────────────────────────────────────────────
// NOTE ON COST: every monitored beat is rescanned on a schedule across the
// recognition engines, so the *number of beats a user keeps monitored* — not
// the price — is what drives recurring spend. These caps bound that exposure.
// To change Tier 2 to 200, just change its `submissions` (and `emailMonitors`)
// below from 150 to 200. Unlimited is intentionally NOT used at $19.99 because
// daily multi-engine rescans make truly-unlimited monitoring unprofitable.
const LIMITS = {
  trial: { submissions: 25,   emailMonitors: 0,    label: "Free Trial" },
  tier1: { submissions: 50,   emailMonitors: 50,   label: "Tier 1"     },
  tier2: { submissions: 150,  emailMonitors: 150,  label: "Tier 2"     },
};
function getLimits(tier) { return LIMITS[tier] || LIMITS.trial; }

// ── Comped accounts ───────────────────────────────────────────
// Usernames in this set are always granted full Tier 2 access,
// regardless of trial/Stripe state. Matched case-insensitively.
const COMP_TIER2 = new Set(["montemadethis"]);

// Usernames in this set are always granted full Tier 1 access (free, never billed),
// regardless of trial/Stripe state. Matched case-insensitively.
// To remove a comp later, just delete the username from this set.
const COMP_TIER1 = new Set(["prodbycaset"]); // casetbeats@gmail.com — manual Tier 1 grant

// ── Card-required trial config ────────────────────────────────
// NEW signups (card_required = true) must enter a card to start a Stripe-native
// 7-day trial that auto-bills the chosen tier afterward. EXISTING users
// (card_required falsy) are completely unaffected and keep the old cardless trial.
const CARD_REQUIRED_TRIAL_DAYS = 7;
// During a card-required trial, grant the limits of the tier being trialed
// (a true "free trial of Tier 1/2"). Set to false to cap trials at the basic
// LIMITS.trial (25 scans / 0 monitors) instead.
const TRIAL_USES_TIER_LIMITS = true;

// ── HTML escaping for email templates ───────────────────────────
// Any user-controlled string (username, filename, title/artist submitted via
// verify-placement, support form fields) MUST go through this before landing
// in an email template — those templates interpolate raw strings into HTML,
// and several of these values come straight from user input with no format
// restriction. Without this, someone could inject markup/links into emails
// sent to themselves, other users (via the shared knowledge base), or you.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
// Reusable in-memory IP rate limiter factory
function makeRateLimiter(max, windowMs) {
  const hits = new Map();
  // opportunistic cleanup so the map can't grow unbounded
  setInterval(() => { const now = Date.now(); for (const [k, e] of hits) if (now - e.firstAt > windowMs) hits.delete(k); }, windowMs).unref?.();
  return function(ip) {
    const now = Date.now();
    const e = hits.get(ip);
    if (!e || now - e.firstAt > windowMs) { hits.set(ip, { count:1, firstAt:now }); return true; }
    if (e.count >= max) return false;
    e.count++;
    return true;
  };
}
const checkLoginRate   = makeRateLimiter(12, 15*60*1000); // brute-force guard: 12 / 15 min
const checkForgotRate  = makeRateLimiter(5,  60*60*1000); // 5 / hour
const checkSupportRate = makeRateLimiter(8,  60*60*1000); // 8 / hour
// The 4 track-lookup endpoints (spotify/apple/youtube/soundcloud) take no auth
// by design (called before the app always has a token handy) and had NO rate
// limiting at all — anyone could script-hammer them, running up your outbound
// request volume and risking your server's IP getting rate-limited upstream.
const checkLookupRate  = makeRateLimiter(40, 10*60*1000); // 40 / 10 min per IP

// Rolling log of the most recent Stripe webhook events (in-memory, last 50).
// Lets /admin/metrics surface whether webhooks are arriving and verifying — a
// silently-misconfigured webhook secret is otherwise invisible until a customer
// pays and never gets access.
const webhookLog = [];
function logWebhook(entry) { webhookLog.push(Object.assign({ t: new Date().toISOString() }, entry)); if (webhookLog.length > 50) webhookLog.shift(); }

// Clear rate limit for an IP (debug). Locked behind an admin secret — was public.
app.get("/admin/reset-ratelimit", (req, res) => {
  const secret = process.env.ADMIN_SECRET || RESCAN_SECRET;
  if ((req.headers["x-admin-secret"] || "") !== secret) return res.status(403).json({ error: "Forbidden" });
  signupAttempts.clear();
  res.json({ cleared: true });
});

// ── Network resilience ────────────────────────────────────────
// Outbound calls to Supabase (and Stripe) occasionally fail with transient,
// non-HTTP errors like "Premature close" / "socket hang up" / "aborted" —
// the connection dropping mid-response. This is usually a stale keep-alive
// socket, but can also mean the upstream (Supabase) is degraded, in which
// case connections hang or drop repeatedly, not just as a single blip.
//
// IMPORTANT: "Premature close" happens while the response BODY is being
// streamed in — not while the initial fetch() promise resolves (that only
// waits for headers). An earlier version of this function only wrapped the
// fetch() call itself in the retry loop, and callers read the body (.text()/
// .json()) afterward, outside the loop — so a drop during the body read
// was never actually retried, it just threw once and gave up. This version
// reads the body itself, inside the loop, so a failure there triggers a
// full fresh retry (new connection, new attempt) like it's supposed to.
// Returns a Response-like object (ok/status/headers/.text()/.json()) so
// every existing caller keeps working unchanged.
async function fetchRetry(url, opts = {}, retries = 3, delayMs = 400, timeoutMs = 10000) {
  // Ask Supabase to skip gzip compression by default. A "Premature close" that
  // fails 100% of the time (not just intermittently) is a classic symptom of
  // something in the network path mishandling a compressed response — the
  // connection gets cut before the compressed stream properly terminates.
  // Plain, uncompressed responses sidestep that failure mode entirely. Callers
  // can still override this by passing their own Accept-Encoding header.
  const headers = Object.assign({ "Accept-Encoding": "identity" }, opts.headers || {});
  opts = Object.assign({}, opts, { headers });
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
      const text = await r.text(); // read the body NOW, still inside the retry loop
      clearTimeout(timer);
      return {
        ok: r.ok,
        status: r.status,
        headers: r.headers,
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    } catch (e) {
      clearTimeout(timer);
      const transient = /premature close|socket hang up|aborted|ECONNRESET|ETIMEDOUT|network|timeout/i.test(e.message || "") || e.name === "AbortError";
      if (attempt === retries || !transient) throw e;
      const wait = delayMs * (attempt + 1) + Math.floor(Math.random() * 200);
      console.error(`fetchRetry: transient error on attempt ${attempt + 1}/${retries + 1} for ${url}: ${e.message} — retrying in ${wait}ms`);
      await new Promise(res => setTimeout(res, wait));
    }
  }
}

// ── Auth verification ─────────────────────────────────────────
// Verify a Supabase access token (Bearer header, or ?t= for media tags that
// can't set headers) and return the authenticated user, or null.
async function getAuthUser(req) {
  let token = null;
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) token = auth.slice(7);
  if (!token && req.query && req.query.t) token = String(req.query.t);
  if (!token) return null;
  try {
    const r = await fetchRetry(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) ? u : null;
  } catch (e) { return null; }
}
// Require a valid token; sends 401 and returns null if absent/invalid.
async function authOr401(req, res) {
  const u = await getAuthUser(req);
  if (!u) { res.status(401).json({ error: "Authentication required. Please sign in again." }); return null; }
  return u;
}

// ── Supabase helpers ──────────────────────────────────────────
async function sbInsert(table, row) {
  let r;
  try { r = await fetchRetry(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`,"Prefer":"return=representation"}, body:JSON.stringify(row),
  }); } catch(e) { console.error(`sbInsert(${table}) network error:`, e.message); return null; }
  const text = await r.text();
  if (!r.ok) {
    let detail = text;
    try { const j = JSON.parse(text); detail = j.message || j.details || j.hint || text; } catch(e) {}
    console.error(`sbInsert(${table}) failed HTTP ${r.status}: ${detail.slice(0,300)}`);
    return null;
  }
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); } catch(e) { console.error("sbInsert parse error:", table, r.status, text.slice(0,200)); return null; }
}
async function sbSelect(table, filter) {
  let r;
  try { r = await fetchRetry(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`},
  }); } catch(e) { console.error(`sbSelect(${table}) network error:`, e.message); return []; }
  const text = await r.text();
  if (!text || !text.trim()) { console.error("sbSelect empty response:", r.status, table, filter); return []; }
  try { return JSON.parse(text); } catch(e) { console.error("sbSelect parse error:", table, r.status, text.slice(0,200)); return []; }
}
async function sbUpdate(table, filter, row) {
  let r;
  try { r = await fetchRetry(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method:"PATCH", headers:{"Content-Type":"application/json","apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`}, body:JSON.stringify(row),
  }); } catch(e) { console.error(`sbUpdate(${table}) network error:`, e.message); return null; }
  const text = await r.text();
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); } catch(e) { return null; }
}
async function sbDelete(table, filter) {
  try {
    const r = await fetchRetry(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method:"DELETE", headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`},
    }); return r.ok;
  } catch (e) { console.error(`sbDelete(${table}) network error:`, e.message); return false; }
}
// Exact row count without transferring the rows — reads Content-Range from a
// count=exact HEAD-style request (we ask for a single row to keep it cheap).
async function sbCount(table, filter) {
  try {
    const r = await fetchRetry(`${SUPABASE_URL}/rest/v1/${table}?${filter || ""}`, {
      headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}`, "Prefer":"count=exact", "Range":"0-0" },
    });
    const cr = r.headers.get("content-range"); // "0-0/1234" or "*/1234"
    if (!cr || !cr.includes("/")) return null;
    const total = cr.split("/")[1];
    return total === "*" ? null : parseInt(total, 10);
  } catch (e) { return null; }
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

// ── Lossless → MP3 transcode ──────────────────────────────────
// Uploads land in memory (multer). Lossless formats (WAV ~40MB, AIFF, FLAC) are
// transcoded to 192kbps MP3 *before* anything is stored, so a maxed Tier 3
// catalog can't blow up Supabase storage + egress. This is what keeps the
// stored-file assumption (~5–6MB/beat) — and Tier 3's margin — intact.
// Already-compressed uploads (mp3/m4a/aac/ogg) are left alone: no re-encode,
// no generational quality loss. Identity is hashed from the ORIGINAL bytes
// upstream, so transcoding never affects a beat's fingerprint.
const MP3_BITRATE = process.env.TRANSCODE_BITRATE || "192k";
const LOSSLESS_EXT  = /\.(wav|wave|aif|aiff|aifc|flac)$/i;
const LOSSLESS_MIME = /^audio\/(x-)?(wav|wave|aiff|aif|flac)$/i;
function isLossless(name, mime) {
  return LOSSLESS_EXT.test(name || "") || LOSSLESS_MIME.test(mime || "");
}
// Transcode an audio buffer to MP3 via ffmpeg using stdio pipes (no temp files —
// Railway's FS is ephemeral). Resolves to a Buffer; rejects on failure so the
// caller can fall back to the original buffer rather than failing the upload.
function transcodeToMp3(inputBuffer, bitrate = MP3_BITRATE) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",                       // drop any cover-art/video stream
      "-map_metadata", "-1",       // strip tags — smaller, no PII leakage
      "-ac", "2",
      "-acodec", "libmp3lame",
      "-b:a", bitrate,
      "-f", "mp3",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const out = [], errBuf = [];
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(killer); fn(arg); } };
    // Hard ceiling so a pathological file can't hang the request thread.
    const killer = setTimeout(() => { try { ff.kill("SIGKILL"); } catch(_){} finish(reject, new Error("transcode timeout")); }, 90_000);

    ff.stdout.on("data", d => out.push(d));
    ff.stderr.on("data", d => errBuf.push(d));
    ff.on("error", err => finish(reject, err)); // e.g. ffmpeg not on PATH
    ff.on("close", code => {
      if (code === 0 && out.length) return finish(resolve, Buffer.concat(out));
      finish(reject, new Error("ffmpeg exited " + code + ": " + Buffer.concat(errBuf).toString().slice(0, 400)));
    });

    ff.stdin.on("error", () => {}); // swallow EPIPE if ffmpeg dies early
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
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
function getSlices(buffer, rescan) {
  if (buffer.length <= MIN_SCAN_BYTES) return [buffer];
  const s   = SLICE_BYTES;
  const len = buffer.length;
  // On rescan, chop at DIFFERENT positions than the first scan so we cover
  // sections the original slices missed — widens placement detection over time.
  const positions = rescan ? [0.05, 0.27, 0.50, 0.73, 0.93] : [0.15, 0.38, 0.62, 0.85];
  const offsets = positions.map(p => Math.floor(len * p));
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
  if (r.itunes?.trackId)     external_metadata.itunes  = { track: { id: r.itunes.trackId }, url: r.itunes.trackViewUrl || null };
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
    // Strip punctuation entirely and collapse whitespace — different DSPs/engines
    // often return the same song with slightly different punctuation or spacing
    // ("Song Name!" vs "Song Name", double spaces, curly vs straight quotes).
    // Without this, the same real song could get recorded as two "different"
    // placements and trigger a spurious duplicate notification email.
    .replace(/['’"“”.,!?:;]/g, "")
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
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
      const eng = m._source || "acrcloud";
      const existing = musicMap.get(key);
      if (!existing) {
        musicMap.set(key, { ...m, _hits: 1, _engines: [eng] });
      } else {
        // Accumulate corroboration on EVERY re-detection, independent of which
        // entry's metadata "wins". _hits = how many slices/engines saw this track;
        // _engines = the distinct engines that saw it. These are the real signal
        // that separates a genuine placement (your beat runs through the whole song,
        // so it matches many slices) from a one-off sample/loop collision.
        const engines = existing._engines.indexOf(eng) === -1 ? existing._engines.concat([eng]) : existing._engines;
        const hits    = (existing._hits || 1) + 1;
        const existingDsp = (existing.external_metadata?.spotify?.track?.id ? 1 : 0) + (existing.external_metadata?.youtube?.vid ? 1 : 0);
        const newDsp      = (m.external_metadata?.spotify?.track?.id ? 1 : 0) + (m.external_metadata?.youtube?.vid ? 1 : 0);
        let base = existing;
        if ((m.score || 0) > (existing.score || 0) || newDsp > existingDsp) {
          base = { ...existing, ...m, score: Math.max(m.score || 0, existing.score || 0) };
          base.external_metadata = { ...existing.external_metadata, ...m.external_metadata };
        }
        base._hits = hits;
        base._engines = engines;
        musicMap.set(key, base);
      }
    }
    for (const m of (r?.metadata?.humming || [])) {
      const key = normaliseTitle(m.title);
      if (!key) continue;
      const existing = hummingMap.get(key);
      if (!existing || (m.score || 0) > (existing.score || 0)) hummingMap.set(key, m);
    }
  }

  // Corroboration-weighted ranking. A track detected across multiple slices and/or
  // engines beats a lone high-score hit: extra detections add +7 each, a second
  // distinct engine adds +14. This lets the genuinely-placed track overcome a small
  // score deficit against a single-slice false positive — without letting a weak,
  // repeated noise match leapfrog a clean, dominant one.
  function rankScore(m){
    const hits = m._hits || 1;
    const engines = (m._engines || []).length || 1;
    return (m.score || 0) + (hits - 1) * 7 + (engines - 1) * 14;
  }
  const music = [...musicMap.values()]
    .map(m => Object.assign({}, m, { _rank: rankScore(m), _corroborated: ((m._hits||1) >= 2 || (m._engines||[]).length >= 2) }))
    .sort((a, b) => (b._rank || 0) - (a._rank || 0));
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

// ── Shazam (via RapidAPI — DashyData "Shazam Song Recognition API") ──────────
// Third fingerprint engine — different algorithm and database to ACRCloud/AudD.
// Particularly strong on rap/trap/R&B instrumentals.
// Requires RAPIDAPI_KEY env var (subscribe to the API on RapidAPI first).
// Endpoint: POST /recognize/file — raw audio bytes as application/octet-stream.
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const SHAZAM_HOST   = "shazam-song-recognition-api.p.rapidapi.com";
function shazamSpotifyId(uri) {
  if (!uri) return null;
  // handles "spotify:track:ID", ".../track/ID?...", "open.spotify.com/track/ID"
  const m = uri.match(/track[:/]([A-Za-z0-9]{16,})/);
  return m ? m[1] : null;
}
async function identifyShazam(buffer, filename) {
  if (!RAPIDAPI_KEY) return null;
  try {
    const res = await fetch(`https://${SHAZAM_HOST}/recognize/file`, {
      method: "POST",
      headers: {
        "Content-Type":    "application/octet-stream",
        "x-rapidapi-key":  RAPIDAPI_KEY,
        "x-rapidapi-host": SHAZAM_HOST,
      },
      body: buffer,                       // raw audio bytes
    });
    if (!res.ok) { console.error("Shazam HTTP", res.status); return null; }
    const data = await res.json();
    // Shazam-style payload. Be tolerant of a few common nestings.
    const track = data?.track || data?.matches?.[0]?.track || data?.result?.track || data?.result || null;
    if (!track || !track.title) return null;
    const external_metadata = {};
    const actions = track.hub?.actions || track.hub?.options?.flatMap(o => o.actions || []) || [];
    const spotifyAction = actions.find(a => a && a.uri && a.uri.includes("spotify"));
    const spotifyId = shazamSpotifyId(spotifyAction?.uri);
    if (spotifyId) external_metadata.spotify = { track: { id: spotifyId } };
    const appleAction = actions.find(a => a && a.uri && a.uri.includes("apple"));
    if (appleAction) external_metadata.itunes = { uri: appleAction.uri };
    const norm = {
      title:        track.title,
      artists:      track.subtitle ? [{ name: track.subtitle }] : [],
      release_date: null,
      score:        90,   // Shazam returns no confidence score — treat hits as high-confidence
      external_metadata,
      _source:      "shazam",
    };
    return { status: { code: 0, msg: "Success" }, metadata: { music: [norm], humming: [] } };
  } catch(e) {
    console.error("Shazam error:", e.message);
    return null;
  }
}

// Pick the single most distinctive slice for the metered single-shot engines.
// getSlices first-scan positions are [0.15, 0.38, 0.62, 0.85](+full buffer);
// index 2 is the ~62% mid-track hook — the strongest section to fingerprint.
function pickBestSlice(slices) {
  if (!slices.length) return null;
  if (slices.length === 1) return slices[0];
  return slices[Math.min(2, slices.length - 1)];
}
// Evenly sample N slices, always keeping the first and the most distinctive.
function sliceSubset(slices, n) {
  if (slices.length <= n) return slices;
  const step = (slices.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(slices[Math.round(i * step)]);
  return out;
}

// ── Fan-out: ACRCloud (primary, multi-slice) + AudD & Shazam (single-shot) ───
// COST MODEL: ACRCloud is the strongest engine and the cheapest per call, so it
// does the full multi-slice sweep. AudD and Shazam are metered per request and
// exist only to catch what ACR misses — one pass each on the single most
// distinctive slice captures ~90% of that at a fraction of the cost.
// (Previously every engine fired on every slice → ~3× the metered spend.)
// On RESCAN, ACR is trimmed to its 3 most informative slices, since a rescan
// only asks "has this surfaced SINCE last time?", not "what is this?".
// ── Optimal-usage / cost control ──────────────────────────────
// The recurring cost in this app is the scheduled RESCAN of every monitored
// beat — it repeats forever, per beat, across engines. The first scan happens
// once; rescans happen on every cron tick. So secondary metered engines (AudD +
// Shazam) are most valuable on the FIRST scan (max coverage when it matters) and
// least cost-efficient on rescans (paying every day to re-confirm the same beat).
//
// RESCAN_SECONDARY_ENGINES:
//   false (default) → rescans run ACRCloud only. Cheapest. ACR is the strongest
//                     single engine and already sweeps multiple slices; AudD/Shazam
//                     still run on the first scan and on any user-triggered re-test.
//   true            → rescans also fire AudD + Shazam (old behaviour, ~2× the
//                     per-rescan metered spend for marginally more recall).
const RESCAN_SECONDARY_ENGINES = false;

// RESCAN_ACR_SLICES — how many ACR slices each scheduled rescan sends per beat.
// This is the single biggest lever on rescan cost. ACR bills per slice, so:
//   1 (default) → 1 slice/beat/rescan. ~$0.004/beat/rescan. At an every-3-days
//                 cron that's ~10 rescans/mo = ~$0.04/beat/month (≈$0.12 if daily).
//                 To keep coverage high we ROTATE which slice is used each run, so
//                 over a week every section of the track gets fingerprinted.
//   2–3         → more recall per single rescan, proportionally more cost.
// First scans are unaffected — they always sweep every slice.
const RESCAN_ACR_SLICES = 1;

// Pick ACR slices for a rescan. For a single slice we rotate by day so coverage
// builds across the week; for >1 we evenly sample (and always keep first + last).
function rescanAcrSlices(slices) {
  const n = Math.max(1, Math.min(RESCAN_ACR_SLICES, slices.length));
  if (n >= slices.length) return slices;
  if (n === 1) {
    const day = Math.floor(Date.now() / 86400000); // days since epoch → rotates daily
    return [slices[day % slices.length]];
  }
  return sliceSubset(slices, n);
}

async function scanAllEngines(buffer, filename, mimetype, rescan) {
  const slices    = getSlices(buffer, rescan);
  const acrSlices = rescan ? rescanAcrSlices(slices) : slices;
  const bestSlice = pickBestSlice(slices);

  // On rescans, secondary engines are skipped by default (see RESCAN_SECONDARY_ENGINES).
  const useSecondary = !rescan || RESCAN_SECONDARY_ENGINES;

  const tasks = [
    ...acrSlices.map(s => identifyACR(s, filename, mimetype)),
    ...(useSecondary ? [identifyAudd(bestSlice, filename), identifyShazam(bestSlice, filename)] : []),
  ];
  const results = await Promise.all(tasks);
  const valid   = results.filter(Boolean);
  console.log(`Scan engines (${acrSlices.length} ACR + AudD + Shazam = ${tasks.length} tasks${rescan ? " · rescan" : ""}):`, results.map((r,i) => {
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

// ── Email design system ───────────────────────────────────────
// Built to survive Gmail/Outlook (which strip SVG, web fonts, and <style>):
// table layout, inline styles, HTML "bar" logo instead of SVG, gradients with
// solid bgcolor fallbacks. Mirrors the site: black canvas, brand red, silver logo.
const EM = {
  bg:"#07080d", card:"#0f1015", card2:"#15161d",
  border:"rgba(255,255,255,0.08)", border2:"rgba(255,255,255,0.12)",
  text:"#ffffff", text2:"rgba(255,255,255,0.72)", text3:"rgba(255,255,255,0.46)",
  red:"#ff4d6d", green:"#34e89e",
  font:"-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
};
function emailLogoBars() {
  // 5 waveform bars, bottom-aligned, silver gradient L→R — matches the app logo
  const bars=[[14,"#ffffff"],[20,"#ffffff"],[26,"#eef0ff"],[21,"#dfe3f2"],[13,"#b8bdd6"]];
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="display:inline-block;vertical-align:middle;"><tr>${bars.map(b=>`<td valign="bottom" style="padding-right:3px;"><div style="width:5px;height:${b[0]}px;background:${b[1]};border-radius:3px;font-size:0;line-height:0;">&nbsp;</div></td>`).join("")}</tr></table>`;
}
function emailButton(href,label,accent){
  const bg=accent?EM.red:"#ffffff";
  const grad=accent?"linear-gradient(135deg,#ff5d7a 0%,#ff3b5e 100%)":"#ffffff";
  const color=accent?"#ffffff":"#0a0a12";
  return `<table cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" bgcolor="${bg}" style="border-radius:11px;background:${grad};"><a href="${href}" style="display:inline-block;padding:14px 30px;font-family:${EM.font};font-size:14px;font-weight:700;color:${color};text-decoration:none;letter-spacing:.02em;border-radius:11px;">${label}</a></td></tr></table>`;
}
function emailEyebrow(text){ return `<div style="font-size:11px;font-weight:700;color:${EM.red};letter-spacing:.16em;text-transform:uppercase;margin-bottom:13px;font-family:${EM.font};">${text}</div>`; }
function emailH1(text){ return `<div style="font-size:26px;font-weight:800;color:${EM.text};letter-spacing:-.5px;line-height:1.2;margin-bottom:14px;font-family:${EM.font};">${text}</div>`; }

function baseEmail(content) {
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
  <title>TrackMyPlacements</title>
</head>
<body style="margin:0;padding:0;background:${EM.bg};-webkit-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${EM.bg};padding:34px 16px 46px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:540px;">

      <!-- Card -->
      <tr><td style="background:${EM.card};border:1px solid ${EM.border};border-radius:20px;overflow:hidden;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">

          <!-- Brand accent strip -->
          <tr><td height="4" bgcolor="${EM.red}" style="height:4px;font-size:0;line-height:0;background:linear-gradient(90deg,#ff4d6d 0%,#ff8a9b 50%,#ff4d6d 100%);">&nbsp;</td></tr>

          <!-- Header -->
          <tr><td style="padding:26px 32px 22px;border-bottom:1px solid ${EM.border2};">
            <table cellpadding="0" cellspacing="0" role="presentation"><tr>
              <td style="vertical-align:middle;padding-right:11px;">${emailLogoBars()}</td>
              <td style="vertical-align:middle;"><span style="font-family:${EM.font};font-size:16px;font-weight:700;color:${EM.text};letter-spacing:-.3px;">TrackMy<span style="color:${EM.red};">Placements</span></span></td>
            </tr></table>
          </td></tr>

          <!-- Content -->
          <tr><td style="padding:30px 32px 34px;font-family:${EM.font};">${content}</td></tr>

        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:22px 6px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>
          <td style="font-family:${EM.font};font-size:11px;color:${EM.text3};line-height:1.7;">
            <a href="${APP_URL}" style="color:rgba(255,255,255,0.6);text-decoration:none;font-weight:600;">trackmyplacements.com</a>
            <span style="color:rgba(255,255,255,0.25);margin:0 8px;">·</span>
            <span style="color:rgba(255,255,255,0.4);">Placement Location Engine</span>
          </td>
        </tr></table>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function placementEmailHtml(filename, title, artist, spotifyId, youtubeId) {
  const safeFilename = escapeHtml(filename);
  const safeTitle    = escapeHtml(title);
  const safeArtist   = escapeHtml(artist);
  const link = spotifyId ? `https://open.spotify.com/track/${spotifyId}` : youtubeId ? `https://youtube.com/watch?v=${youtubeId}` : null;
  const platformLabel = spotifyId ? "Listen on Spotify ↗" : youtubeId ? "Watch on YouTube ↗" : null;
  return baseEmail(`
    ${emailEyebrow("● Placement detected")}
    ${emailH1("Your beat just landed.")}
    <p style="font-size:14.5px;color:${EM.text2};line-height:1.7;margin:0 0 22px;font-family:${EM.font};">We matched one of your beats to a track that just surfaced on a major platform.</p>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${EM.card2};border:1px solid ${EM.border2};border-radius:14px;margin-bottom:22px;">
      <tr><td style="padding:20px 22px;">
        <div style="font-size:10px;font-weight:700;color:${EM.red};letter-spacing:.14em;text-transform:uppercase;margin-bottom:9px;font-family:${EM.font};">Recognized as</div>
        <div style="font-size:21px;font-weight:800;color:${EM.text};letter-spacing:-.4px;line-height:1.25;margin-bottom:5px;font-family:${EM.font};">${safeTitle}</div>
        <div style="font-size:13px;color:${EM.text2};font-family:${EM.font};">${safeArtist || "Unknown artist"}</div>
      </td></tr>
    </table>

    <div style="font-size:10px;font-weight:700;color:${EM.text3};text-transform:uppercase;letter-spacing:.14em;margin-bottom:6px;font-family:${EM.font};">Your beat</div>
    <div style="font-size:14px;font-weight:600;color:${EM.text};margin-bottom:26px;line-height:1.4;font-family:${EM.font};">${safeFilename}</div>

    ${link ? emailButton(link, platformLabel, true) : ""}

    <p style="margin:24px 0 0;font-size:12.5px;color:${EM.text3};line-height:1.7;font-family:${EM.font};">Open your dashboard to verify this placement and add it to your catalog.</p>
  `);
}

function trialEndingEmailHtml(username, tierLabel, price, endsWhen) {
  const safeUsername = escapeHtml(username);
  return baseEmail(`
    ${emailEyebrow("● Trial ending soon")}
    ${emailH1("Your trial is almost up.")}
    <p style="font-size:14.5px;color:${EM.text2};line-height:1.7;margin:0 0 22px;font-family:${EM.font};">Hey @${safeUsername} — a heads up that your free trial ends ${endsWhen}. After that your ${tierLabel} plan begins and your card is charged <span style="color:${EM.text};font-weight:600;">${price}/month</span>, then monthly until you cancel.</p>
    <p style="font-size:14.5px;color:${EM.text2};line-height:1.7;margin:0 0 26px;font-family:${EM.font};">Want to keep monitoring? You don't need to do anything. Not ready? You can cancel anytime from your account before the trial ends and you won't be charged.</p>
    ${emailButton(APP_URL, "Open your dashboard ↗", true)}
    <p style="margin:24px 0 0;font-size:12.5px;color:${EM.text3};line-height:1.6;font-family:${EM.font};">Manage or cancel your plan anytime under Account. All payments are final and non-refundable.</p>
  `);
}

function passwordResetEmailHtml(resetUrl) {
  return baseEmail(`
    ${emailEyebrow("Account security")}
    ${emailH1("Reset your password")}
    <p style="font-size:14.5px;color:${EM.text2};line-height:1.7;margin:0 0 26px;font-family:${EM.font};">Tap below to set a new password. This link expires in <span style="color:${EM.text};font-weight:600;">1 hour</span>.</p>
    ${emailButton(resetUrl, "Set new password ↗", true)}
    <p style="margin:24px 0 0;font-size:12.5px;color:${EM.text3};line-height:1.6;font-family:${EM.font};">Didn't request this? Ignore this email — your account is unchanged.</p>
  `);
}

function welcomeEmailHtml(username) {
  const safeUsername = escapeHtml(username);
  const features = [
    ["Fingerprint registered","A permanent, content-based ID assigned the moment you upload."],
    ["Instant scan","Checked immediately across Spotify, Apple Music, YouTube, TikTok & more."],
    ["Rescans every 3 days","We re-run your library every 3 days and email you the moment a placement surfaces."],
    ["Verified catalog","Confirmed placements get logged and shared — your track record, backed by data."],
  ];
  return baseEmail(`
    ${emailEyebrow("Welcome")}
    ${emailH1(`You're in, @${safeUsername}.`)}
    <p style="font-size:14.5px;color:${EM.text2};line-height:1.75;margin:0 0 26px;font-family:${EM.font};">Your beats don't have an identifier on the internet yet — that's why placements slip by. Upload one and we fingerprint it, scan every major platform instantly, and email you the moment it surfaces.</p>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px;">
      ${features.map(function(f,i){var pb=i<features.length-1?'16':'0';return `
      <tr>
        <td valign="top" style="width:20px;padding:0 0 ${pb}px;font-family:${EM.font};">
          <div style="width:18px;height:18px;border-radius:50%;background:rgba(255,77,109,0.14);border:1px solid rgba(255,77,109,0.4);text-align:center;line-height:17px;color:${EM.red};font-size:11px;font-weight:800;">&#10003;</div>
        </td>
        <td valign="top" style="padding:0 0 ${pb}px 12px;font-family:${EM.font};">
          <div style="font-size:13.5px;font-weight:700;color:${EM.text};margin-bottom:3px;">${f[0]}</div>
          <div style="font-size:12.5px;color:${EM.text2};line-height:1.6;">${f[1]}</div>
        </td>
      </tr>`;}).join("")}
    </table>

    ${emailButton(APP_URL, "Scan your first beat ↗", true)}
  `);
}

// ── Subscription status ───────────────────────────────────────
async function getSubscriptionStatus(user_id) {
  const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
  const profile  = profiles?.[0];
  if (!profile) return { hasAccess:false, trialActive:false, subscriptionActive:false, daysLeft:0, canCancel:false, submissionsUsed:0, submissionLimit:25, emailMonitorsUsed:0, emailMonitorLimit:0 };

  // Admin account — unlimited everything, flagged for the gold ADMIN pill.
  // canCancel is always true here: the "Cancel subscription" control must be
  // visible on every account type, no exceptions. /cancel itself handles the
  // "nothing is actually billed" case gracefully instead of hiding the button.
  if (profile.username && profile.username.toLowerCase()==="trackmyplacements") {
    return {
      hasAccess: true, admin: true, trialActive: false, subscriptionActive: true, pastDue: false,
      daysLeft: 9999, trialEnd: new Date(Date.now() + 9999*24*60*60*1000).toISOString(),
      tier: "admin", tierLabel: "ADMIN", canCancel: true,
      submissionsUsed: profile.submissions_used || 0, submissionLimit: null,
      emailMonitorsUsed: profile.email_monitors_used || 0, emailMonitorLimit: null,
    };
  }

  // Comped accounts — always full Tier 2, never gated by trial/billing.
  if (profile.username && COMP_TIER2.has(profile.username.toLowerCase())) {
    const compLimits = getLimits("tier2");
    return {
      hasAccess: true, trialActive: false, subscriptionActive: true, pastDue: false,
      daysLeft: 9999, trialEnd: new Date(Date.now() + 9999*24*60*60*1000).toISOString(),
      tier: "tier2", tierLabel: compLimits.label, canCancel: true,
      submissionsUsed: profile.submissions_used || 0, submissionLimit: compLimits.submissions,
      emailMonitorsUsed: profile.email_monitors_used || 0, emailMonitorLimit: compLimits.emailMonitors,
    };
  }

  // Comped accounts — always full Tier 1, never gated by trial/billing.
  if (profile.username && COMP_TIER1.has(profile.username.toLowerCase())) {
    const compLimits = getLimits("tier1");
    return {
      hasAccess: true, trialActive: false, subscriptionActive: true, pastDue: false,
      daysLeft: 9999, trialEnd: new Date(Date.now() + 9999*24*60*60*1000).toISOString(),
      tier: "tier1", tierLabel: compLimits.label, canCancel: true,
      submissionsUsed: profile.submissions_used || 0, submissionLimit: compLimits.submissions,
      emailMonitorsUsed: profile.email_monitors_used || 0, emailMonitorLimit: compLimits.emailMonitors,
    };
  }

  // ── NEW card-required flow ──────────────────────────────────
  // Only applies to NEW signups (card_required = true). Access is driven entirely
  // by the Stripe subscription status, since a card is on file and Stripe owns the
  // trial + billing. Existing users (card_required falsy) skip this block entirely.
  if (profile.card_required) {
    const now    = new Date();
    const status = profile.subscription_status; // incomplete | trialing | active | past_due | cancelled
    const subscriptionActive = status === "active";
    const trialActive        = status === "trialing";
    const pastDue            = status === "past_due";

    // Trial end: prefer the exact Stripe trial end; fall back to trial_start + N days.
    let trialEnd = profile.trial_end_at
      ? new Date(profile.trial_end_at)
      : (profile.trial_start
          ? new Date(new Date(profile.trial_start).getTime() + CARD_REQUIRED_TRIAL_DAYS*24*60*60*1000)
          : now);
    const daysLeft = trialActive ? Math.max(0, Math.ceil((trialEnd - now)/(1000*60*60*24))) : 0;

    // Tier being trialed / subscribed to (defaults to tier1).
    const tier = (subscriptionActive || trialActive) ? (profile.tier || "tier1") : null;

    // Monthly reset for active paid tiers (same rule as the legacy path).
    let submissionsUsed = profile.submissions_used || 0;
    let emailMonitorsUsed = profile.email_monitors_used || 0;
    if (subscriptionActive && profile.submissions_reset_at) {
      const oneMonth = new Date(new Date(profile.submissions_reset_at).getTime() + 30*24*60*60*1000);
      if (now > oneMonth) {
        submissionsUsed = 0; emailMonitorsUsed = 0;
        await sbUpdate("profiles", `id=eq.${user_id}`, { submissions_used:0, email_monitors_used:0, submissions_reset_at:now.toISOString() });
      }
    }

    // During the trial, grant the chosen tier's limits unless TRIAL_USES_TIER_LIMITS=false.
    const limitTier = (trialActive && !TRIAL_USES_TIER_LIMITS) ? "trial" : (tier || "trial");
    const limits = getLimits(limitTier);
    // The "Cancel" control must always be visible, regardless of billing state —
    // /cancel handles the "nothing live to cancel" case with a clear message
    // instead of the UI hiding the option outright.
    const canCancel = true;
    return {
      hasAccess: (trialActive || subscriptionActive) && !pastDue,
      trialActive, subscriptionActive, pastDue, daysLeft, canCancel,
      trialEnd: trialEnd.toISOString(), tier, tierLabel: limits.label,
      submissionsUsed, submissionLimit: limits.submissions,
      emailMonitorsUsed, emailMonitorLimit: limits.emailMonitors,
    };
  }

  // ── LEGACY flow (existing signups) — unchanged ──────────────
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
  // The "Cancel" control must always be visible, regardless of billing state —
  // /cancel handles the "nothing live to cancel" case with a clear message
  // instead of the UI hiding the option outright.
  const canCancel = true;
  return {
    hasAccess: (trialActive || subscriptionActive) && !pastDue,
    trialActive, subscriptionActive, pastDue, daysLeft, canCancel,
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
  audd:!!process.env.AUDD_API_TOKEN,
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
    // Constrain the character set/length now — this is what's rendered raw into
    // your own admin-notification emails and (via knowledge-base placements)
    // potentially other users' emails too, so keep it to something safe and sane.
    const trimmedUsername = username.trim();
    if (!/^[a-zA-Z0-9_.]{3,24}$/.test(trimmedUsername)) {
      return res.status(400).json({ error:"Username must be 3-24 characters — letters, numbers, underscore, or period only." });
    }

    const isDev = DEV_EMAILS.includes((email||"").toLowerCase().trim());
    const ip = getIP(req);
    if (!isDev && !checkSignupRate(ip)) return res.status(429).json({ error:"Too many accounts created from this connection. Try again later." });

    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(trimmedUsername)}`);
    if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:"Username already taken." });

    // Block if this IP already has an active trial — skip for dev
    if (!isDev) {
      const ipProfiles = await sbSelect("profiles", `signup_ip=eq.${encodeURIComponent(ip)}`);
      if (Array.isArray(ipProfiles)&&ipProfiles.length>0) {
        for (const p of ipProfiles) {
          // Only legacy cardless trials (status "trial") count toward the IP block.
          // New card-required signups (status "incomplete") are gated by the card itself.
          if (p.subscription_status !== "trial") continue;
          const te = new Date((p.trial_start ? new Date(p.trial_start) : new Date(p.created_at)).getTime() + 3*24*60*60*1000);
          if (new Date() < te) return res.status(429).json({ error:"A free trial is already active from this network. Subscribe to continue." });
        }
      }
    }

    const authRes = await fetchRetry(`${SUPABASE_URL}/auth/v1/signup`, {
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
        username: trimmedUsername,
        trial_start: new Date().toISOString(),
        tier: "trial",
        submissions_used: 0,
        email_monitors_used: 0,
        submissions_reset_at: new Date().toISOString(),
        signup_ip: ip,
        // NEW card-required trial: account exists but has NO access until the user
        // completes Stripe Checkout (card on file) which starts the 7-day trial.
        card_required: true,
        subscription_status: "incomplete",
      });
      console.log("Profile insert result:", JSON.stringify(insertResult)?.slice(0,200));
    } catch(profileErr) {
      console.error("Profile insert failed:", profileErr.message);
      // Don't block signup — user can still sign in, profile will be missing but recoverable
    }

    // Send branded welcome email (non-blocking)
    if (RESEND_KEY) {
      sendEmail(email, "Welcome to TrackMyPlacements 🎵", welcomeEmailHtml(trimmedUsername)).catch(console.error);
      // Notify admin of new signup — bold, branded, high-contrast
      sendEmail("trackmyplacements@gmail.com", `New signup: @${trimmedUsername}`, baseEmail(`
        ${emailEyebrow("● New signup")}
        <div style="font-size:34px;font-weight:800;color:${EM.text};letter-spacing:-.7px;line-height:1.1;margin-bottom:22px;font-family:${EM.font};">@${escapeHtml(trimmedUsername)}</div>
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:26px;">
          <tr>
            <td style="padding:11px 0;border-bottom:1px solid ${EM.border};"><span style="font-size:11px;font-weight:600;color:${EM.text3};text-transform:uppercase;letter-spacing:.1em;font-family:${EM.font};">Email</span></td>
            <td style="padding:11px 0;border-bottom:1px solid ${EM.border};text-align:right;"><span style="font-size:13px;color:${EM.text};font-weight:500;font-family:${EM.font};">${escapeHtml(email)}</span></td>
          </tr>
          <tr>
            <td style="padding:11px 0;border-bottom:1px solid ${EM.border};"><span style="font-size:11px;font-weight:600;color:${EM.text3};text-transform:uppercase;letter-spacing:.1em;font-family:${EM.font};">Signed up</span></td>
            <td style="padding:11px 0;border-bottom:1px solid ${EM.border};text-align:right;"><span style="font-size:13px;color:${EM.text};font-weight:500;font-family:${EM.font};">${new Date().toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",timeZone:"America/New_York"})} ET</span></td>
          </tr>
          <tr>
            <td style="padding:11px 0;"><span style="font-size:11px;font-weight:600;color:${EM.text3};text-transform:uppercase;letter-spacing:.1em;font-family:${EM.font};">IP</span></td>
            <td style="padding:11px 0;text-align:right;"><span style="font-size:12px;color:${EM.text2};font-family:monospace;">${escapeHtml(ip)}</span></td>
          </tr>
        </table>
        ${emailButton(APP_URL, "View dashboard ↗", true)}
      `)).catch(console.error);
    }

    if (accessToken) return res.json({ access_token:accessToken, refresh_token:authData.refresh_token||null, user:{ id:userId, email:authData.user?.email||email, username: trimmedUsername } });

    const siRes  = await fetchRetry(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY}, body:JSON.stringify({ email, password }) });
    const siData = await siRes.json();
    if (siData.error) return res.status(400).json({ error:"Account created! Please sign in." });
    res.json({ access_token:siData.access_token, refresh_token:siData.refresh_token||null, user:{ id:siData.user?.id||userId, email:siData.user?.email||email, username: trimmedUsername } });
  } catch(e) { console.error("Signup error:",e.message); res.status(500).json({ error:e.message }); }
});

// ── Auth: sign in ─────────────────────────────────────────────
app.post("/auth/signin", async (req, res) => {
  try {
    if (!checkLoginRate(getIP(req))) return res.status(429).json({ error:"Too many sign-in attempts. Please wait a few minutes and try again." });
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:"All fields required." });
    // Case-insensitive username lookup. The frontend lowercases what the user types,
    // but profile rows (especially the branded admin account) may be stored with
    // capitals — an exact match would fail to find them and the login would bounce.
    // Done directly with fetchRetry (rather than sbSelect) so a transient network
    // failure here can be told apart from a genuine "no such username" — sbSelect
    // swallows fetch errors down to an empty array, which would otherwise show
    // "Username not found" for what's actually just a dropped connection.
    let profiles;
    try {
      const pr = await fetchRetry(`${SUPABASE_URL}/rest/v1/profiles?username=ilike.${encodeURIComponent(username)}`, {
        headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`},
      });
      profiles = await pr.json();
    } catch (e) {
      console.error("Signin profile lookup network error:", e.message);
      return res.status(503).json({ error:"Sign-in service is temporarily unavailable. Please try again in a moment." });
    }
    if (!Array.isArray(profiles)||profiles.length===0) {
      return res.status(400).json({ error:"Username not found. If you just signed up, your account may still be setting up — please wait a moment and try again." });
    }
    const profile = profiles[0];
    const userRes = await fetchRetry(`${SUPABASE_URL}/auth/v1/admin/users/${profile.id}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
    const userData = await userRes.json();
    if (!userData?.email) return res.status(400).json({ error:"Could not find account." });
    const siRes  = await fetchRetry(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY}, body:JSON.stringify({ email:userData.email, password }) });
    const siData = await siRes.json();
    if (siData.error||siData.error_description) return res.status(400).json({ error:siData.error_description||siData.error?.message||"Sign in failed." });
    const userId = siData.user?.id || profile.id;
    const userEmail = siData.user?.email || userData.email;
    res.json({ access_token:siData.access_token, refresh_token:siData.refresh_token||null, user:{ id:userId, email:userEmail, username:profile.username } });
  } catch(e) {
    console.error("Signin error:", e.message);
    const friendly = /premature close|socket hang up|aborted|ECONNRESET|ETIMEDOUT/i.test(e.message||"")
      ? "Sign-in service is temporarily unavailable. Please try again in a moment."
      : e.message;
    res.status(500).json({ error: friendly });
  }
});

// ── Auth: refresh access token ────────────────────────────────
app.post("/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error:"Missing refresh_token." });
    const r = await fetchRetry(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method:"POST", headers:{"Content-Type":"application/json","apikey":SUPABASE_KEY},
      body:JSON.stringify({ refresh_token }),
    });
    const d = await r.json();
    if (!r.ok || !d.access_token) return res.status(401).json({ error:"Could not refresh session." });
    res.json({ access_token:d.access_token, refresh_token:d.refresh_token||refresh_token });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Auth: forgot password (Resend branded) ────────────────────
app.post("/auth/forgot-password", async (req, res) => {
  try {
    if (!checkForgotRate(getIP(req))) return res.status(429).json({ error:"Too many requests. Please wait and try again." });
    const { email } = req.body;
    if (!email) return res.status(400).json({ error:"Email required." });

    // Generate a password reset link via Supabase admin API
    const linkRes = await fetchRetry(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
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
      await fetchRetry(`${SUPABASE_URL}/auth/v1/recover`, {
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
    const r = await fetchRetry(`${SUPABASE_URL}/auth/v1/user`, {
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
    if (!checkSupportRate(getIP(req))) return res.status(429).json({ error:"Too many messages. Please wait a bit before sending another." });
    const { name, email, message, username, userId } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: "Message required." });

    const senderName  = escapeHtml(name || username || "Anonymous");
    const replyEmail  = email || null;
    const safeReplyEmail = escapeHtml(replyEmail);
    const safeUserId  = escapeHtml(userId);
    const safeMessage = escapeHtml(message.trim());
    const subject     = `Support: ${senderName} — ${message.trim().slice(0, 60)}${message.trim().length > 60 ? "…" : ""}`;

    const html = `
      <div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
        <div style="background:#f4f4f5;border-radius:10px;padding:20px 24px;margin-bottom:16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:8px;">From</div>
          <div style="font-size:15px;font-weight:600;">${senderName}</div>
          ${replyEmail ? `<div style="font-size:13px;color:#555;margin-top:2px;">${safeReplyEmail}</div>` : ""}
          ${userId ? `<div style="font-size:11px;color:#aaa;margin-top:4px;">User ID: ${safeUserId}</div>` : ""}
        </div>
        <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:10px;padding:20px 24px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:10px;">Message</div>
          <div style="font-size:15px;line-height:1.75;white-space:pre-wrap;">${safeMessage}</div>
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
    if (!checkLookupRate(getIP(req))) return res.status(429).json({ error: "Too many lookups. Please wait a bit and try again." });
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
    if (!checkLookupRate(getIP(req))) return res.status(429).json({ error: "Too many lookups. Please wait a bit and try again." });
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
    if (!checkLookupRate(getIP(req))) return res.status(429).json({ error: "Too many lookups. Please wait a bit and try again." });
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
    if (!checkLookupRate(getIP(req))) return res.status(429).json({ error: "Too many lookups. Please wait a bit and try again." });
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

// ── Beat placements — one beat can have MANY confirmed song placements ──
// beats.last_result/last_artist/spotify_id/youtube_id are kept as "most recent
// placement" for backward-compat with the existing list/badge UI. beat_placements
// is the full, append-only history — this is what Library "placed" clicks read
// so a beat used in 3 songs shows all 3, not just whichever was found most recently.
//
// Required Supabase SQL (run once):
//   CREATE TABLE IF NOT EXISTS beat_placements (
//     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//     beat_id       uuid NOT NULL REFERENCES beats(id) ON DELETE CASCADE,
//     user_id       uuid NOT NULL,
//     title         text NOT NULL,
//     artist        text,
//     spotify_id    text,
//     youtube_id    text,
//     score         numeric,
//     corroborated  boolean DEFAULT false,
//     source        text DEFAULT 'auto_scan',   -- auto_scan | rescan | user_verified
//     found_at      timestamptz DEFAULT now()
//   );
//   CREATE UNIQUE INDEX IF NOT EXISTS beat_placements_beat_title
//     ON beat_placements (beat_id, lower(title));

async function getPlacements(beat_id) {
  try { return await sbSelect("beat_placements", `beat_id=eq.${beat_id}&order=found_at.asc`) || []; }
  catch(e) { console.error("getPlacements error:", e.message); return []; }
}

// Adds a placement row for this beat if the title isn't already recorded for it.
// Returns the inserted row if it was new, or null if it was a dup / failed.
async function addPlacementIfNew(beat_id, user_id, match, source) {
  const title = match?.title; if (!beat_id || !title) return null;
  const key = normaliseTitle(title); if (!key) return null;
  try {
    const existing = await getPlacements(beat_id);
    if (existing.some(p => normaliseTitle(p.title) === key)) return null; // already known for this beat
    const row = {
      beat_id, user_id,
      title,
      artist:       match.artists?.[0]?.name || null,
      spotify_id:   match.external_metadata?.spotify?.track?.id || null,
      youtube_id:   match.external_metadata?.youtube?.vid || null,
      score:        match.score || null,
      corroborated: !!match._corroborated,
      source:       source || "auto_scan",
    };
    const r = await sbInsert("beat_placements", row);
    const inserted = Array.isArray(r) ? r[0] : r;
    if (inserted) console.log(`Placement recorded: beat=${beat_id} → "${title}" (${source})`);
    return inserted;
  } catch(e) { console.error("addPlacementIfNew error:", e.message); return null; }
}


// When a scan finds NO match but the producer knows where the beat is
// placed, they paste a platform link in the UI. The frontend verifies
// it via the appropriate lookup endpoint, then calls this to PERSIST it
// onto the beat record — flipping status to "placed" and storing the DSP
// data so it becomes a real, durable placement (visible in Library, survives reload).
app.post("/verify-placement", async (req, res) => {
  try {
    const { user_id, fingerprint_id, beat_id, spotify_id, youtube_id, platform, track_url, title, artist } = req.body;
    if (!user_id || (!fingerprint_id && !beat_id)) return res.status(400).json({ error: "Missing user_id and a beat reference (fingerprint_id or beat_id)." });
    { const me = await authOr401(req, res); if (!me) return; if (me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); }
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
    // Note: track_url is stored in fingerprint_knowledge only, not in beats table

    const updated = await sbUpdate("beats", `id=eq.${beat.id}`, updatePayload);
    console.log("Manual placement verified:", beat.id, "→", title, platform || "spotify", spotify_id || youtube_id || track_url || "(no id)");

    // Record this as one entry in the beat's full placement history (not a
    // single-slot overwrite) — a beat can have more than one confirmed song.
    await addPlacementIfNew(beat.id, user_id, {
      title, artists: artist ? [{ name: artist }] : [],
      score: 100,
      external_metadata: {
        ...(spotify_id ? { spotify: { track: { id: spotify_id } } } : {}),
        ...(youtube_id ? { youtube: { vid: youtube_id } } : {}),
      },
      _corroborated: true,
    }, "user_verified");

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

// ── Remove a verified placement (hard delete — make it STAY gone) ──
// The Verified tab re-hydrates from the server's "placed" beats on every load,
// so a removal that only touches localStorage reappears on refresh. The only
// thing that reliably sticks is removing the underlying beat record. This uses
// the exact same delete path as the Library "remove" (which works), plus it
// deletes this user's knowledge rows so a future scan can't re-inject it.
app.post("/remove-placement", async (req, res) => {
  try {
    const { user_id, beat_id, fingerprint_id, title } = req.body;
    if (!user_id || (!beat_id && !fingerprint_id && !title)) {
      return res.status(400).json({ error: "Missing user_id and a beat reference (beat_id, fingerprint_id, or title)." });
    }
    { const me = await authOr401(req, res); if (!me) return; if (me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); }

    // Locate the beat(s) for THIS user — by id, else fingerprint, else title.
    let beats = [];
    if (beat_id) {
      beats = await sbSelect("beats", `id=eq.${beat_id}&user_id=eq.${user_id}`);
    } else if (fingerprint_id) {
      beats = await sbSelect("beats", `user_id=eq.${user_id}&fingerprint_id=eq.${encodeURIComponent(fingerprint_id)}`);
    } else if (title) {
      beats = await sbSelect("beats", `user_id=eq.${user_id}&last_result=eq.${encodeURIComponent(title)}`);
    }
    if (!Array.isArray(beats) || beats.length === 0) {
      // Nothing server-side (e.g. an in-session item that never persisted) —
      // report success so the UI can clear it without erroring.
      return res.json({ success: true, removed: 0 });
    }

    let removed = 0;
    for (const beat of beats) {
      // 1. Delete the stored audio (best-effort).
      if (beat.storage_path) { try { await storageDelete(beat.storage_path); } catch(e) {} }
      // 2. Delete this user's knowledge rows for this fingerprint so a re-scan
      //    can't auto-re-inject the placement. Other users' rows are untouched.
      const fp = beat.fingerprint_id || fingerprint_id;
      if (fp) { try { await sbDelete("fingerprint_knowledge", `fingerprint_id=eq.${encodeURIComponent(fp)}&verified_by=eq.${user_id}`); } catch(e) {} }
      // 3. Delete this beat's full placement history.
      try { await sbDelete("beat_placements", `beat_id=eq.${beat.id}`); } catch(e) {}
      // 4. Delete the beat row itself — this is what makes it stay gone.
      const ok = await sbDelete("beats", `id=eq.${beat.id}&user_id=eq.${user_id}`);
      if (ok) removed++;
    }
    console.log(`Placement removed (hard delete): user=${user_id} beats=${removed} (${beat_id || fingerprint_id || title})`);
    res.json({ success: true, removed });
  } catch (e) { console.error("remove-placement error:", e.message); res.status(500).json({ error: e.message }); }
});

// ── Full placement history for a beat ───────────────────────────
// A beat can have more than one confirmed song — this returns all of them,
// oldest first, so the Library "placed" view can show every match instead
// of just the most recent one.
app.get("/placements/:beat_id", async (req, res) => {
  try {
    const me = await authOr401(req, res); if (!me) return;
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    const beat  = beats?.[0];
    if (!beat) return res.status(404).json({ error: "Beat not found." });
    if (beat.user_id !== me.id) return res.status(403).json({ error: "Not your beat." });
    const placements = await getPlacements(beat.id);
    res.json({ placements });
  } catch (e) { console.error("placements fetch error:", e.message); res.status(500).json({ error: e.message }); }
});

// ── Scan debug — tests every DB + storage operation ──────────
// Hit GET /scan-debug?user_id=YOUR_USER_ID to see exactly what's failing
app.get("/scan-debug", async (req, res) => {
  const secret = process.env.ADMIN_SECRET || RESCAN_SECRET;
  if ((req.headers["x-admin-secret"] || "") !== secret) return res.status(403).json({ error:"Forbidden" });
  const { user_id } = req.query;
  const results = {};
  try {
    // 1. Can we read profiles?
    try {
      const p = user_id ? await sbSelect("profiles", `id=eq.${user_id}`) : await sbSelect("profiles", "limit=1");
      results.profiles_read = Array.isArray(p) ? `OK (${p.length} rows)` : `unexpected: ${JSON.stringify(p)}`;
    } catch(e) { results.profiles_read = `ERROR: ${e.message}`; }

    // 2. Can we read beats?
    try {
      const b = user_id ? await sbSelect("beats", `user_id=eq.${user_id}&limit=3`) : await sbSelect("beats", "limit=1");
      results.beats_read = Array.isArray(b) ? `OK (${b.length} rows)` : `unexpected: ${JSON.stringify(b)}`;
    } catch(e) { results.beats_read = `ERROR: ${e.message}`; }

    // 3. Can we insert a beat? (test row, deleted immediately)
    if (user_id) {
      try {
        const testRow = {
          user_id,
          filename: "__debug_test__.mp3",
          storage_path: null,
          status: "monitoring",
          last_scanned: new Date().toISOString(),
          uploaded_at: new Date().toISOString(),
          fingerprint_id: "DEBUG-TEST-" + Date.now(),
          audio_hash: "DEBUG-TEST-" + Date.now(),
        };
        // Call Supabase directly so we can capture the raw error response
        const r = await fetch(`${SUPABASE_URL}/rest/v1/beats`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE,
            "Authorization": `Bearer ${SUPABASE_SERVICE}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify(testRow),
        });
        const text = await r.text();
        if (!r.ok) {
          results.beats_insert = `FAILED HTTP ${r.status}: ${text.slice(0, 500)}`;
        } else {
          let parsed;
          try { parsed = JSON.parse(text); } catch(e) { parsed = text; }
          const id = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
          if (id) {
            results.beats_insert = `OK — id=${id}`;
            await sbDelete("beats", `id=eq.${id}`);
            results.beats_delete = "OK";
          } else {
            results.beats_insert = `No id returned: ${text.slice(0, 200)}`;
          }
        }
      } catch(e) { results.beats_insert = `ERROR: ${e.message}`; }
    } else {
      results.beats_insert = "SKIPPED — pass ?user_id=xxx to test";
    }

    // 4. Can we read fingerprint_knowledge?
    try {
      const k = await sbSelect("fingerprint_knowledge", "limit=1");
      results.knowledge_read = Array.isArray(k) ? `OK (${k.length} rows)` : `unexpected: ${JSON.stringify(k)}`;
    } catch(e) { results.knowledge_read = `ERROR: ${e.message}`; }

    // 5. Supabase keys set?
    results.supabase_url    = SUPABASE_URL ? "SET" : "MISSING";
    results.supabase_key    = SUPABASE_KEY ? "SET" : "MISSING";
    results.supabase_service = SUPABASE_SERVICE ? "SET" : "MISSING";

    res.json({ ok: true, results });
  } catch(e) {
    res.json({ ok: false, error: e.message, results });
  }
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
    let { user_id } = req.body;
    { const me = await authOr401(req, res); if (!me) return; if (user_id && me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); user_id = user_id || me.id; }
    let beatSaved = false, savedBeatId = null;

    // ── Step 1: Hash the file immediately — this is the universal beat identity ──
    const audioHash     = computeAudioHash(req.file.buffer);
    const fingerprintId = audioHash;

    // Normalize MIME type — iOS reports .m4a files as video/mp4
    const normalizedMime = req.file.mimetype === "video/mp4" ? "audio/mp4" : req.file.mimetype;
    req.file.mimetype = normalizedMime;

    // ── Transcode lossless uploads → MP3 (after hashing, before any storage) ──
    // Fingerprint identity above is already locked to the original bytes. From
    // here down — knowledge-base path AND main path — we work with the MP3 so
    // nothing oversized ever reaches Supabase. On failure we keep the original.
    if (isLossless(req.file.originalname, normalizedMime)) {
      const beforeKB = (req.file.size / 1024).toFixed(0);
      try {
        const mp3 = await transcodeToMp3(req.file.buffer);
        req.file.buffer       = mp3;
        req.file.size         = mp3.length;
        req.file.mimetype     = "audio/mpeg";
        req.file.originalname = req.file.originalname.replace(LOSSLESS_EXT, "") + ".mp3";
        console.log(`TRANSCODE OK — ${beforeKB}KB → ${(mp3.length/1024).toFixed(0)}KB (${MP3_BITRATE} mp3) "${req.file.originalname}"`);
      } catch (txErr) {
        console.error("TRANSCODE FAILED (non-fatal — storing original):", txErr.message);
      }
    }

    console.log(`SCAN START — user=${user_id} file="${req.file.originalname}" size=${req.file.size} mime=${req.file.mimetype} fp=${fingerprintId}`);

    // ── Access gate — runs BEFORE the knowledge-base lookup ─────────────────────
    // The knowledge-base branch below can register beats + increment usage, so the
    // access check has to happen first. Otherwise a lapsed/cancelled/over-limit
    // account could keep registering known-fingerprint beats for free via the KB
    // path (which used to sit ahead of the step-3 access check). Computed once here
    // and reused in step 3 so we don't double-fetch the subscription.
    let subStatus = null;
    if (user_id && SUPABASE_URL) {
      subStatus = await getSubscriptionStatus(user_id);
      if (!subStatus.hasAccess) {
        console.log(`SCAN PATH: no access (pre-KB) user=${user_id}`);
        return res.status(403).json({ error: subStatus.pastDue ? "Your payment is past due. Please update billing to continue scanning." : "Your free trial has ended. Subscribe to continue scanning." });
      }
    }

    // ── Step 2: Knowledge base lookup — runs for EVERY scan, EVERY user ──────────
    // This is the core of the learning system. Checks the permanent
    // fingerprint_knowledge table before doing anything else — no ACR call,
    // no duplicate check, no library lookup needed if we already know the answer.
    const knownPlacement = await knowledgeGet(fingerprintId);
    if (knownPlacement) {
      console.log(`SCAN PATH: knowledge base hit — fp=${fingerprintId} title="${knownPlacement.title}"`);

      if (user_id && SUPABASE_URL) {
        try {
          const knownAsMatch = {
            title: knownPlacement.title,
            artists: knownPlacement.artist ? [{ name: knownPlacement.artist }] : [],
            score: 100,
            external_metadata: {
              ...(knownPlacement.spotify_id ? { spotify: { track: { id: knownPlacement.spotify_id } } } : {}),
              ...(knownPlacement.youtube_id ? { youtube: { vid: knownPlacement.youtube_id } } : {}),
            },
            _corroborated: true,
          };
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
            addPlacementIfNew(userExisting[0].id, user_id, knownAsMatch, "auto_scan").catch(e => console.error("addPlacementIfNew (KB existing) error:", e.message));
          } else {
            // New user scanning this beat — register it for them immediately as placed.
            // Respect the submission cap for NEW registrations (re-tests of a beat the
            // user already owns fall in the if-branch above and are intentionally uncapped).
            if (subStatus && subStatus.submissionLimit !== null && subStatus.submissionsUsed >= subStatus.submissionLimit) {
              console.log(`SCAN PATH: KB hit but submission cap reached — returning result without registering. user=${user_id}`);
            } else {
              const storagePath = `${user_id}/${req.file.originalname}`;
              await storageUpload(storagePath, req.file.buffer, req.file.mimetype);
              const kbInsert = await sbInsert("beats", {
                user_id,
                filename:       req.file.originalname,
                storage_path:   storagePath,
                status:         "placed",
                last_scanned:   new Date().toISOString(),
                last_result:    knownPlacement.title,
                last_artist:    knownPlacement.artist    || null,
                spotify_id:     knownPlacement.spotify_id || null,
                youtube_id:     knownPlacement.youtube_id || null,
                uploaded_at:    new Date().toISOString(),
                fingerprint_id: fingerprintId,
                audio_hash:     audioHash,
              });
              const kbBeat = Array.isArray(kbInsert) ? kbInsert[0] : kbInsert;
              if (kbBeat?.id) addPlacementIfNew(kbBeat.id, user_id, knownAsMatch, "auto_scan").catch(e => console.error("addPlacementIfNew (KB new) error:", e.message));
              // Only increment submission count for brand-new registrations
              const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
              const profile   = profiles?.[0];
              if (profile) await sbUpdate("profiles", `id=eq.${user_id}`, { submissions_used: (profile.submissions_used || 0) + 1 });
            }
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
      console.log(`SCAN PATH: step3 access check — user=${user_id}`);
      const status = subStatus || await getSubscriptionStatus(user_id);
      if (!status.hasAccess) { console.log(`SCAN PATH: no access`); return res.status(403).json({ error: status.pastDue ? "Your payment is past due. Please update billing to continue scanning." : "Your free trial has ended. Subscribe to continue scanning." }); }
      if (status.submissionLimit!==null && status.submissionsUsed>=status.submissionLimit) { console.log(`SCAN PATH: limit reached`); return res.status(403).json({ error:`Submission limit reached (${status.submissionsUsed}/${status.submissionLimit}). Upgrade to scan more beats.` }); }

      const DAILY_CAP = 50;
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayBeats = await sbSelect("beats", `user_id=eq.${user_id}&created_at=gte.${todayStart.toISOString()}`);
      if (Array.isArray(todayBeats) && todayBeats.length >= DAILY_CAP) {
        return res.status(429).json({ error:`Daily limit of ${DAILY_CAP} uploads reached. Come back tomorrow.` });
      }

      const existing = await sbSelect("beats", `user_id=eq.${user_id}&fingerprint_id=eq.${encodeURIComponent(fingerprintId)}`);
      if (Array.isArray(existing) && existing.length > 0) {
        console.log(`SCAN PATH: re-test — beat already exists id=${existing[0].id} status=${existing[0].status}`);
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

    // Fan out across all engines
    console.log(`SCAN PATH: new beat — running ACR scan for user=${user_id} file="${req.file.originalname}"`);
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

        // ── Beat DB insert — must always persist ──────────
        // Split into CORE fields (must exist) and ENRICHMENT (bpm/key/duration —
        // optional columns that may not exist in every schema). If the full insert
        // fails (e.g. a missing optional column), we retry with core fields only so
        // the beat ALWAYS lands in the library. A refresh must never lose a beat.
        let insertedBeat = null, saveError = null;
        const coreRow = {
          user_id,
          filename:       req.file.originalname,
          storage_path:   uploadedPath,
          status:         "monitoring",
          last_scanned:   new Date().toISOString(),
          last_result:    title,
          last_artist:    artist || null,
          spotify_id:     spotifyId || null,
          youtube_id:     youtubeId || null,
          uploaded_at:    new Date().toISOString(),
          fingerprint_id: fingerprintId,
          audio_hash:     audioHash,
        };
        const enrichment = { bpm: bpm || null, audio_key: audioKey || null, duration_ms: durationMs || null };
        try {
          console.log(`SCAN INSERT: attempting beats insert for user=${user_id} file="${req.file.originalname}"`);
          const insertResult = await sbInsert("beats", { ...coreRow, ...enrichment });
          insertedBeat = Array.isArray(insertResult) ? insertResult[0] : insertResult;
        } catch(insertErr) {
          console.error("Beat insert (with enrichment) failed — retrying core-only:", insertErr.message);
          try {
            const insertResult = await sbInsert("beats", coreRow);
            insertedBeat = Array.isArray(insertResult) ? insertResult[0] : insertResult;
            // Patch enrichment separately; never let it fail the save.
            if (insertedBeat?.id) { try { await sbUpdate("beats", `id=eq.${insertedBeat.id}`, enrichment); } catch(_) {} }
          } catch(retryErr) {
            saveError = retryErr.message;
            console.error("CRITICAL: Beat DB insert FAILED after retry:", retryErr.message, "user=", user_id, "file=", req.file.originalname);
          }
        }
        if (insertedBeat?.id) { beatSaved = true; savedBeatId = insertedBeat.id; console.log(`Beat saved to DB: ${insertedBeat.id} — "${req.file.originalname}" user=${user_id}`); }

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

        // Record EVERY confident match from this scan as its own placement, not
        // just the top-ranked one — a single beat can genuinely appear in more
        // than one released song, and mergeAllResults() already ranks all of
        // them from the slices/engines we already paid for in this same scan.
        // This costs nothing extra: goodMusic was computed above from data we
        // already have, we're just no longer throwing away everything past [0].
        if (insertedBeat?.id && goodMusic.length > 0) {
          for (const m of goodMusic) {
            addPlacementIfNew(insertedBeat.id, user_id, m, "auto_scan").catch(e => console.error("addPlacementIfNew (scan) error:", e.message));
          }
        }
      } catch(dbErr) { console.error("Post-scan DB error (non-fatal):", dbErr.message); }
    }

    // Return ACR data with fingerprint ID + whether the beat persisted to the library
    res.json({ ...acrData, fingerprint_id: fingerprintId, bpm, audio_key: audioKey, saved: beatSaved, beat_id: savedBeatId });
  } catch(err) { console.error("Scan error:",err.message); res.status(500).json({ error:"Scan failed: "+err.message }); }
});

// ── Stream audio ──────────────────────────────────────────────
app.get("/audio/:beat_id", async (req, res) => {
  try {
    const me = await authOr401(req, res); if (!me) return;
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    if (!Array.isArray(beats)||!beats[0]?.storage_path) return res.status(404).json({ error:"Beat not found." });
    if (beats[0].user_id !== me.id) return res.status(403).json({ error:"Not your beat." });
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/beats/${beats[0].storage_path}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
    if (!r.ok) return res.status(404).json({ error:"Audio not found." });
    res.setHeader("Content-Type", r.headers.get("content-type")||"audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    r.body.pipe(res);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Get beats ─────────────────────────────────────────────────
app.get("/beats/:user_id", async (req, res) => {
  try {
    const me = await authOr401(req, res); if (!me) return;
    if (me.id !== req.params.user_id) return res.status(403).json({ error:"Forbidden." });
    const beats = await sbSelect("beats", `user_id=eq.${req.params.user_id}&order=uploaded_at.desc`); res.json(Array.isArray(beats)?beats:[]);
  }
  catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Delete beat ───────────────────────────────────────────────
app.delete("/beats/:beat_id", async (req, res) => {
  try {
    const me = await authOr401(req, res); if (!me) return;
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    if (!Array.isArray(beats)||beats.length===0) return res.status(404).json({ error:"Beat not found." });
    if (beats[0].user_id !== me.id) return res.status(403).json({ error:"Not your beat." });
    if (beats[0].storage_path) await storageDelete(beats[0].storage_path);
    // Clean up this user's knowledge-base rows for this fingerprint too — otherwise
    // deleting a beat and re-uploading the same file can auto-reappear as "placed"
    // via the knowledge-base hit path, which is surprising after an explicit delete.
    // (beat_placements rows cascade-delete via the FK once the beat row is gone.)
    if (beats[0].fingerprint_id) {
      try { await sbDelete("fingerprint_knowledge", `fingerprint_id=eq.${encodeURIComponent(beats[0].fingerprint_id)}&verified_by=eq.${me.id}`); } catch(e) {}
    }
    res.json({ success: await sbDelete("beats", `id=eq.${req.params.beat_id}&user_id=eq.${me.id}`) });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Get beat fingerprint ──────────────────────────────────────
app.get("/beats/:beat_id/fingerprint", async (req, res) => {
  try {
    const me = await authOr401(req, res); if (!me) return;
    const beats = await sbSelect("beats", `id=eq.${req.params.beat_id}`);
    const beat  = beats?.[0];
    if (!beat) return res.status(404).json({ error:"Beat not found." });
    if (beat.user_id !== me.id) return res.status(403).json({ error:"Not your beat." });
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
    { const me = await authOr401(req, res); if (!me) return; if (me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); }
    if (!STRIPE_KEY) return res.status(500).json({ error:"Stripe not configured." });
    const priceId = tier==="tier2" ? STRIPE_PRICE_T2 : STRIPE_PRICE_T1;
    console.log("Price ID:", priceId, "T1:", STRIPE_PRICE_T1, "T2:", STRIPE_PRICE_T2);
    if (!priceId) return res.status(500).json({ error:"Price ID not configured. Check STRIPE_PRICE_ID env var." });

    const uRes  = await fetchRetry(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`} });
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
    const checkoutBody = {
      customer:customerId, mode:"subscription",
      allow_promotion_codes:"true",
      "line_items[0][price]":priceId, "line_items[0][quantity]":"1",
      "metadata[user_id]":user_id, "metadata[tier]":tier||"tier1",
      "subscription_data[metadata][user_id]":user_id, "subscription_data[metadata][tier]":tier||"tier1",
      success_url:`${APP_URL}?subscribed=true`, cancel_url:`${APP_URL}?cancelled=true`,
    };
    // Card-required 7-day trial — NEW signups only. Forces a card on file at checkout
    // (payment_method_collection=always), runs a free trial, then auto-bills the chosen
    // tier. If somehow no card ends up on file, the trial cancels instead of billing.
    // EXISTING users (card_required falsy) get the original immediate-bill checkout.
    if (profile?.card_required) {
      checkoutBody["subscription_data[trial_period_days]"]   = String(CARD_REQUIRED_TRIAL_DAYS);
      checkoutBody["payment_method_collection"]              = "always";
      checkoutBody["subscription_data[trial_settings][end_behavior][missing_payment_method]"] = "cancel";
      // Record the tier they chose now so the trial shows the right plan before the webhook lands.
      await sbUpdate("profiles", `id=eq.${user_id}`, { tier: (tier==="tier2"||tier==="tier1") ? tier : "tier1" });
    }
    const session = await stripeRequest("/checkout/sessions","POST", checkoutBody);
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
  try {
    const me = await authOr401(req, res); if (!me) return;
    if (me.id !== req.params.user_id) return res.status(403).json({ error:"Forbidden." });
    res.json(await getSubscriptionStatus(req.params.user_id)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Cancel subscription ───────────────────────────────────────
app.post("/cancel", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error:"Missing user_id." });
    { const me = await authOr401(req, res); if (!me) return; if (me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); }
    const profiles = await sbSelect("profiles", `id=eq.${user_id}`);
    const profile  = profiles?.[0];
    if (!profile) return res.status(400).json({ error:"Account not found." });

    const uname = (profile.username || "").toLowerCase();

    // Admin account — nothing is billed, so there's nothing for Stripe to cancel.
    if (uname === "trackmyplacements") {
      return res.json({ success:true, noBilling:true, notice:"This is the admin account — there's no billing to cancel." });
    }
    // Comped accounts — free access granted manually, no live Stripe subscription exists.
    if (COMP_TIER1.has(uname) || COMP_TIER2.has(uname)) {
      return res.json({ success:true, noBilling:true, notice:"Your access is complimentary and isn't billed. Email us if you'd like it removed." });
    }
    // Cardless legacy trial — nothing on file with Stripe, so it just expires on its own.
    if (!profile.stripe_customer_id) {
      return res.json({ success:true, noBilling:true, notice:"No card is on file — your trial simply expires on its own, you won't be charged." });
    }

    // Include trialing + past_due, not just active — these all have a live, cancellable sub.
    const subs = await stripeRequest(`/subscriptions?customer=${profile.stripe_customer_id}&status=all`);
    const live = (subs.data || []).filter(s => ["trialing","active","past_due"].includes(s.status));
    if (!live.length) {
      return res.json({ success:true, noBilling:true, notice:"No active subscription found — nothing to cancel." });
    }
    // IMPORTANT: cancel EVERY live subscription on the customer, not just one.
    // A customer can end up with more than one live subscription — e.g. they
    // switched tiers via a fresh Checkout session without the old one being
    // canceled first — and previously we only canceled the first match found,
    // leaving the other(s) live and still billing even after the user saw
    // "cancelled" in the UI. Cancel all of them and only report success if
    // every one actually went through.
    const toCancel = live.filter(s => !s.cancel_at_period_end);
    const results = await Promise.all(toCancel.map(s => stripeRequest(`/subscriptions/${s.id}`, "POST", { cancel_at_period_end:"true" })));
    const failures = results.filter(r => r && r.error);
    if (failures.length) {
      console.error("Cancel failed for some subscriptions:", user_id, failures.map(f => f.error.message));
      return res.status(400).json({ error: failures[0].error.message });
    }
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Stripe webhook ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const sig=req.headers["stripe-signature"], payload=req.body.toString();
    if (!STRIPE_WEBHOOK) { console.error("Webhook rejected — STRIPE_WEBHOOK_SECRET not configured."); return res.status(503).json({ error:"Webhook verification not configured." }); }
    if (!sig) return res.status(400).json({ error:"Missing signature" });
    {
      const el=sig.split(",").reduce((a,e)=>{const p=e.split("=");a[p[0]]=p[1];return a;},{});
      const expected=crypto.createHmac("sha256",STRIPE_WEBHOOK).update(`${el.t}.${payload}`).digest("hex");
      let sigOk=false;
      try {
        const a=Buffer.from(expected,"hex"), b=Buffer.from(el.v1||"","hex");
        sigOk = a.length===b.length && crypto.timingSafeEqual(a,b);
      } catch(_) { sigOk=false; }
      if (!sigOk) { console.error("Webhook sig mismatch"); logWebhook({ type:"(rejected)", ok:false, reason:"bad-signature" }); return res.status(400).json({ error:"Invalid signature" }); }
      // Reject events whose timestamp is outside a 5-minute window — blunts replay
      // of a captured, validly-signed payload.
      const ts=parseInt(el.t,10);
      if (!ts || Math.abs(Math.floor(Date.now()/1000)-ts) > 300) { console.error("Webhook timestamp outside tolerance"); logWebhook({ type:"(rejected)", ok:false, reason:"stale" }); return res.status(400).json({ error:"Stale signature" }); }
    }
    const event=JSON.parse(payload);
    console.log("Webhook:",event.type);
    logWebhook({ type:event.type, ok:true });

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

    // Map a Stripe subscription status to our profiles.subscription_status value.
    function mapStripeStatus(s) {
      if (s === "trialing") return "trialing";
      if (s === "active")   return "active";
      if (s === "past_due") return "past_due";
      if (s === "canceled" || s === "unpaid") return "cancelled";
      if (s === "incomplete" || s === "incomplete_expired") return "incomplete";
      return null;
    }

    if (event.type==="checkout.session.completed") {
      const s = event.data.object;
      let { userId, tier } = await resolveUser(s);
      let stripeStatus = null, trialEndIso = null;
      // Fetch the subscription to read its real status (trialing vs active) + trial end.
      if (s.subscription) {
        try {
          const sub = await stripeRequest(`/subscriptions/${s.subscription}`);
          const resolved = await resolveUser(sub);
          if (resolved.userId) userId = resolved.userId;
          if (resolved.tier)   tier   = resolved.tier;
          stripeStatus = sub.status;
          trialEndIso  = sub.trial_end ? new Date(sub.trial_end*1000).toISOString() : null;
        } catch(e) { console.error("Sub fetch error:", e.message); }
      }
      if (userId) {
        // Default to "active" for legacy (no-trial) checkouts where status fetch failed.
        const mapped = mapStripeStatus(stripeStatus) || "active";
        const update = { subscription_status: mapped, tier, submissions_used:0, submissions_reset_at:new Date().toISOString(), email_monitors_used:0 };
        if (trialEndIso) { update.trial_end_at = trialEndIso; update.trial_start = new Date().toISOString(); }
        await sbUpdate("profiles",`id=eq.${userId}`, update);
        console.log("Checkout completed:",userId,"status:",mapped,"tier:",tier);
      } else { console.error("checkout.session.completed — could not resolve user. customer:", s.customer, "metadata:", JSON.stringify(s.metadata)); }
    }

    if (event.type==="customer.subscription.created"||event.type==="customer.subscription.updated") {
      const s = event.data.object;
      const { userId, tier } = await resolveUser(s);
      if (userId) {
        const trialEndIso = s.trial_end ? new Date(s.trial_end*1000).toISOString() : null;
        // Trialing — card-required trial in progress. Grant access.
        if (s.status==="trialing") {
          const u = { subscription_status:"trialing", tier };
          if (trialEndIso) u.trial_end_at = trialEndIso;
          await sbUpdate("profiles",`id=eq.${userId}`, u);
          console.log("Sub trialing:",userId,tier,"ends",trialEndIso);
        }
        // Active — trial converted or paid outright. Never mark past_due here;
        // that is handled exclusively by invoice.payment_failed.
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

    // Fires ~3 days before a card-required trial converts to a paid charge.
    // (Enable "customer.subscription.trial_will_end" on the webhook in the Stripe
    // dashboard for this to arrive.) A clear pre-charge reminder is the single
    // biggest lever against "forgot I signed up" chargebacks.
    if (event.type==="customer.subscription.trial_will_end") {
      const s = event.data.object;
      const { userId, tier } = await resolveUser(s);
      if (userId && RESEND_KEY) {
        try {
          const limits    = getLimits(tier || "tier1");
          const price     = (tier === "tier2") ? "$19.99" : "$9.99";
          const endsWhen  = s.trial_end
            ? "on " + new Date(s.trial_end*1000).toLocaleDateString("en-US",{ month:"long", day:"numeric" })
            : "in a few days";
          const ps  = await sbSelect("profiles", `id=eq.${userId}`);
          const uname = ps?.[0]?.username || "there";
          const uRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers:{ "apikey":SUPABASE_SERVICE, "Authorization":`Bearer ${SUPABASE_SERVICE}` } });
          const uData = await uRes.json();
          if (uData?.email) {
            await sendEmail(uData.email, "Your TrackMyPlacements trial ends soon", trialEndingEmailHtml(uname, limits.label, price, endsWhen));
            console.log("Trial-ending reminder sent:", userId);
          }
        } catch(e) { console.error("trial_will_end email error:", e.message); }
      }
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
    { const me = await authOr401(req, res); if (!me) return; if (me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); }
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
    { const me = await authOr401(req, res); if (!me) return; if (me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); }
    const existing = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    if (Array.isArray(existing)&&existing.length>0) return res.status(400).json({ error:"Username already taken." });
    res.json(await sbInsert("profiles", { id:user_id, username }));
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get("/profile/:user_id", async (req, res) => {
  try {
    const me = await authOr401(req, res); if (!me) return;
    if (me.id !== req.params.user_id) return res.status(403).json({ error:"Forbidden." });
    const p = await sbSelect("profiles", `id=eq.${req.params.user_id}`);
    const row = Array.isArray(p) ? (p[0] || null) : null;
    if (!row) return res.json(null);
    // Only return fields the client needs — never leak signup_ip, stripe_customer_id,
    // fingerprint_log, or other internal columns.
    res.json({
      id: row.id,
      username: row.username,
      tier: row.tier,
      subscription_status: row.subscription_status,
      submissions_used: row.submissions_used,
      email_monitors_used: row.email_monitors_used,
      producer_since: row.producer_since || null,
      created_at: row.created_at || null,
    });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post("/profile/producer-since", async (req, res) => {
  try {
    const { user_id, producer_since } = req.body;
    if (!user_id || !producer_since) return res.status(400).json({ error:"Missing fields." });
    { const me = await authOr401(req, res); if (!me) return; if (me.id !== user_id) return res.status(403).json({ error:"Forbidden." }); }
    await sbUpdate("profiles", `id=eq.${user_id}`, { producer_since: parseInt(producer_since) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: reconcile tier terms for existing subscribers ──────────────────────
// The plan limits are computed live from LIMITS[tier] on every request, so the
// ONLY way an active subscriber sees the wrong monitor/submission numbers is if
// their profile.tier drifted from what they actually pay, or a stored usage
// counter sits above the current cap (showing e.g. 120/100, a stuck/over bar).
// This walks every active/trialing profile and:
//   1. For real Stripe subscribers, re-reads their live subscription and corrects
//      profile.tier to match the price they're actually on (tier1 vs tier2).
//   2. Clamps submissions_used / email_monitors_used into the current caps.
// Comp accounts (COMP_TIER1/COMP_TIER2) and the admin account are limit-driven
// dynamically, so their tier is left untouched (counters are still clamped).
// SAFETY: dry-run by default. Add ?apply=1 to actually write. Never downgrades a
// profile that has no live Stripe subscription (e.g. a hand-comped friend).
app.post("/admin/reconcile-tiers", async (req, res) => {
  const secret = process.env.ADMIN_SECRET || RESCAN_SECRET;
  if ((req.headers["x-admin-secret"] || "") !== secret) return res.status(403).json({ error:"Forbidden" });
  const apply = req.query.apply === "1";
  const report = { dryRun: !apply, scanned: 0, tierFixed: [], clamped: [], noStripeSub: [], skippedComp: [], errors: [] };
  try {
    const profiles = await sbSelect("profiles", `subscription_status=in.(active,trialing)&limit=2000`);
    if (!Array.isArray(profiles)) return res.status(500).json({ error:"Could not read profiles." });
    for (const p of profiles) {
      report.scanned++;
      const uname  = (p.username || "").toLowerCase();
      const isAdmin = uname === "trackmyplacements";
      const isComp  = COMP_TIER1.has(uname) || COMP_TIER2.has(uname) || isAdmin;
      let correctTier = p.tier;

      // 1) Sync tier from the live Stripe subscription (paying users only).
      if (!isComp && p.stripe_customer_id && STRIPE_KEY) {
        try {
          const subs = await stripeRequest(`/subscriptions?customer=${p.stripe_customer_id}&status=all&limit=10`);
          const live = (subs.data || []).find(s => ["active","trialing","past_due"].includes(s.status));
          if (live) {
            const priceId = live.items?.data?.[0]?.price?.id || live.plan?.id;
            const stripeTier = priceId === STRIPE_PRICE_T2 ? "tier2" : "tier1";
            if (stripeTier !== p.tier) {
              correctTier = stripeTier;
              if (apply) await sbUpdate("profiles", `id=eq.${p.id}`, { tier: stripeTier });
              report.tierFixed.push({ username: p.username, from: p.tier, to: stripeTier });
            }
          } else {
            // No live subscription — leave the tier alone (likely a manual/DB comp).
            report.noStripeSub.push({ username: p.username, tier: p.tier, status: p.subscription_status });
          }
        } catch(e) { report.errors.push({ username: p.username, error: e.message }); }
      } else if (isComp) {
        report.skippedComp.push({ username: p.username });
      }

      // 2) Clamp stored usage counters into the current caps so no bar ever shows
      //    e.g. 120/100. Admin is uncapped, so skip clamping there.
      if (!isAdmin) {
        const capTier = isComp ? (COMP_TIER2.has(uname) ? "tier2" : "tier1") : (correctTier || "trial");
        const caps = getLimits(capTier);
        const updates = {};
        if (caps.submissions   != null && (p.submissions_used    || 0) > caps.submissions)   updates.submissions_used    = caps.submissions;
        if (caps.emailMonitors != null && (p.email_monitors_used || 0) > caps.emailMonitors) updates.email_monitors_used = caps.emailMonitors;
        if (Object.keys(updates).length) {
          if (apply) await sbUpdate("profiles", `id=eq.${p.id}`, updates);
          report.clamped.push({ username: p.username, tier: capTier, before: { submissions_used: p.submissions_used, email_monitors_used: p.email_monitors_used }, after: updates });
        }
      }
    }
    res.json({ ok: true, ...report });
  } catch(e) { console.error("reconcile-tiers error:", e.message); res.status(500).json({ error: e.message }); }
});

// ── Admin: hard-set a single user's tier (instant comp / fix one friend) ──────
// For when you just need to put @someone on the right plan right now without a
// deploy or a Supabase SQL trip. Grants access (subscription_status=active) for
// paid tiers and clamps their counters into the new caps. A future Stripe webhook
// for that customer can still overwrite this — for permanent free comps, prefer
// adding the username to COMP_TIER1 / COMP_TIER2.
app.post("/admin/set-tier", async (req, res) => {
  const secret = process.env.ADMIN_SECRET || RESCAN_SECRET;
  if ((req.headers["x-admin-secret"] || "") !== secret) return res.status(403).json({ error:"Forbidden" });
  try {
    const { username, tier } = req.body;
    if (!username || !["tier1","tier2","trial"].includes(tier)) {
      return res.status(400).json({ error:"Send { username, tier } where tier is tier1, tier2, or trial." });
    }
    const ps = await sbSelect("profiles", `username=eq.${encodeURIComponent(username)}`);
    const p = ps?.[0];
    if (!p) return res.status(404).json({ error:"User not found." });
    const caps = getLimits(tier);
    const updates = { tier };
    if (tier !== "trial") updates.subscription_status = "active"; // grant access immediately
    if (caps.submissions   != null && (p.submissions_used    || 0) > caps.submissions)   updates.submissions_used    = caps.submissions;
    if (caps.emailMonitors != null && (p.email_monitors_used || 0) > caps.emailMonitors) updates.email_monitors_used = caps.emailMonitors;
    await sbUpdate("profiles", `id=eq.${p.id}`, updates);
    console.log(`admin/set-tier: @${p.username} → ${tier}`);
    res.json({ ok: true, username: p.username, applied: updates, limits: caps });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: at-a-glance health (detection + billing) ───────────────────────────
// One endpoint to answer the two questions that actually matter post-launch:
// (1) is detection delivering — match rate and placed counts; (2) is billing
// healthy — active subs and whether Stripe webhooks are arriving and verifying.
// GET with header x-admin-secret.
app.get("/admin/metrics", async (req, res) => {
  const secret = process.env.ADMIN_SECRET || RESCAN_SECRET;
  if ((req.headers["x-admin-secret"] || "") !== secret) return res.status(403).json({ error:"Forbidden" });
  try {
    const [profilesTotal, beatsTotal, placed, monitoring, active, trialing, pastDue, t1, t2] = await Promise.all([
      sbCount("profiles", ""),
      sbCount("beats", ""),
      sbCount("beats", "status=eq.placed"),
      sbCount("beats", "status=eq.monitoring"),
      sbCount("profiles", "subscription_status=eq.active"),
      sbCount("profiles", "subscription_status=eq.trialing"),
      sbCount("profiles", "subscription_status=eq.past_due"),
      sbCount("profiles", "subscription_status=eq.active&tier=eq.tier1"),
      sbCount("profiles", "subscription_status=eq.active&tier=eq.tier2"),
    ]);
    const matchRatePct = (beatsTotal && placed != null) ? +(100 * placed / beatsTotal).toFixed(1) : null;
    const lastWebhook  = webhookLog.length ? webhookLog[webhookLog.length - 1] : null;
    res.json({
      generatedAt: new Date().toISOString(),
      detection: { totalBeats: beatsTotal, placed, monitoring, matchRatePct },
      billing: {
        users: profilesTotal,
        activeSubs: active, trialing, pastDue,
        byTier: { tier1: t1, tier2: t2 },
        webhooksSeen: webhookLog.length,
        lastWebhook,
        recentWebhooks: webhookLog.slice(-15).reverse(),
      },
      rescan: rescanLog,
      engines: { acrcloud: !!ACR_KEY, audd: !!AUDD_KEY, shazam: !!RAPIDAPI_KEY, resend: !!RESEND_KEY, stripeWebhook: !!STRIPE_WEBHOOK },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Rescan (every 3 days) ──────────────────────────────────────
// Hit POST /rescan with header x-rescan-secret on a cron schedule.
// For 3-day monitoring, run e.g. 0 7 */3 * * (07:00 UTC, every 3rd day).
// Cost per beat per rescan = RESCAN_ACR_SLICES ACR calls (default 1, rotating),
// ACR-only unless RESCAN_SECONDARY_ENGINES is on. Only beats uploaded within
// RETIRE_DAYS are in the pool, so daily spend stays bounded as libraries grow.
//
// "placed" beats stay in this pool too (not just "monitoring") — a beat can
// legitimately appear in more than one released song, so finding a first
// placement no longer takes it out of rotation. Cost impact: same per-beat
// ACR-only cost as any other monitored beat, still bounded by RETIRE_DAYS —
// a beat drops out of the pool 30 days after upload regardless of status,
// same as it always has.
const rescanLog = { lastRun: null, lastResult: null };

app.get("/rescan/status", (req, res) => {
  if (req.headers["x-rescan-secret"]!==RESCAN_SECRET) return res.status(401).json({ error:"Unauthorized" });
  res.json({ lastRun: rescanLog.lastRun, lastResult: rescanLog.lastResult });
});

// ── Auto-retire window ────────────────────────────────────────
// Placements almost always surface within weeks of a release, but unmatched
// beats sit in "monitoring" forever and get rescanned every single day — that
// unbounded accumulation is what turns a daily rescan into a money pit. So we
// only daily-rescan beats uploaded within the last RETIRE_DAYS. Older unmatched
// beats stop being rescanned (they keep their record; they're just no longer in
// the paid daily pool). This caps daily cost at roughly "uploads in the window".
//   30 (default) → daily pool ≈ one month of a user's uploads. Set 0 to disable
//                  (rescans the entire lifetime library — only do this with a
//                  hard per-user library cap or you WILL lose money at scale).
const RETIRE_DAYS = 30;

// Hard cap on how many beats a single rescan run will process. The loop staggers
// ~700ms/beat, so without a ceiling a large library could make one run outlast the
// gap to the next cron tick — runs would pile up and stall. Oldest-scanned beats are
// processed first (order=last_scanned.asc), so nothing starves: whatever doesn't fit
// this run is first in line next run. Raise as the library grows; at 800/run and a
// 3-day cadence that's headroom for ~8k actively-monitored beats.
const MAX_BEATS_PER_RUN = parseInt(process.env.MAX_BEATS_PER_RUN || "800", 10);

app.post("/rescan", async (req, res) => {
  if (req.headers["x-rescan-secret"]!==RESCAN_SECRET) return res.status(401).json({ error:"Unauthorized" });
  try {
    let beatQuery = "status=in.(monitoring,placed)&order=last_scanned.asc";
    if (RETIRE_DAYS > 0) {
      const cutoff = new Date(Date.now() - RETIRE_DAYS*24*60*60*1000).toISOString();
      beatQuery += `&uploaded_at=gte.${cutoff}`;
    }
    if (MAX_BEATS_PER_RUN > 0) beatQuery += `&limit=${MAX_BEATS_PER_RUN}`;
    const beats = await sbSelect("beats", beatQuery);
    if (!Array.isArray(beats)||beats.length===0) {
      rescanLog.lastRun = new Date().toISOString();
      rescanLog.lastResult = { message:"No beats to rescan.", count:0 };
      return res.json(rescanLog.lastResult);
    }
    console.log(`Rescanning ${beats.length} beats (3 engines × up to 6 slices each)...`);
    let newMatches=0, scanned=0, skipped=0, unmonitorable=0;
    for (const beat of beats) {
      try {
        if (!beat.storage_path) { unmonitorable++; console.warn(`Beat ${beat.id} ("${beat.filename}") has no stored audio — cannot be rescanned. user=${beat.user_id}`); continue; }
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
        const acrData=await scanAllEngines(buffer, beat.filename, "audio/mpeg", true);
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
          // Must be corroborated — detected on 2+ slices or by 2+ engines. This is
          // what stops a lone single-slice sample/loop collision from silently being
          // written as a "placed" placement during an unattended rescan.
          if (m._corroborated === false) return false;
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
        scanned++;
        if (matched) {
          // Compare every confident match from this pass against the beat's FULL
          // placement history (not just the single last_result field) — this is
          // what lets a second or third song using the same beat get caught,
          // instead of being silently discarded because it isn't the newest.
          const existingPlacements = await getPlacements(beat.id);
          const existingKeys = new Set(existingPlacements.map(p => normaliseTitle(p.title)));
          const candidateNew = goodRescanMusic.filter(m => !existingKeys.has(normaliseTitle(m.title)));

          if (candidateNew.length > 0) {
            const canEmail=RESEND_KEY&&(status.emailMonitorLimit===null||(status.emailMonitorLimit>0&&status.emailMonitorsUsed<status.emailMonitorLimit));
            let uData=null;
            if (canEmail) {
              const uRes=await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${beat.user_id}`,{headers:{"apikey":SUPABASE_SERVICE,"Authorization":`Bearer ${SUPABASE_SERVICE}`}});
              uData=await uRes.json().catch(()=>null);
            }
            let emailsSentThisBeat=0, latestPlaced=null;
            for (const m of candidateNew) {
              const title=m.title, artist=m.artists?.[0]?.name, spotifyId=m.external_metadata?.spotify?.track?.id, youtubeId=m.external_metadata?.youtube?.vid;
              const stillHaveQuota = status.emailMonitorLimit===null || (status.emailMonitorsUsed+emailsSentThisBeat) < status.emailMonitorLimit;
              let emailed=false, attempted=false;
              if (canEmail && uData?.email && stillHaveQuota) {
                attempted=true;
                const isFirstEver = existingPlacements.length===0 && emailsSentThisBeat===0;
                const subject = isFirstEver ? `🎵 New placement found: "${beat.filename}"` : `🎵 Another placement found: "${beat.filename}"`;
                const sendRes=await sendEmail(uData.email,subject,placementEmailHtml(beat.filename,title,artist,spotifyId,youtubeId));
                emailed=!!(sendRes && (sendRes.id || sendRes.data));
                if (!emailed) console.error(`CRITICAL: placement email FAILED for beat ${beat.id} user ${beat.user_id} title="${title}" — will retry next rescan.`);
              }
              // Only persist a placement once the user's actually been notified, or when
              // we legitimately can't notify (no key / over their monthly alert cap). If
              // an email was attempted and failed, skip it so it retries clean next cycle.
              if (emailed || !attempted) {
                const inserted = await addPlacementIfNew(beat.id, beat.user_id, m, "rescan");
                if (inserted) {
                  latestPlaced = { title, artist, spotifyId, youtubeId };
                  if (emailed) { emailsSentThisBeat++; newMatches++; }
                }
              }
            }
            if (emailsSentThisBeat>0 && status.emailMonitorLimit!==null) {
              const ps=await sbSelect("profiles",`id=eq.${beat.user_id}`);
              const p=ps?.[0];
              if (p) await sbUpdate("profiles",`id=eq.${beat.user_id}`,{ email_monitors_used:(p.email_monitors_used||0)+emailsSentThisBeat });
            }
            if (latestPlaced) {
              await sbUpdate("beats",`id=eq.${beat.id}`,{ status:"placed", last_scanned:new Date().toISOString(), last_result:latestPlaced.title, last_artist:latestPlaced.artist||null, spotify_id:latestPlaced.spotifyId||null, youtube_id:latestPlaced.youtubeId||null });
            } else {
              await sbUpdate("beats",`id=eq.${beat.id}`,{ last_scanned:new Date().toISOString() });
            }
          } else {
            // Matched, but every song found this pass is already on record for this beat.
            await sbUpdate("beats",`id=eq.${beat.id}`,{ last_scanned:new Date().toISOString() });
          }
        } else { await sbUpdate("beats",`id=eq.${beat.id}`,{ last_scanned:new Date().toISOString() }); }
        // Stagger requests — slightly longer gap to respect rate limits across 3 engines
        await new Promise(r=>setTimeout(r,700));
      } catch(e) { console.error(`Rescan error beat ${beat.id}:`,e.message); skipped++; }
    }
    const result = { message:"Rescan complete.", total:beats.length, scanned, skipped, unmonitorable, newMatches };
    rescanLog.lastRun = new Date().toISOString();
    rescanLog.lastResult = result;
    res.json(result);
  } catch(e) { console.error("Rescan error:",e.message); res.status(500).json({ error:e.message }); }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
  // Which recognition engines are actually live this boot. A paid engine showing
  // OFF means its key is missing — detection silently degrades without this line.
  console.log(`Engines — ACRCloud:${ACR_KEY?"ON":"OFF"}  AudD:${process.env.AUDD_API_TOKEN?"ON":"OFF"}  Shazam:${RAPIDAPI_KEY?"ON":"OFF"}`);
  // RESCAN CADENCE (cron → POST /rescan with header x-rescan-secret):
  //   Every 3 days, e.g. 0 7 */3 * * — checks every monitored beat.
  // (Stretching from 2 days to 3 trims recurring spend ~1/3; combined with the
  //  single-shot AudD/Shazam fan-out, total recognition cost is way down.)
  // IMPORTANT: profiles table needs a `fingerprint_log` JSONB column.
  // Run this in Supabase SQL editor if not already added:
  // ALTER TABLE profiles ADD COLUMN IF NOT EXISTS fingerprint_log JSONB DEFAULT '[]'::jsonb;
  console.log("Note: ensure profiles.fingerprint_log JSONB column exists in Supabase.");
});

