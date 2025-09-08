const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "2mb" }));

function getPrivateKey() {
  // Prefer env var (Railway → Variables). Accepts \n-escaped text.
  const k = process.env.SF_PRIVATE_KEY || "";
  return k.includes("\\n") ? k.replace(/\\n/g, "\n") : k;
}

function buildAssertion() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.SF_CONSUMER_KEY,                    // Connected App "Consumer Key"
    sub: process.env.SF_USERNAME,                        // Integration User username
    aud: process.env.SF_LOGIN_URL || "https://login.salesforce.com", // base login URL
    exp: now + 180
  };
  return jwt.sign(payload, getPrivateKey(), { algorithm: "RS256" });
}

// health
app.get("/health", (_, res) => res.json({ ok: true }));

// Quick JWT → SF token test
app.post("/auth/sf/jwt/test", async (_, res) => {
  try {
    const assertion = buildAssertion();
    const url = `${process.env.SF_LOGIN_URL || "https://login.salesforce.com"}/services/oauth2/token`;

    const body = new URLSearchParams();
    body.append("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    body.append("assertion", assertion);

    const { data } = await axios.post(url, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000
    });

    res.json({
      ok: true,
      token_type: data.token_type,
      instance_url: data.instance_url,
      scope: data.scope,
      access_token_preview: data.access_token?.slice(0, 36) + "...(truncated)"
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// (optional) Klaviyo webhook stub — we’ll wire it up next
app.post("/webhooks/klaviyo", (req, res) => {
  console.log("Klaviyo payload:", JSON.stringify(req.body).slice(0, 1000));
  res.status(202).json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
