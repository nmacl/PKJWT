const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
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

// helper (reuse your buildAssertion)
async function getSfToken() {
  const assertion = buildAssertion();
  const url = `${process.env.SF_LOGIN_URL}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.append("grant_type","urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.append("assertion", assertion);
  const { data } = await axios.post(url, body.toString(), {
    headers:{ "Content-Type":"application/x-www-form-urlencoded" }
  });
  return data; // { access_token, instance_url }
}

const sq = s => String(s || "").replace(/'/g, "\\'");

app.post("/webhooks/klaviyo", async (req, res) => {
  try {
    // OPTIONAL: shared-secret check
    if (process.env.KLAVIYO_SECRET && req.headers["x-klaviyo-signature"] !== process.env.KLAVIYO_SECRET) {
      return res.status(401).json({ ok:false, error:"unauthorized" });
    }

    const { email, subject, body, event, properties } = req.body || {};
    const tok = await getSfToken();
    const H = { Authorization: `Bearer ${tok.access_token}` };

    // try to link to a Contact by email
    let whoId = null;
    if (email) {
      const q = encodeURIComponent(`SELECT Id FROM Contact WHERE Email='${sq(email)}' LIMIT 1`);
      const qr = await axios.get(`${tok.instance_url}/services/data/v61.0/query?q=${q}`, { headers: H });
      whoId = qr.data?.records?.[0]?.Id || null;
    }

    const task = {
      Subject: subject || (event ? `Klaviyo: ${event}` : "Klaviyo Event"),
      Description: body || (properties ? JSON.stringify(properties, null, 2) : ""),
      Status: "Completed",
      Priority: "Normal",
      ...(whoId ? { WhoId: whoId } : {})
    };

    const tr = await axios.post(`${tok.instance_url}/services/data/v61.0/sobjects/Task`, task, { headers: H });
    res.json({ ok:true, taskId: tr.data.id, linkedTo: whoId });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});



const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
