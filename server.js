// ==============================
// 🚀 ChangeWLD Backend — MiniApp 2025 (v3 FINAL)
// Compatible con World App MiniApps
// ==============================

import dotenv from "dotenv";
import path from "path";
import express from "express";
import helmet from "helmet";
import fs from "fs";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = process.env.PORT || 4000;
const SPREAD = Number(process.env.SPREAD ?? "0.25");
const OPERATOR_PIN = process.env.OPERATOR_PIN || "4321";
const WALLET_DESTINO = process.env.WALLET_DESTINO || "";
const WORLD_APP_API_KEY = process.env.WORLD_APP_API_KEY;

console.log("API KEY CARGADA:", WORLD_APP_API_KEY ? "OK" : "ERROR");
console.log("SPREAD:", SPREAD);
console.log("Destino WLD:", WALLET_DESTINO);

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ==============================
// CORS
// ==============================
const allowedOrigins = [
  "http://localhost:5173",
  "https://changewld1.vercel.app",
  "https://changewld.vercel.app",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ==============================
// STORAGE
// ==============================
const ORDERS_FILE = path.join(__dirname, "orders.json");

function ensureOrdersFile() {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(
      ORDERS_FILE,
      JSON.stringify({ orders: [], lastId: 0 }, null, 2)
    );
  }
}

function readStore() {
  ensureOrdersFile();
  return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
}

function writeStore(data) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
}

// ==============================
// ROOT
// ==============================
app.get("/", (_, res) => res.send("🚀 ChangeWLD backend OK — MiniApp v3"));

// ==============================
// 🌐 WORLD ID API (device / mini app)
// ==============================
app.post("/api/verify-world-id", async (req, res) => {
  try {
    const {
      proof,
      merkle_root,
      nullifier_hash,
      verification_level,
      action,
      signal,
    } = req.body;

    if (!WORLD_APP_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing WORLD_APP_API_KEY" });
    }

    if (!proof || !merkle_root || !nullifier_hash || !action) {
      console.log("Body recibido en /api/verify-world-id:", req.body);
      return res.status(400).json({ ok: false, error: "Datos incompletos" });
    }

    const verifyURL = "https://developer.worldcoin.org/api/v2/verify";

    const payload = {
      proof,
      merkle_root,
      nullifier_hash,
      verification_level: verification_level || "device",
      action,
      signal: signal || "changewld",
    };

    console.log("Enviando a Worldcoin verify v2:", payload);

    const resp = await fetch(verifyURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WORLD_APP_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    console.log("Respuesta de Worldcoin verify:", resp.status, data);

    if (resp.status === 200 && data.success) {
      return res.json({ ok: true, verified: true });
    } else {
      return res.status(400).json({
        ok: false,
        verified: false,
        error: data.code || "Invalid proof",
        detail: data.detail || data,
      });
    }
  } catch (err) {
    console.error("World ID Error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});


// ==============================
// 💱 API RATE
// ==============================
let cachedRate = null;
let lastFetchTime = 0;

app.get("/api/rate", async (_, res) => {
  try {
    const now = Date.now();
    if (cachedRate && now - lastFetchTime < 60_000) {
      return res.json({ ...cachedRate, cached: true });
    }

    let wldUsd = 0.76;
    let usdCop = 4000;

    // --- WLD price
    try {
      const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT");
      const j = await r.json();
      if (j?.price) wldUsd = parseFloat(j.price);
    } catch (err) {
      console.log("Error WLDUSDT:", err.message);
    }

    // --- USD COP
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      const j = await r.json();
      if (j?.rates?.COP) usdCop = j.rates.COP;
    } catch (err) {
      console.log("Error USD->COP:", err.message);
    }

    const bruto = wldUsd * usdCop;
    const usuario = bruto * (1 - SPREAD);

    cachedRate = {
      ok: true,
      wld_usd: wldUsd,
      usd_cop: usdCop,
      wld_cop_bruto: bruto,
      wld_cop_usuario: usuario,
      spread_percent: SPREAD * 100,
    };

    lastFetchTime = now;
    res.json(cachedRate);
  } catch (err) {
    res.status(500).json({ ok: false, error: "Rate fatal" });
  }
});

// ==============================
// 📦 CREAR ORDEN
// ==============================
app.post("/api/orders", (req, res) => {
  try {
    const { banco, titular, numero, montoWLD, montoCOP } = req.body;

    const bancosPermitidos = ["Nequi", "Llave Bre-B"];
    if (!bancosPermitidos.includes(banco)) {
      return res.status(400).json({ ok: false, error: "Banco no permitido" });
    }

    const store = readStore();

    const nueva = {
      id: ++store.lastId,
      banco,
      titular,
      numero,
      montoWLD: Number(montoWLD),
      montoCOP: Number(montoCOP),
      estado: "pendiente",
      creada_en: new Date().toISOString(),
      actualizada_en: new Date().toISOString(),
    };

    store.orders.unshift(nueva);
    writeStore(store);

    res.json({ ok: true, orden: nueva });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// START
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Backend listo en puerto ${PORT}`);
});
