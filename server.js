const express  = require("express");
const multer   = require("multer");
const fetch    = require("node-fetch");
const FormData = require("form-data");
const cors     = require("cors");

const app  = express();
const port = process.env.PORT || 3001;

app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    tokenSet: !!process.env.AUDD_TOKEN,
    tokenPreview: process.env.AUDD_TOKEN ? process.env.AUDD_TOKEN.slice(0, 6) + "..." : "MISSING"
  });
});

app.post("/scan", upload.single("file"), async (req, res) => {
  try {
    const token = process.env.AUDD_TOKEN;
    if (!token)    return res.status(500).json({ error: "API token not configured." });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    form.append("api_token", token);
    form.append("return", "spotify,apple_music,deezer,musicbrainz");

    const auddRes  = await fetch("https://api.audd.io/", { method: "POST", body: form });
    const auddData = await auddRes.json();

    console.log("AudD response:", JSON.stringify(auddData));
    res.json(auddData);
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: "Scan failed: " + err.message });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
