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
    // OPTIONAL shared-secret check
    if (process.env.KLAVIYO_SECRET) {
      const sig = req.headers["x-klaviyo-signature"];
      if (sig !== process.env.KLAVIYO_SECRET) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    // ---- Extract inbound data (supports orderData as object or JSON string) ----
    const email =
      req.body?.email ||
      req.body?.orderData?.Email ||
      req.body?.orderData?.email || null;

    const orderData = parseMaybeJson(req.body?.orderData) || req.body?.orderData || {};
    const orderId   = orderData?.OrderId || orderData?.orderId || "N/A";
    const phone     = orderData?.Phone   || orderData?.phone   || "";

    const subject  = req.body?.subject || `Order: #${orderId}`;
    const fromAddr = process.env.FROM_EMAIL || "klaviyo@parsonskellogg.com";
    const toAddr   = email || "";

    // ---- Auth → Salesforce ----
    const tok = await getSfToken();
    const H = { Authorization: `Bearer ${tok.access_token}` };

    // ---- Resolve Contact/Lead + Account and From User (for nice linking) ----
    let personId = null;   // Contact.Id or Lead.Id
    let accountId = null;  // Contact.AccountId (if Contact)
    let fromUserId = null; // User.Id for your integration user

    if (toAddr) {
      // Try Contact first (grab AccountId for RelatedToId)
      const qC = encodeURIComponent(`SELECT Id, AccountId FROM Contact WHERE Email='${sq(toAddr)}' LIMIT 1`);
      const rc = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qC}`, { headers: H });
      personId  = rc.data?.records?.[0]?.Id || null;
      accountId = rc.data?.records?.[0]?.AccountId || null;

      // Fall back to Lead
      if (!personId) {
        const qL = encodeURIComponent(`SELECT Id FROM Lead WHERE Email='${sq(toAddr)}' LIMIT 1`);
        const rl = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qL}`, { headers: H });
        personId = rl.data?.records?.[0]?.Id || null;
      }
    }

    // Resolve sender user (optional but nice: shows “From” user)
    if (process.env.SF_USERNAME) {
      const qU = encodeURIComponent(`SELECT Id FROM User WHERE Username='${sq(process.env.SF_USERNAME)}' LIMIT 1`);
      const ru = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qU}`, { headers: H });
      fromUserId = ru.data?.records?.[0]?.Id || null;
    }

    // ---- Build bodies (HTML + Text) ----
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

    const textBody = htmlLines
      .replace(/<\/p>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "") // naive strip
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // ---- 1) Create EmailMessage (as Sent, link to Account if we have it) ----
    const emailMsgPayload = {
      Subject: subject,
      HtmlBody: htmlLines,
      TextBody: textBody,
      FromAddress: fromAddr,
      ToAddress: toAddr,
      Incoming: false,
      Status: "Sent",                       // <-- this makes it look like a real sent email
      MessageDate: new Date().toISOString(),
      ...(accountId ? { RelatedToId: accountId } : {}) // <-- shows on Account like your “good” example
    };

    const emr = await axios.post(
      `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessage`,
      emailMsgPayload,
      { headers: H }
    );
    const emailMessageId = emr.data.id;

    // ---- 2) Link recipients/sender via EmailMessageRelation so it shows on Contact/Lead ----
    const relEndpoint = `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/EmailMessageRelation`;

    // Tie to Contact/Lead as recipient
    if (personId) {
      try {
        await axios.post(relEndpoint, {
          EmailMessageId: emailMessageId,
          RelationId: personId,
          RelationType: "ToAddress"
        }, { headers: H });
      } catch {
        // Fallback if org restricts RelationType
        await axios.post(relEndpoint, {
          EmailMessageId: emailMessageId,
          RelationId: personId,
          RelationType: "RelatedTo"
        }, { headers: H });
      }
    }

    // Tie the sender user (optional)
    if (fromUserId) {
      try {
        await axios.post(relEndpoint, {
          EmailMessageId: emailMessageId,
          RelationId: fromUserId,
          RelationType: "FromAddress"
        }, { headers: H });
      } catch {
        // ignore if not allowed
      }
    }

    // ---- Done ----
    res.json({
      ok: true,
      emailMessageId,
      linkedPersonId: personId,
      relatedToAccountId: accountId || null,
      subject,
      to: toAddr
    });
  } catch (e) {
    console.error("Email log error:", e?.response?.data || e);
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});


// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));