// Melody Tracker — Backend Proxy
// Run with: node server.js
// Requires: npm install express multer node-fetch cors

const express  = require("express");
const multer   = require("multer");
const fetch    = require("node-fetch");
const FormData = require("form-data");
const cors     = require("cors");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

// 🔑 Your AudD API token — never exposed to users
const AUDD_TOKEN = "process.env.AUDD_TOKEN";

app.use(cors()); // Allow requests from your frontend

app.post("/scan", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const form = new FormData();
    form.append("file",      req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    form.append("api_token", AUDD_TOKEN);
    form.append("return",    "spotify,apple_music,deezer,musicbrainz");

    const auddRes  = await fetch("https://api.audd.io/", { method: "POST", body: form });
    const auddData = await auddRes.json();

    res.json(auddData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scan failed." });
  }
});

app.listen(3001, () => console.log("Melody Tracker server running on port 3001"));

