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
    const { email, subject, body, orderData } = req.body;

    // Find Contact or Lead by email
    let whoId = null;
    const contactResult = await conn.query(
      `SELECT Id FROM Contact WHERE Email = '${email}' LIMIT 1`
    );
    if (contactResult.records.length > 0) {
      whoId = contactResult.records[0].Id;
    } else {
      const leadResult = await conn.query(
        `SELECT Id FROM Lead WHERE Email = '${email}' LIMIT 1`
      );
      if (leadResult.records.length > 0) {
        whoId = leadResult.records[0].Id;
      }
    }

    // Format body nicely
    const orderText = [
      `Order ID: ${orderData.orderId}`,
      `Customer: ${orderData.firstName} ${orderData.lastName}`,
      `Email: ${email}`,
      `Total: ${orderData.total} ${orderData.currency}`,
      `Address: ${orderData.address1}, ${orderData.city}, ${orderData.region}, ${orderData.zip}, ${orderData.country}`,
      ``,
      `Raw Order Data:`,
      JSON.stringify(orderData, null, 2)
    ].join("\n");

    // Create Task
    const task = await conn.sobject("Task").create({
      Subject: subject || `Order: #${orderData.orderId}`,
      Description: orderText,
      WhoId: whoId || undefined,
      Status: "Completed",
      Priority: "Normal"
    });

    res.json({ ok: true, taskId: task.id, linkedTo: whoId });
  } catch (err) {
    console.error("Error pushing Task to Salesforce:", err);
    res.status(500).json({ ok: false, error: err });
  }
});



const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
