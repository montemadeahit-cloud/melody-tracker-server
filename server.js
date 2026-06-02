// Melody Tracker — Backend Proxy
const express  = require("express");
const multer   = require("multer");
const fetch    = require("node-fetch");
const FormData = require("form-data");
const cors     = require("cors");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const AUDD_TOKEN = process.env.AUDD_TOKEN;

app.use(cors());

// Test endpoint — lets you confirm the server is alive and token is set
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    tokenSet: !!AUDD_TOKEN,
    tokenPreview: AUDD_TOKEN ? AUDD_TOKEN.slice(0, 6) + "..." : "MISSING"
  });
});

app.post("/scan", upload.single("file"), async (req, res) => {
  try {
    if (!AUDD_TOKEN) return res.status(500).json({ error: "API token not configured on server." });
    if (!req.file)   return res.status(400).json({ error: "No file uploaded." });

    const form = new FormData();
    form.append("file",      req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    form.append("api_token", AUDD_TOKEN);
    form.append("return",    "spotify,apple_music,deezer,musicbrainz");

    const auddRes  = await fetch("https://api.audd.io/", { method: "POST", body: form });
    const auddData = await auddRes.json();

    console.log("AudD response:", JSON.stringify(auddData));
    res.json(auddData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scan failed: " + err.message });
  }
});

app.listen(process.env.PORT || 3001, () => console.log("Melody Tracker server running"));
