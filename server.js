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

// ---------- Main Klaviyo Webhook ----------
app.post("/webhooks/klaviyo", async (req, res) => {
  const startTime = Date.now();
  
  try {
    // OPTIONAL shared-secret check
    if (process.env.KLAVIYO_SECRET) {
      const sig = req.headers["x-klaviyo-signature"];
      if (sig !== process.env.KLAVIYO_SECRET) {
        console.log(`❌ UNAUTHORIZED: Invalid signature`);
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    // ---- Extract inbound data ----
    const email = req.body?.email || req.body?.orderData?.Email || req.body?.orderData?.email || null;
    const orderData = parseMaybeJson(req.body?.orderData) || req.body?.orderData || {};
    const orderId = orderData?.OrderId || orderData?.orderId || "N/A";
    const phone = orderData?.Phone || orderData?.phone || "";
    const subject = req.body?.subject || `Order Confirmation: #${orderId}`;
    const fromAddr = process.env.FROM_EMAIL || "klaviyo@parsonskellogg.com";
    const toAddr = email || "";

    console.log(`🎯 WEBHOOK RECEIVED: Order #${orderId} for ${email} at ${new Date().toISOString()}`);

    // ---- Auth → Salesforce ----
    const tok = await getSfToken();
    const H = { Authorization: `Bearer ${tok.access_token}` };

    // ---- Resolve Contact/Lead + Account and From User ----
    let personId = null;   // Contact.Id or Lead.Id
    let accountId = null;  // Contact.AccountId (if Contact)
    let fromUserId = null; // User.Id for your integration user

    if (toAddr) {
      // Try Contact first (grab AccountId for RelatedToId)
      const qC = encodeURIComponent(`SELECT Id, AccountId FROM Contact WHERE Email='${sq(toAddr)}' LIMIT 1`);
      const rc = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qC}`, { headers: H });
      personId = rc.data?.records?.[0]?.Id || null;
      accountId = rc.data?.records?.[0]?.AccountId || null;

      // Fall back to Lead
      if (!personId) {
        const qL = encodeURIComponent(`SELECT Id FROM Lead WHERE Email='${sq(toAddr)}' LIMIT 1`);
        const rl = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qL}`, { headers: H });
        personId = rl.data?.records?.[0]?.Id || null;
      }
    }

    // Resolve sender user (optional but nice: shows "From" user)
    if (process.env.SF_USERNAME) {
      const qU = encodeURIComponent(`SELECT Id FROM User WHERE Username='${sq(process.env.SF_USERNAME)}' LIMIT 1`);
      const ru = await axios.get(`${tok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qU}`, { headers: H });
      fromUserId = ru.data?.records?.[0]?.Id || null;
    }

    // ---- Build comprehensive email content ----
    const formatCurrency = (amount, currency = 'USD') => {
      if (!amount) return '';
      const num = parseFloat(amount);
      return isNaN(num) ? amount : `$${num.toFixed(2)} ${currency}`;
    };

    // Customer Information Section
    const customerSection = `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Customer Information</h3>
      <p><strong>Name:</strong> ${fullName}</p>
      <p><strong>Email:</strong> ${toAddr}</p>
      <p><strong>Phone:</strong> ${phone || 'N/A'}</p>
      <p><strong>Order ID:</strong> ${orderId}</p>
      ${orderData?.OrderDetailsLink ? `<p><strong>Order Details:</strong> <a href="${orderData.OrderDetailsLink}">View Full Order</a></p>` : ''}
    </div>`;

    // Billing & Shipping Section
    const addressSection = `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Shipping Address</h3>
      <p><strong>Address:</strong> ${orderData?.Address1 || ''}</p>
      ${orderData?.Address2 ? `<p><strong>Address 2:</strong> ${orderData.Address2}</p>` : ''}
      <p><strong>City:</strong> ${orderData?.City || ''}</p>
      <p><strong>State/Region:</strong> ${orderData?.Region || ''}</p>
      <p><strong>Zip Code:</strong> ${orderData?.Zip || ''}</p>
      <p><strong>Country:</strong> ${orderData?.Country || ''}</p>
    </div>`;

    // Order Totals Section
    const totalsSection = `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Order Summary</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Subtotal:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">${formatCurrency(orderData?.SubTotal, orderData?.value_currency || orderData?.$value_currency)}</td></tr>
        <tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Shipping:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">${formatCurrency(orderData?.ShippingValue, orderData?.value_currency || orderData?.$value_currency)}</td></tr>
        <tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Tax:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">${formatCurrency(orderData?.Tax, orderData?.value_currency || orderData?.$value_currency)}</td></tr>
        ${orderData?.DiscountValue && parseFloat(orderData.DiscountValue) > 0 ? 
          `<tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Discount:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">-${formatCurrency(orderData.DiscountValue, orderData?.value_currency || orderData?.$value_currency)}</td></tr>` : ''}
        <tr style="font-weight: bold; font-size: 1.1em;"><td style="padding: 10px 0; border-top: 2px solid #333;"><strong>Total:</strong></td><td style="text-align: right; padding: 10px 0; border-top: 2px solid #333;">${formatCurrency(orderData?.$value || orderData?.value, orderData?.value_currency || orderData?.$value_currency)}</td></tr>
      </table>
      <p><strong>Payment Method:</strong> ${orderData?.PaymentMethod || 'N/A'}</p>
      ${orderData?.DiscountCode ? `<p><strong>Discount Code:</strong> ${orderData.DiscountCode}</p>` : ''}
    </div>`;

    // Product Details Section (if available)
    const productSection = orderData?.ProductName ? `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Product Details</h3>
      <div style="border: 1px solid #eee; padding: 10px; margin-bottom: 10px;">
        <p><strong>Product:</strong> ${orderData.ProductName}</p>
        ${orderData.Brand ? `<p><strong>Brand:</strong> ${orderData.Brand}</p>` : ''}
        ${orderData.SKU ? `<p><strong>SKU:</strong> ${orderData.SKU}</p>` : ''}
        ${orderData.Color ? `<p><strong>Color:</strong> ${orderData.Color}</p>` : ''}
        <p><strong>Quantity:</strong> ${orderData.Quantity || 'N/A'}</p>
        <p><strong>Unit Price:</strong> ${formatCurrency(orderData?.ItemPrice, orderData?.value_currency || orderData?.$value_currency)}</p>
        <p><strong>Line Total:</strong> ${formatCurrency(orderData?.RowTotal, orderData?.value_currency || orderData?.$value_currency)}</p>
        ${orderData.ProductURL ? `<p><strong>Product Link:</strong> <a href="${orderData.ProductURL}">View Product</a></p>` : ''}
        ${orderData.ImageURL ? `<p><strong>Product Image:</strong> <br><img src="${orderData.ImageURL}" style="max-width: 200px; height: auto;"></p>` : ''}
      </div>
    </div>` : '';

    // Notes Section
    const notesSection = (orderData?.OrderNotes || orderData?.ItemNotes) ? `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Notes</h3>
      ${orderData?.OrderNotes ? `<p><strong>Order Notes:</strong> ${orderData.OrderNotes}</p>` : ''}
      ${orderData?.ItemNotes ? `<p><strong>Item Notes:</strong> ${orderData.ItemNotes}</p>` : ''}
      ${orderData?.LogoNotes ? `<p><strong>Logo Notes:</strong> ${orderData.LogoNotes}</p>` : ''}
    </div>` : '';

    // Custom message from Klaviyo (if any)
    const customMessage = req.body?.body ? `
    <div style="margin-bottom: 20px; padding: 15px; background-color: #f9f9f9; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Message</h3>
      <p>${req.body.body}</p>
    </div>` : '';

    // Raw Data Section (for debugging/completeness)
    const rawDataSection = `
    <div style="margin-top: 30px; padding: 15px; background-color: #f5f5f5; border-radius: 5px;">
      <h4 style="color: #666; margin-top: 0;">Complete Order Data</h4>
      <pre style="background: white; padding: 10px; border-radius: 3px; overflow-x: auto; font-size: 11px;">${JSON.stringify(orderData, null, 2)}</pre>
    </div>`;

    // Combine all sections
    const htmlLines = `
    <div style="font-family: Arial, sans-serif; max-width: 800px;">
      <h2 style="color: #333; border-bottom: 2px solid #007cba; padding-bottom: 10px;">Order Confirmation: #${orderId}</h2>
      ${customMessage}
      ${customerSection}
      ${addressSection}
      ${totalsSection}
      ${productSection}
      ${notesSection}
      ${rawDataSection}
    </div>`;

    // Create plain text version
    const textBody = htmlLines
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
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
      Status: "3",                          // <-- "Sent" status (numeric value)
      MessageDate: new Date().toISOString(),
      ...(accountId ? { RelatedToId: accountId } : {}) // <-- shows on Account
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

    // ---- Success Logging ----
    const duration = Date.now() - startTime;
    console.log(`✅ SUCCESS: Order #${orderId} logged to Salesforce in ${duration}ms`);
    console.log(`   📧 EmailMessage ID: ${emailMessageId}`);
    console.log(`   👤 Person ID: ${personId || 'none'}`);
    console.log(`   🏢 Account ID: ${accountId || 'none'}`);

    res.json({
      ok: true,
      emailMessageId,
      linkedPersonId: personId,
      relatedToAccountId: accountId || null,
      subject,
      to: toAddr
    });

  } catch (e) {
    const duration = Date.now() - startTime;
    const orderId = req.body?.orderData?.OrderId || req.body?.orderData?.orderId || "unknown";
    
    console.error(`❌ WEBHOOK FAILED: Order #${orderId} after ${duration}ms`);
    console.error(`   Error:`, e?.response?.data || e.message);
    
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));