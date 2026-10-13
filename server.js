
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

// Respect Aura - Product prices in USD
const PRODUCTS = {
  1: { name: "Blue Performance Sedan", priceUSD: 10 },
  2: { name: "Night Street Coupe", priceUSD: 10 },
  3: { name: "White Custom Sports", priceUSD: 10 },
  4: { name: "Black Luxury SUV", priceUSD: 10 },
  5: { name: "Ped 1", priceUSD: 14 },
  6: { name: "Ped 2", priceUSD: 14 },
  7: { name: "Ped 3", priceUSD: 14 },
  8: { name: "Ped 4", priceUSD: 20 },
  9: { name: "Ped 5", priceUSD: 14 },
  10: { name: "Ped 6", priceUSD: 14 },
  11: { name: "Ped 7", priceUSD: 14 },
  12: { name: "Ped 8", priceUSD: 14 },
  13: { name: "Tattoo Biker", priceUSD: 50 },
  14: { name: "Yellow Bandana", priceUSD: 50 },
  15: { name: "Premium Helicopter", priceUSD: 30 }
};

const orders = new Map();
const ORDER_TTL_MS = 30 * 60 * 1000;

function getConfig() {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  const mode = (process.env.PAYPAL_MODE || "sandbox").trim().toLowerCase();
  const currency = (process.env.PAYPAL_CURRENCY || "USD").trim().toUpperCase();

  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials are missing.");
  }

  if (!["sandbox", "live"].includes(mode)) {
    throw new Error("PAYPAL_MODE must be sandbox or live.");
  }

  if (currency !== "USD") {
    throw new Error("PAYPAL_CURRENCY must be USD.");
  }

  return {
    clientId,
    clientSecret,
    mode,
    currency,
    baseUrl:
      mode === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com"
  };
}

function calculateOrder(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 15) {
    throw new Error("Invalid cart.");
  }

  const quantities = new Map();

  for (const item of items) {
    const id = Number(item.id);
    const quantity = Number(item.quantity);

    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 20 ||
      !Object.hasOwn(PRODUCTS, id)
    ) {
      throw new Error("Invalid product or quantity.");
    }

    const newQuantity = (quantities.get(id) || 0) + quantity;

    if (newQuantity > 20) {
      throw new Error("Maximum quantity exceeded.");
    }

    quantities.set(id, newQuantity);
  }

  const lines = [...quantities.entries()].map(([id, quantity]) => ({
    id,
    name: PRODUCTS[id].name,
    quantity,
    priceUSD: PRODUCTS[id].priceUSD
  }));

  const totalCents = lines.reduce(
    (sum, item) =>
      sum + Math.round(item.priceUSD * 100) * item.quantity,
    0
  );

  const totalUSD = (totalCents / 100).toFixed(2);
  const currency = "USD";

  if (totalCents <= 0) {
    throw new Error("Invalid order total.");
  }

  return { lines, totalUSD, currency };
}

