// server.js
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- Helpers ----------
const SF_API_VERSION = process.env.SF_API_VERSION || "v61.0";
const sq = s => String(s ?? "").replace(/'/g, "\\'");
const getLoginUrl = () => (process.env.SF_LOGIN_URL || "https://login.salesforce.com").replace(/\/+$/,"");
const getPrivateKey = () => {
  const k = process.env.SF_PRIVATE_KEY || "";
  return k.includes("\\n") ? k.replace(/\\n/g, "\n") : k;
};
const parseMaybeJson = v => {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
};
function buildAssertion() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.SF_CONSUMER_KEY,   // Connected App consumer key
    sub: process.env.SF_USERNAME,       // Salesforce username to impersonate
    aud: getLoginUrl(),                 // must match token host
    exp: now + 180
  };
  return jwt.sign(payload, getPrivateKey(), { algorithm: "RS256" });
}
async function getSfToken() {
  const url = `${getLoginUrl()}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.append("grant_type","urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.append("assertion", buildAssertion());
  const { data } = await axios.post(url, body.toString(), {
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    timeout: 15000
  });
  return data; // { access_token, instance_url, scope, token_type }
}

// ---------- Health ----------
app.get("/health", (_, res) => res.json({ ok: true }));

// ---------- JWT smoke test ----------
app.post("/auth/sf/jwt/test", async (_, res) => {
  try {
    const tok = await getSfToken();
    res.json({
      ok: true,
      token_type: tok.token_type,
      instance_url: tok.instance_url,
      scope: tok.scope,
      access_token_preview: tok.access_token?.slice(0, 36) + "...(truncated)"
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// ---------- Klaviyo Webhook ----------
app.post("/webhooks/klaviyo", async (req, res) => {
  try {
    // OPTIONAL shared-secret check
    if (process.env.KLAVIYO_SECRET) {
      const sig = req.headers["x-klaviyo-signature"];
      if (sig !== process.env.KLAVIYO_SECRET) {
        return res.status(401).json({ ok:false, error:"unauthorized" });
      }
    }

    // Expecting: { email, subject, body, orderData }
    const email =
      req.body?.email ||
      req.body?.orderData?.Email ||
      req.body?.orderData?.email ||
      null;

    const orderData = parseMaybeJson(req.body?.orderData) || req.body?.orderData || {};
    const orderId   = orderData?.orderId || orderData?.OrderId || null;

    const taskSubject =
      req.body?.subject ||
      (orderId ? `Order: #${orderId}` : "Klaviyo Order");

    const taskBodyLead = req.body?.body || "Klaviyo order submission";

    // --- JWT → Salesforce token
    const tok = await getSfToken();
    const H = { Authorization: `Bearer ${tok.access_token}` };

    // --- Find Contact, then Lead by email
    let whoId = null;
    if (email) {
      const qC = encodeURIComponent(`SELECT Id FROM Contact WHERE Email='${sq(email)}' LIMIT 1`);
      const rc = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qC}`, { headers: H });
      whoId = rc.data?.records?.[0]?.Id || null;

      if (!whoId) {
        const qL = encodeURIComponent(`SELECT Id FROM Lead WHERE Email='${sq(email)}' LIMIT 1`);
        const rl = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qL}`, { headers: H });
        whoId = rl.data?.records?.[0]?.Id || null;
      }
    }

    // --- Pretty Task description
    const pretty = [
      taskBodyLead,
      "",
      orderId ? `Order ID: ${orderId}` : "",
      email ? `Customer Email: ${email}` : "",
      (orderData.FullName || orderData.fullName) ? `Customer: ${orderData.FullName || orderData.fullName}` : "",
      (orderData.total ?? orderData.value) && (orderData.currency ?? orderData.value_currency)
        ? `Total: ${orderData.total ?? orderData.value} ${orderData.currency ?? orderData.value_currency}`
        : "",
      (orderData.address1 || orderData.Address1)
        ? `Address: ${orderData.address1 || orderData.Address1}, ${(orderData.city || orderData.City) || ""}, ${(orderData.region || orderData.Region) || ""}, ${(orderData.zip || orderData.Zip) || ""}, ${(orderData.country || orderData.Country) || ""}`
        : "",
      "",
      "Raw Order Data:",
      JSON.stringify(orderData, null, 2)
    ].filter(Boolean).join("\n");

    // --- Create Task
    const task = {
      Subject: taskSubject,
      Description: pretty,
      Status: "Completed",
      Priority: "Normal",
      ...(whoId ? { WhoId: whoId } : {})
    };

    const tr = await axios.post(
      `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/Task`,
      task,
      { headers: H }
    );

    res.json({ ok:true, taskId: tr.data.id, linkedTo: whoId, subject: taskSubject, whoEmail: email || null });
  } catch (e) {
    console.error("Error pushing Task to Salesforce:", e?.response?.data || e);
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
