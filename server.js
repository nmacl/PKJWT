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

    // ---- Parse the orderData string into an object ----
    let orderData = {};
    if (req.body?.orderData && typeof req.body.orderData === 'string') {
      try {
        // The orderData comes as a Python-style string, need to convert to valid JSON
        const pythonStr = req.body.orderData;
        // Convert Python dict syntax to JSON
        const jsonStr = pythonStr
          .replace(/'/g, '"')           // Single quotes to double quotes
          .replace(/True/g, 'true')     // Python True to JSON true
          .replace(/False/g, 'false')   // Python False to JSON false
          .replace(/None/g, 'null');    // Python None to JSON null
        
        orderData = JSON.parse(jsonStr);
      } catch (e) {
        console.log("Failed to parse orderData:", e.message);
        orderData = {};
      }
    } else if (req.body?.orderData && typeof req.body.orderData === 'object') {
      orderData = req.body.orderData;
    }

    // ---- Extract data using correct structure ----
    const email = req.body?.email || orderData?.BillingAddress?.Email || orderData?.ShippingAddress?.Email || null;
    const orderId = orderData?.OrderId || "N/A";
    
    // Get customer info from BillingAddress (primary) or ShippingAddress (fallback)
    const billing = orderData?.BillingAddress || {};
    const shipping = orderData?.ShippingAddress || {};
    
    const fullName = billing?.FullName || shipping?.FullName || `${billing?.FirstName || ''} ${billing?.LastName || ''}`.trim() || "N/A";
    const phone = billing?.Phone || shipping?.Phone || "";
    
    const subject = req.body?.subject || `Order Confirmation: #${orderId}`;
    const fromAddr = process.env.FROM_EMAIL || "noreply@corporategear.email";
    const toAddr = email || "";

    console.log(`🎯 WEBHOOK RECEIVED: Order #${orderId} for ${toAddr} at ${new Date().toISOString()}`);
    console.log(`👤 Customer: ${fullName} (${phone || 'no phone'})`);
    console.log(`💰 Total: $${orderData?.$value || 'unknown'} ${orderData?.$value_currency || 'USD'}`);

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
      <p><strong>Address:</strong> ${shipping?.Address1 || billing?.Address1 || ''}</p>
      ${(shipping?.Address2 || billing?.Address2) ? `<p><strong>Address 2:</strong> ${shipping.Address2 || billing.Address2}</p>` : ''}
      <p><strong>City:</strong> ${shipping?.City || billing?.City || ''}</p>
      <p><strong>State:</strong> ${shipping?.Region || billing?.Region || ''}</p>
      <p><strong>Zip Code:</strong> ${shipping?.Zip || billing?.Zip || ''}</p>
      <p><strong>Country:</strong> ${shipping?.Country || billing?.Country || ''}</p>
    </div>`;

    // Order Totals Section
    const totalsSection = `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Order Summary</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Subtotal:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">${formatCurrency(orderData?.SubTotal, orderData?.$value_currency)}</td></tr>
        <tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Shipping:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">${formatCurrency(orderData?.ShippingValue, orderData?.$value_currency)}</td></tr>
        <tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Tax:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">${formatCurrency(orderData?.Tax, orderData?.$value_currency)}</td></tr>
        ${orderData?.DiscountValue && parseFloat(orderData.DiscountValue) > 0 ? 
          `<tr><td style="padding: 5px 0; border-bottom: 1px solid #eee;"><strong>Discount:</strong></td><td style="text-align: right; padding: 5px 0; border-bottom: 1px solid #eee;">-${formatCurrency(orderData.DiscountValue, orderData?.$value_currency)}</td></tr>` : ''}
        <tr style="font-weight: bold; font-size: 1.1em;"><td style="padding: 10px 0; border-top: 2px solid #333;"><strong>Total:</strong></td><td style="text-align: right; padding: 10px 0; border-top: 2px solid #333;">${formatCurrency(orderData?.$value, orderData?.$value_currency)}</td></tr>
      </table>
      <p><strong>Payment Method:</strong> ${orderData?.PaymentMethod || 'N/A'}</p>
      <p><strong>Total Items:</strong> ${orderData?.TotalNumbersOfItemsOrdered || 'N/A'}</p>
      ${orderData?.DiscountCode ? `<p><strong>Discount Code:</strong> ${orderData.DiscountCode}</p>` : ''}
    </div>`;

    // Products Section - Build from Items array
    let productsSection = '';
    if (orderData?.Items && Array.isArray(orderData.Items) && orderData.Items.length > 0) {
      const productRows = orderData.Items.map(item => `
        <div style="border: 1px solid #eee; padding: 15px; margin-bottom: 10px; border-radius: 5px;">
          <div style="display: flex; align-items: start; gap: 15px;">
            ${item.ImageURL ? `<img src="${item.ImageURL}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 3px;">` : ''}
            <div style="flex: 1;">
              <p><strong>${item.ProductName || 'Product'}</strong></p>
              <p><strong>Brand:</strong> ${item.Brand || 'N/A'}</p>
              <p><strong>SKU:</strong> ${item.SKU || 'N/A'}</p>
              <p><strong>Color:</strong> ${item.Color || 'N/A'}</p>
              <p><strong>Quantity:</strong> ${item.Quantity || 'N/A'}</p>
              <p><strong>Unit Price:</strong> ${formatCurrency(item.ItemPrice, orderData?.$value_currency)}</p>
              <p><strong>Line Total:</strong> ${formatCurrency(item.RowTotal, orderData?.$value_currency)}</p>
              ${item.ProductURL ? `<p><a href="${item.ProductURL}" style="color: #007cba;">View Product</a></p>` : ''}
              ${item.ItemNotes ? `<p><strong>Notes:</strong> ${item.ItemNotes}</p>` : ''}
            </div>
          </div>
        </div>
      `).join('');

      productsSection = `
      <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
        <h3 style="color: #333; margin-top: 0;">Order Items (${orderData.Items.length})</h3>
        ${productRows}
      </div>`;
    }

    // Notes Section
    const notesSection = orderData?.OrderNotes ? `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
      <h3 style="color: #333; margin-top: 0;">Order Notes</h3>
      <p>${orderData.OrderNotes}</p>
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
      ${productsSection}
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
      to: toAddr,
      orderTotal: orderData?.$value,
      itemCount: orderData?.TotalNumbersOfItemsOrdered
    });

  } catch (e) {
    const duration = Date.now() - startTime;
    console.error(`❌ WEBHOOK FAILED after ${duration}ms`);
    console.error(`   Error:`, e?.response?.data || e.message);
    console.error(`   Stack:`, e.stack);
    
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));