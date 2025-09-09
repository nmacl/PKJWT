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

// (optional) Klaviyo webhook stub — we’ll wire it up next
app.post("/webhooks/klaviyo", (req, res) => {
  console.log("Klaviyo payload:", JSON.stringify(req.body).slice(0, 1000));
  res.status(202).json({ received: true });
});

// use your existing getSfToken() from earlier message
async function getSfToken() {
  const assertion = buildAssertion();
  const url = `${process.env.SF_LOGIN_URL}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.append("grant_type","urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.append("assertion", assertion);
  const { data } = await axios.post(url, body.toString(), {
    headers:{ "Content-Type":"application/x-www-form-urlencoded" }
  });
  return data; // { access_token, instance_url, ... }
}

// 1) Start a bot session
app.post("/einstein/session/start", async (req, res) => {
  try {
    const tok = await getSfToken();
    const host = process.env.BOT_RUNTIME_BASE_URL; // e.g. https://runtime-api-na-west.prod.chatbots.sfdc.sh
    const botId = process.env.BOT_ID;
    const url = `${host}/v5/bots/${botId}/sessions`;

    const payload = {
      forceConfig: { endpoint: process.env.FORCE_ENDPOINT },
      externalSessionKey: randomUUID(),
      message: { text: (req.body && req.body.text) || "Hello" }
    };

    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/json",
        "X-Org-Id": process.env.ORG_ID,
        "X-Request-Id": randomUUID()
      }
    });

    res.json({ ok:true, sessionId: data.sessionId, response: data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// 2) Continue a session (send a message)
app.post("/einstein/session/:sessionId/send", async (req, res) => {
  try {
    const tok = await getSfToken();
    const host = process.env.BOT_RUNTIME_BASE_URL;
    const botId = process.env.BOT_ID;
    const { sessionId } = req.params;
    const url = `${host}/v5/bots/${botId}/sessions/${sessionId}/messages`;

    const payload = {
      messages: [{
        sequenceId: Date.now(), // simple monotonic id
        text: req.body?.text || "How can you help me?"
      }]
    };

    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/json",
        "X-Org-Id": process.env.ORG_ID,
        "X-Request-Id": randomUUID()
      }
    });

    res.json({ ok:true, response: data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
