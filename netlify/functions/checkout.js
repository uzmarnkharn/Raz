// Creates a Stripe Checkout session for an order.
// Prices are read from public/config.json here on the server, so a customer cannot change what they pay.
const config = require("../../public/config.json");

const SLOT_MIN = 17 * 60; // 5pm
const SLOT_MAX = 22 * 60; // 10pm

function reply(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
}

function money(p) {
  return "£" + (p / 100).toFixed(2);
}

function londonNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return {
    date: g("year") + "-" + g("month") + "-" + g("day"),
    minutes: (Number(g("hour")) % 24) * 60 + Number(g("minute"))
  };
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function unitPrice(kind, key) {
  const p = config.prices;
  if (kind === "cake") return p.cake;
  if (kind === "sundae") return p.sundae;
  if (kind === "tray") return p.tray;
  if (kind === "cone" && Object.prototype.hasOwnProperty.call(p.cones, key)) return p.cones[key];
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed." });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error("STRIPE_SECRET_KEY is not set");
    return reply(500, { error: "Payments are not set up yet. Please try again later." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Bad request." }); }

  // ---- items and total (priced on the server) ----
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length < 1 || rawItems.length > 20) return reply(400, { error: "Please add between 1 and 20 items." });

  const items = [];
  let total = 0;
  for (const it of rawItems) {
    const price = unitPrice(it && it.kind, it && it.key);
    if (price == null) return reply(400, { error: "One of the items in your order is no longer on the menu." });
    items.push({ name: clean(it.text, 120) || "Item", notes: clean(it.notes, 140), price });
    total += price;
  }
  if (total < config.minOrder) return reply(400, { error: "Minimum order is " + money(config.minOrder) + "." });

  // ---- customer and delivery ----
  const c = body.customer || {};
  const cust = {
    name: clean(c.name, 80), phone: clean(c.phone, 30), address: clean(c.address, 250),
    postcode: clean(c.postcode, 12), date: clean(c.date, 10), time: clean(c.time, 5), extra: clean(c.extra, 300)
  };
  if (!cust.name || !cust.phone || !cust.address || !cust.postcode) {
    return reply(400, { error: "Please fill in your name, phone number and address." });
  }

  const now = londonNow();
  const lastDay = addDays(now.date, config.maxDaysAhead);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cust.date) || cust.date < now.date || cust.date > lastDay) {
    return reply(400, { error: "Please pick a delivery day from today up to " + config.maxDaysAhead + " days ahead." });
  }
  if (config.closedDates.includes(cust.date) || config.closedWeekdays.includes(weekday(cust.date))) {
    return reply(400, { error: "Sorry, we're closed on that day. Please pick another date." });
  }
  const tm = /^(\d{2}):(\d{2})$/.exec(cust.time);
  const mins = tm ? Number(tm[1]) * 60 + Number(tm[2]) : -1;
  if (mins < SLOT_MIN || mins > SLOT_MAX || mins % 15 !== 0) {
    return reply(400, { error: "Please choose a delivery time between 5pm and 10pm." });
  }
  if (cust.date === now.date && mins < now.minutes) {
    return reply(400, { error: "That time has already passed. Please choose a later time." });
  }

  // ---- order summary, split into chunks for Stripe metadata (500 characters each) ----
  const lines = items.map((it, i) => (i + 1) + ". " + it.name + " (" + money(it.price) + ")" + (it.notes ? " - Notes: " + it.notes : ""));
  const chunks = [""];
  for (const line of lines) {
    const last = chunks.length - 1;
    if ((chunks[last] + "\n" + line).length <= 490) chunks[last] = chunks[last] ? chunks[last] + "\n" + line : line;
    else chunks.push(line.slice(0, 490));
  }

  const siteUrl = process.env.URL || ("https://" + (event.headers["x-forwarded-host"] || event.headers.host));

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("locale", "en-GB");
  params.set("success_url", siteUrl + "/?paid=1");
  params.set("cancel_url", siteUrl + "/?cancelled=1");
  params.set("expires_at", String(Math.floor(Date.now() / 1000) + 45 * 60));

  items.forEach((it, i) => {
    params.set("line_items[" + i + "][quantity]", "1");
    params.set("line_items[" + i + "][price_data][currency]", "gbp");
    params.set("line_items[" + i + "][price_data][unit_amount]", String(it.price));
    params.set("line_items[" + i + "][price_data][product_data][name]", it.name);
    if (it.notes) params.set("line_items[" + i + "][price_data][product_data][description]", "Notes: " + it.notes);
  });

  const meta = {
    name: cust.name, phone: cust.phone, address: cust.address, postcode: cust.postcode,
    delivery_date: cust.date, delivery_time: cust.time, extra: cust.extra
  };
  Object.keys(meta).forEach((k) => {
    if (meta[k]) {
      params.set("metadata[" + k + "]", meta[k]);
      if (k !== "extra") params.set("payment_intent_data[metadata][" + k + "]", meta[k]);
    }
  });
  chunks.slice(0, 3).forEach((ch, i) => params.set("metadata[order_" + (i + 1) + "]", ch));
  params.set("payment_intent_data[description]", "Raz’s Super Whippy: " + cust.name + ", " + cust.date + " " + cust.time);

  let res, data;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + secretKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    data = await res.json();
  } catch (e) {
    console.error("Stripe request failed", e);
    return reply(502, { error: "We couldn't reach the payment service. Please try again." });
  }
  if (!res.ok || !data.url) {
    console.error("Stripe error", JSON.stringify(data));
    return reply(502, { error: "We couldn't start your payment. Please try again." });
  }
  return reply(200, { url: data.url });
};
