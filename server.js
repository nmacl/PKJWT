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

    // find Contact then Lead by email (to link in timeline)
    let personId = null;
    if (toAddr) {
      const qC = encodeURIComponent(`SELECT Id FROM Contact WHERE Email='${sq(toAddr)}' LIMIT 1`);
      const rc = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qC}`, { headers: H });
      personId = rc.data?.records?.[0]?.Id || null;

      if (!personId) {
        const qL = encodeURIComponent(`SELECT Id FROM Lead WHERE Email='${sq(toAddr)}' LIMIT 1`);
        const rl = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qL}`, { headers: H });
        personId = rl.data?.records?.[0]?.Id || null;
      }
    }

    // Build readable HTML body
    const htmlLines = [
      `<p><strong>Order #${orderId}</strong></p>`,
      req.body?.body ? `<p>${req.body.body}</p>` : "",
      toAddr ? `<p><b>Email:</b> ${toAddr}</p>` : "",
      phone ? `<p><b>Phone:</b> ${phone}</p>` : "",
      (orderData?.FullName || orderData?.fullName) ? `<p><b>Customer:</b> ${orderData.FullName || orderData.fullName}</p>` : "",
      (orderData?.value || orderData?.total) && (orderData?.value_currency || orderData?.currency)
        ? `<p><b>Total:</b> ${orderData.total || orderData.value} ${orderData.currency || orderData.value_currency}</p>` : "",
      `<pre>${JSON.stringify(orderData, null, 2)}</pre>`
    ].filter(Boolean).join("");

    // 1) Create EmailMessage (logs email)
    const emailMsgPayload = {
      Subject: subject,
      HtmlBody: htmlLines,
      TextBody: htmlLines.replace(/<[^>]+>/g, ""), // simple strip
      FromAddress: fromAddr,
      ToAddress: toAddr || "",
      Incoming: false,
      MessageDate: new Date().toISOString()
      // Optionally: RelatedToId if you want to tie to an Account/Case/etc.
    };

    const emr = await axios.post(
      `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessage`,
      emailMsgPayload,
      { headers: H }
    );
    const emailMessageId = emr.data.id;

    // 2) Link it to the Contact/Lead so it shows on their timeline
    if (personId) {
      // Try ToAddress relation; if org disallows, fallback to RelatedTo
      try {
        await axios.post(
          `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessageRelation`,
          { EmailMessageId: emailMessageId, RelationId: personId, RelationType: "ToAddress" },
          { headers: H }
        );
      } catch {
        await axios.post(
          `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessageRelation`,
          { EmailMessageId: emailMessageId, RelationId: personId, RelationType: "RelatedTo" },
          { headers: H }
        );
      }
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