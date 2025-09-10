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

// --- constants & helpers above stay the same ---

app.post("/webhooks/klaviyo", async (req, res) => {
  try {
    if (process.env.KLAVIYO_SECRET) {
      const sig = req.headers["x-klaviyo-signature"];
      if (sig !== process.env.KLAVIYO_SECRET) return res.status(401).json({ ok:false, error:"unauthorized" });
    }

    const email =
      req.body?.email ||
      req.body?.orderData?.Email ||
      req.body?.orderData?.email || null;

    const orderData = (typeof req.body?.orderData === "string"
      ? JSON.parse(req.body.orderData)
      : (req.body?.orderData || {}));

    const orderId = orderData?.OrderId || orderData?.orderId || "N/A";
    const phone   = orderData?.Phone || orderData?.phone || "";

    const subject = req.body?.subject || `Order: #${orderId}`;
    const fromAddr = process.env.FROM_EMAIL || "klaviyo@parsonskellogg.com";
    const toAddr = email;

    const tok = await getSfToken();
    const H = { Authorization: `Bearer ${tok.access_token}` };

    // ... inside /webhooks/klaviyo

    // find Contact then Lead; also grab AccountId and User Id to improve linking
    let personId = null, accountId = null, fromUserId = null;
    if (toAddr) {
      const qC = encodeURIComponent(`SELECT Id, AccountId FROM Contact WHERE Email='${sq(toAddr)}' LIMIT 1`);
      const rc = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qC}`, { headers: H });
      personId  = rc.data?.records?.[0]?.Id || null;
      accountId = rc.data?.records?.[0]?.AccountId || null;

      if (!personId) {
        const qL = encodeURIComponent(`SELECT Id FROM Lead WHERE Email='${sq(toAddr)}' LIMIT 1`);
        const rl = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qL}`, { headers: H });
        personId = rl.data?.records?.[0]?.Id || null;
      }
    }

    // (optional) resolve the user who “sent” it
    if (process.env.SF_USERNAME) {
      const qU = encodeURIComponent(`SELECT Id FROM User WHERE Username='${sq(process.env.SF_USERNAME)}' LIMIT 1`);
      const ru = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qU}`, { headers: H });
      fromUserId = ru.data?.records?.[0]?.Id || null;
    }

    // EmailMessage payload — set Status to Sent and RelatedToId to Account
    const emailMsgPayload = {
      Subject: subject,
      HtmlBody: htmlLines,
      TextBody: htmlLines.replace(/<[^>]+>/g, ""),
      FromAddress: fromAddr,
      ToAddress: toAddr || "",
      Incoming: false,
      Status: "Sent",                               // 👈 make it look like a real sent email
      MessageDate: new Date().toISOString(),
      ...(accountId ? { RelatedToId: accountId } : {}) // 👈 tie to Account like your “good” example
    };

    const emr = await axios.post(
      `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessage`,
      emailMsgPayload,
      { headers: H }
    );
    const emailMessageId = emr.data.id;

    // Link recipients/sender so it shows on the Contact timeline
    if (personId) {
      await axios.post(
        `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessageRelation`,
        { EmailMessageId: emailMessageId, RelationId: personId, RelationType: "ToAddress" },
        { headers: H }
      );
    }
    if (fromUserId) {
      await axios.post(
        `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessageRelation`,
        { EmailMessageId: emailMessageId, RelationId: fromUserId, RelationType: "FromAddress" },
        { headers: H }
      );
    }

    res.json({ ok:true, emailMessageId, linkedTo: personId, subject, to: toAddr });
  } catch (e) {
    console.error("Email log error:", e?.response?.data || e);
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});


// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));