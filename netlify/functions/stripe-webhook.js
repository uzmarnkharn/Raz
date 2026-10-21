// Stripe calls this after a customer has paid. It checks the call really came from Stripe,
// then files the order in Netlify Forms, which is what sends you the order email.
const crypto = require("crypto");

function verify(raw, header, secret) {
  const parts = String(header || "").split(",").map((kv) => kv.split("="));
  const t = (parts.find((p) => p[0] === "t") || [])[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

exports.handler = async (event) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return { statusCode: 500, body: "Not configured" };
  }

  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (!verify(raw, event.headers["stripe-signature"], secret)) {
    return { statusCode: 400, body: "Bad signature" };
  }

  let evt;
  try { evt = JSON.parse(raw); } catch (e) { return { statusCode: 400, body: "Bad JSON" }; }

  if (evt.type !== "checkout.session.completed" && evt.type !== "checkout.session.async_payment_succeeded") {
    return { statusCode: 200, body: "Ignored" };
  }
  const s = evt.data.object;
  if (s.payment_status !== "paid") return { statusCode: 200, body: "Not paid yet" };

  const m = s.metadata || {};
  const order = [m.order_1, m.order_2, m.order_3].filter(Boolean).join("\n");
  const form = new URLSearchParams({
    "form-name": "order",
    order: order,
    total: "£" + (s.amount_total / 100).toFixed(2),
    payment_status: "PAID",
    stripe_ref: s.payment_intent || s.id,
    name: m.name || "",
    phone: m.phone || "",
    email: (s.customer_details && s.customer_details.email) || "",
    address: m.address || "",
    postcode: m.postcode || "",
    delivery_date: m.delivery_date || "",
    delivery_time: m.delivery_time || "",
    extra_notes: m.extra || ""
  });

  const siteUrl = process.env.URL || ("https://" + (event.headers["x-forwarded-host"] || event.headers.host));
  try {
    const r = await fetch(siteUrl + "/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    if (!r.ok) {
      console.error("Netlify Forms returned", r.status);
      return { statusCode: 500, body: "Form post failed" }; // Stripe will retry
    }
  } catch (e) {
    console.error("Form post error", e);
    return { statusCode: 500, body: "Form post failed" };
  }
  return { statusCode: 200, body: "OK" };
};