async function paypalRequest(endpoint, options = {}) {
  const config = getConfig();

  let tokenResponse;
  let tokenData;

  try {
    tokenResponse = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${config.clientId}:${config.clientSecret}`
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000)
    });

    const responseText = await tokenResponse.text();

    try {
      tokenData = JSON.parse(responseText);
    } catch {
      tokenData = {};
    }
  } catch (error) {
    console.error("PayPal OAuth connection error:", error.name);
    throw new Error("Could not connect to PayPal authentication.");
  }

  if (!tokenResponse.ok || !tokenData.access_token) {
    // Never log credentials or access tokens.
    console.error("PayPal OAuth error:", {
      status: tokenResponse.status,
      name: tokenData.error || "unknown_error",
      message: tokenData.error_description || "No error description"
    });

    throw new Error("PayPal authentication failed.");
  }

  let response;
  let data;

  try {
    response = await fetch(`${config.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(20000)
    });

    const responseText = await response.text();

    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }
  } catch (error) {
    console.error("PayPal API connection error:", error.name);
    throw new Error("Could not connect to PayPal API.");
  }

  if (!response.ok) {
    console.error("PayPal API error:", {
      status: response.status,
      name: data.name || "unknown_error",
      message: data.message || "No error message"
    });

    const error = new Error("PayPal API request failed.");
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

// PayPal SDK configuration for index.html
app.get("/api/paypal/config", (_req, res) => {
  try {
    const config = getConfig();

    res.set("Cache-Control", "no-store");
    res.json({
      clientId: config.clientId,
      currency: config.currency
    });
  } catch (error) {
    console.error("PayPal configuration error:", error.message);

    res.status(503).json({
      error: "PayPal is not configured on the server."
    });
  }
});

// Create PayPal order
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const order = calculateOrder(req.body?.items);

    const data = await paypalRequest("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "PayPal-Request-Id": crypto.randomUUID()
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: "respect-aura-order",
            description: "Respect Aura FiveM Store",
            custom_id: crypto.randomUUID(),
            amount: {
              currency_code: order.currency,
              value: order.totalUSD
            }
          }
        ]
      })
    });

    if (!data.id || data.status !== "CREATED") {
      throw new Error("PayPal did not create the expected order.");
    }

    orders.set(data.id, {
      ...order,
      status: "CREATED",
      createdAt: Date.now()
    });

    res.set("Cache-Control", "no-store");
    res.json({ id: data.id });
  } catch (error) {
    console.error("Create order error:", error.message);

    res.status(400).json({
      error: "Could not create PayPal order. Check server logs."
    });
  }
});

// Verify and capture PayPal payment
app.post("/api/paypal/capture-order", async (req, res) => {
  const orderID = req.body?.orderID;

  if (
    typeof orderID !== "string" ||
    !/^[A-Z0-9-]{5,100}$/i.test(orderID)
  ) {
    return res.status(400).json({ error: "Invalid order ID." });
  }

  const expected = orders.get(orderID);

  if (!expected) {
    return res.status(400).json({
      error: "Order not found, expired, or already processed."
    });
  }

  if (Date.now() - expected.createdAt > ORDER_TTL_MS) {
    orders.delete(orderID);

    return res.status(400).json({
      error: "Order expired. Please start checkout again."
    });
  }

  if (expected.status !== "CREATED") {
    return res.status(409).json({
      error: "This order is already being processed."
    });
  }

  expected.status = "CAPTURING";

  try {
    const existing = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderID)}`
    );

    const purchase = existing.purchase_units?.[0];

    if (
      existing.id !== orderID ||
      existing.intent !== "CAPTURE" ||
      !purchase ||
      purchase.reference_id !== "respect-aura-order" ||
      purchase.amount?.currency_code !== expected.currency ||
      purchase.amount?.value !== expected.totalUSD ||
      existing.status !== "APPROVED"
    ) {
      expected.status = "CREATED";

      return res.status(400).json({
        error: "PayPal order validation failed."
      });
    }

    const result = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
      {
        method: "POST",
        headers: {
          "PayPal-Request-Id": `capture-${orderID}`
        },
        body: JSON.stringify({})
      }
    );

    const capture =
      result.purchase_units?.[0]?.payments?.captures?.[0];

    if (
      result.id !== orderID ||
      result.status !== "COMPLETED" ||
      !capture ||
      capture.status !== "COMPLETED" ||
      capture.amount?.currency_code !== expected.currency ||
      capture.amount?.value !== expected.totalUSD
    ) {
      expected.status = "CAPTURE_REVIEW";

      return res.status(409).json({
        error: "Payment requires verification. Do not deliver products yet."
      });
    }

    expected.status = "COMPLETED";
    expected.captureID = capture.id;
    expected.completedAt = Date.now();

    console.log("Respect Aura payment completed:", {
      orderID,
      captureID: capture.id,
      totalUSD: expected.totalUSD
    });

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      status: "COMPLETED",
      orderID,
      captureID: capture.id
    });
  } catch (error) {
    console.error("Capture error:", error.message);

    if (expected.status === "CAPTURING") {
      expected.status = "CAPTURE_REVIEW";
    }

    res.status(502).json({
      error: "Payment confirmation could not be completed. Verify the order before retrying."
    });
  }
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Serve website files
app.use(express.static(__dirname));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Respect Aura server listening on port ${PORT}`);
});
