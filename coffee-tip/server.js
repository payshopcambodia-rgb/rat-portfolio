"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const {
  BAKONG_API_TOKEN,
  BAKONG_ACCOUNT = "chheak_narat@bkrt",
  MERCHANT_NAME = "NARAT CHHEAK",
  MERCHANT_CITY = "Phnom Penh",
  PORT = 3000,
} = process.env;

if (!BAKONG_API_TOKEN) {
  console.warn("[warn] BAKONG_API_TOKEN is not set. /api/generate-qr will fail until it is configured.");
}

const BAKONG_BASE = "https://api-bakong.nbc.gov.kh/v1";
const SESSION_TTL_MS = 3 * 60 * 1000;          // 3 minutes — QR validity
const SESSION_CLEANUP_AGE_MS = 10 * 60 * 1000; // 10 minutes — purge cutoff
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;     // every 5 minutes

const sessions = new Map(); // md5 -> { md5, amount, currency, note, createdAt, status, qrString }

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Pretty URL: /tip -> public/tip.html
app.get("/tip", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "tip.html"));
});

const bakong = axios.create({
  baseURL: BAKONG_BASE,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${BAKONG_API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

/* ---------- helpers ---------- */
function shortBillNumber() {
  return "TIP" + Date.now().toString().slice(-8) + uuidv4().slice(0, 4).toUpperCase();
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function bakongErrorMessage(err) {
  if (err.response) {
    const { status, data } = err.response;
    return `Bakong API ${status}: ${typeof data === "string" ? data : JSON.stringify(data)}`;
  }
  if (err.code === "ECONNABORTED") return "Bakong API timed out. Please try again.";
  return err.message || "Unknown Bakong API error";
}

/* ---------- POST /api/generate-qr ---------- */
app.post("/api/generate-qr", async (req, res) => {
  try {
    const { amount, currency, note } = req.body || {};

    const amt = safeNumber(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number." });
    }
    if (!["USD", "KHR"].includes(currency)) {
      return res.status(400).json({ error: "Currency must be USD or KHR." });
    }
    if (!BAKONG_API_TOKEN) {
      return res.status(500).json({ error: "Server is not configured (missing BAKONG_API_TOKEN)." });
    }

    const billNumber = shortBillNumber();
    const cleanNote = (typeof note === "string" ? note : "").slice(0, 80);

    const payload = {
      bakongAccountId: BAKONG_ACCOUNT,
      merchantName: MERCHANT_NAME,
      merchantCity: MERCHANT_CITY,
      amount: amt,
      currency,
      terminalLabel: "Coffee Tip",
      billNumber,
      storeLabel: "Buy Me a Coffee",
      mobileNumber: "",
      accountInformation: "",
    };

    const { data } = await bakong.post("/generate_static_khqr", payload);

    // Bakong responses are typically: { responseCode: 0, responseMessage, data: { qr, md5 } }
    const ok = data && (data.responseCode === 0 || data.responseCode === "0");
    const inner = data && (data.data || data);
    const qrString = inner && (inner.qr || inner.qrString || inner.khqr);
    const md5 = inner && (inner.md5 || inner.md5Hash);

    if (!ok || !qrString || !md5) {
      return res.status(502).json({
        error: "Bakong returned an unexpected response.",
        detail: data && data.responseMessage,
      });
    }

    // Render QR string to a base64 PNG.
    const qrBase64 = await QRCode.toDataURL(qrString, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 360,
      color: { dark: "#4B3F6B", light: "#FFFFFF" },
    });

    const createdAt = Date.now();
    sessions.set(md5, {
      md5,
      amount: amt,
      currency,
      note: cleanNote,
      createdAt,
      status: "pending",
      qrString,
      billNumber,
    });

    return res.json({
      qrBase64,
      md5,
      amount: amt,
      currency,
      expiresAt: createdAt + SESSION_TTL_MS,
    });
  } catch (err) {
    console.error("[generate-qr] error:", bakongErrorMessage(err));
    return res.status(502).json({ error: "Failed to generate QR. Please try again." });
  }
});

/* ---------- GET /api/check-payment/:md5 ---------- */
app.get("/api/check-payment/:md5", async (req, res) => {
  const { md5 } = req.params;
  const session = sessions.get(md5);

  if (!session) {
    return res.status(404).json({ status: "unknown", error: "Session not found." });
  }

  if (session.status === "paid") {
    return res.json({
      status: "paid",
      amount: session.amount,
      currency: session.currency,
    });
  }

  const age = Date.now() - session.createdAt;
  if (age > SESSION_TTL_MS) {
    session.status = "expired";
    return res.json({ status: "expired" });
  }

  try {
    const { data } = await bakong.post("/check_transaction_by_md5", { md5 });

    // Two common shapes seen in Bakong API:
    //   Paid:    { responseCode: 0, data: { hash, ... } }
    //   Pending: { responseCode: 1, responseMessage: "Transaction could not be found", data: null }
    const found =
      data &&
      data.responseCode === 0 &&
      data.data &&
      typeof data.data === "object" &&
      Object.keys(data.data).length > 0;

    if (found) {
      session.status = "paid";
      return res.json({
        status: "paid",
        amount: session.amount,
        currency: session.currency,
      });
    }

    return res.json({ status: "pending" });
  } catch (err) {
    console.error("[check-payment] error:", bakongErrorMessage(err));
    // Don't fail the client — keep them polling.
    return res.json({ status: "pending", warning: "check_failed" });
  }
});

/* ---------- GET /health ---------- */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ---------- session cleanup ---------- */
setInterval(() => {
  const cutoff = Date.now() - SESSION_CLEANUP_AGE_MS;
  let removed = 0;
  for (const [md5, s] of sessions) {
    if (s.createdAt < cutoff) {
      sessions.delete(md5);
      removed++;
    }
  }
  if (removed) console.log(`[cleanup] purged ${removed} stale session(s). active=${sessions.size}`);
}, CLEANUP_INTERVAL_MS).unref();

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`☕ coffee-tip listening on http://localhost:${PORT}`);
  console.log(`   merchant: ${MERCHANT_NAME} (${BAKONG_ACCOUNT})`);
});
