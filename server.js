const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const crypto   = require("crypto");
const fetch    = require("node-fetch");
const FormData = require("form-data");

const app  = express();
const port = process.env.PORT || 8080;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));

const upload = multer({ storage: multer.memoryStorage() });

const ACR_HOST   = process.env.ACR_HOST;
const ACR_KEY    = process.env.ACR_KEY;
const ACR_SECRET = process.env.ACR_SECRET;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    acrHost: ACR_HOST || "MISSING",
    keySet: !!ACR_KEY,
    secretSet: !!ACR_SECRET,
  });
});

app.post("/scan", upload.single("file"), async (req, res) => {
  try {
    if (!ACR_HOST || !ACR_KEY || !ACR_SECRET)
      return res.status(500).json({ error: "ACRCloud credentials not configured." });
    if (!req.file)
      return res.status(400).json({ error: "No file uploaded." });

    const timestamp    = Math.floor(Date.now() / 1000);
    const stringToSign = `POST\n/v1/identify\n${ACR_KEY}\naudio\n1\n${timestamp}`;
    const signature    = crypto.createHmac("sha1", ACR_SECRET).update(stringToSign).digest("base64");

    const form = new FormData();
    form.append("sample",            req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    form.append("access_key",        ACR_KEY);
    form.append("data_type",         "audio");
    form.append("signature_version", "1");
    form.append("signature",         signature);
    form.append("sample_bytes",      req.file.size.toString());
    form.append("timestamp",         timestamp.toString());

    const acrRes  = await fetch(`https://${ACR_HOST}/v1/identify`, { method: "POST", body: form });
    const acrData = await acrRes.json();

    console.log("ACRCloud response:", JSON.stringify(acrData));
    res.json(acrData);

  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: "Scan failed: " + err.message });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
