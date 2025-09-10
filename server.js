// --- constants & helpers above stay the same ---

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
    const phone     = orderData?.Phone || orderData?.phone || null;

    // Per your request: force a fixed picklist Subject "Order"
    const SUBJECT_VALUE = process.env.TASK_SUBJECT || "Order";   // must exist in Task.Subject picklist
    const TYPE_VALUE    = process.env.TASK_TYPE || "Klaviyo";    // must exist in Task.Type picklist (or will fallback)

    const topLine = `Order: #${orderId || "N/A"}`;
    const taskBodyLead = req.body?.body || "New order submission from Klaviyo";

    // Auth → SF
    const tok = await getSfToken();
    const H = { Authorization: `Bearer ${tok.access_token}` };

    // Find Contact, then Lead by email (for WhoId)
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

    // Pretty description (summary + full JSON)
    const pretty = [
      topLine,
      taskBodyLead,
      "",
      email ? `Customer Email: ${email}` : "",
      phone ? `Customer Phone: ${phone}` : "",
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

    // Base Task payload (Email/Phone fields exist on Task in your org)
    const baseTask = {
      Subject: SUBJECT_VALUE,         // fixed picklist
      Type: TYPE_VALUE,               // picklist; may be restricted
      Description: pretty,
      Status: "Completed",
      Priority: "Normal",
      ActivityDate: new Date().toISOString().slice(0,10), // YYYY-MM-DD (today)
      Email: email || undefined,
      Phone: phone || undefined,
      ...(whoId ? { WhoId: whoId } : {})
    };

    // Try create; if restricted picklist error, fallback & retry
    const createTask = async (payload) => {
      return axios.post(
        `${tok.instance_url}/services/data/${SF_API_VERSION}/sobjects/Task`,
        payload,
        { headers: H }
      );
    };

    let tr;
    try {
      tr = await createTask(baseTask);
    } catch (err) {
      const e = err?.response?.data;
      const isRestricted = Array.isArray(e)
        ? e.some(x => x?.errorCode === "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST")
        : false;

      if (!isRestricted) throw err;

      // Build a safe fallback (Subject 'Task', drop Type)
      const fallback = { ...baseTask, Subject: "Task" };
      delete fallback.Type;
      tr = await createTask(fallback);
    }

    res.json({
      ok: true,
      taskId: tr.data.id,
      linkedTo: whoId,
      subjectUsed: tr?.config?.data ? JSON.parse(tr.config.data).Subject : SUBJECT_VALUE
    });
  } catch (e) {
    console.error("Error pushing Task to Salesforce:", e?.response?.data || e);
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});
