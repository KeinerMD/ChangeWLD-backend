// ==============================
// 🚀 ChangeWLD Backend v1.0 (Optimizado + Nivel 3 Real)
// ==============================

import dotenv from "dotenv";
import path from "path";
import express from "express";
import helmet from "helmet";
import fs from "fs";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========= CARGAR .ENV =========
dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = Number(process.env.PORT || 4000);
const TEST_MODE = (process.env.TEST_MODE || "true").toLowerCase() === "true";
const SPREAD = Number(process.env.SPREAD ?? "0.25");
const OPERATOR_PIN = (process.env.OPERATOR_PIN || "4321").trim();
const WALLET_DESTINO = (process.env.WALLET_DESTINO || "").trim();

const app = express();
const agent = new https.Agent({ rejectUnauthorized: false });

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ==============================
// CORS PROFESIONAL
// ==============================
const allowedOrigins = [
  "http://localhost:5173",
  "https://changewld1.vercel.app",
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
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch {
    return { orders: [], lastId: 0 };
  }
}

function writeStore(data) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
}

// ==============================
// ENDPOINTS BASE
// ==============================
app.get("/", (_, res) => res.send("🚀 ChangeWLD backend running OK"));

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

    let wldUsd, usdCop;

    // Binance
    try {
      const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT");
      const j = await r.json();
      wldUsd = parseFloat(j.price);
    } catch {
      wldUsd = 0.76;
    }

    // FX
    try {
      const r = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=COP");
      const j = await r.json();
      usdCop = Number(j.rates.COP);
    } catch {
      usdCop = 3700;
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 📦 CREAR ORDEN
// ==============================
app.post("/api/orders", (req, res) => {
  try {
    const { nombre, correo, banco, titular, numero, montoWLD, montoCOP } = req.body;

    const bancosPermitidos = ["Nequi", "Llave Bre-B"];
    if (!bancosPermitidos.includes(banco)) {
      return res.status(400).json({
        ok: false,
        error: "Banco no permitido.",
      });
    }

    const store = readStore();

    const nueva = {
      id: ++store.lastId,
      nombre,
      correo,
      banco,
      titular,
      numero,
      montoWLD: Number(montoWLD),
      montoCOP: Number(montoCOP),
      estado: "pendiente",
      tx_hash: null,
      creada_en: new Date().toISOString(),
      actualizada_en: new Date().toISOString(),
      status_history: [{ at: new Date().toISOString(), to: "pendiente" }],
    };

    store.orders.unshift(nueva);
    writeStore(store);

    res.json({ ok: true, orden: nueva });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 🔎 NIVEL 3 – DETECCIÓN REAL
// ==============================
const WORLDCHAIN_API = "https://worldchain-api.worldcoin.org";
let processedTxs = new Set();

async function getIncomingWLDTransfers() {
  try {
    const url = `${WORLDCHAIN_API}/wallet/${WALLET_DESTINO}/transfers?limit=20`;
    const resp = await fetch(url);
    const data = await resp.json();

    return data?.transfers?.filter(
      (tx) => tx.direction === "IN" && tx.token_symbol === "WLD"
    ) || [];

  } catch {
    return [];
  }
}

async function autoDetectWLD_Real() {
  const store = readStore();
  const pending = store.orders.filter((o) => o.estado === "pendiente");

  if (!pending.length) return;

  const transfers = await getIncomingWLDTransfers();
  if (!transfers.length) return;

  for (let order of pending) {
    const match = transfers.find(
      (tx) =>
        !processedTxs.has(tx.transaction_hash) &&
        Number(tx.amount) === Number(order.montoWLD)
    );

    if (match) {
      order.estado = "recibida_wld";
      order.tx_hash = match.transaction_hash;
      order.actualizada_en = new Date().toISOString();
      order.status_history.push({
        at: new Date().toISOString(),
        to: "recibida_wld",
      });

      processedTxs.add(match.transaction_hash);
    }
  }

  writeStore(store);
}

// cada 5s
setInterval(autoDetectWLD_Real, 5000);

// ==============================
// START
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Backend listo en puerto ${PORT}`);
});
