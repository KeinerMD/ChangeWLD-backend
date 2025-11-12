// ==============================
// 🚀 ChangeWLD Backend v1.0 (estable para Render + Vercel)
// ==============================

import dotenv from "dotenv";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "fs";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env
dotenv.config({ path: path.resolve(__dirname, ".env") });

// ========= CONFIG =========
const PORT = Number(process.env.PORT || 4000);
const TEST_MODE = (process.env.TEST_MODE || "true").toLowerCase() === "true";
// Comisión por defecto 25% si no está en .env
const SPREAD = Number(process.env.SPREAD ?? "0.25");
const OPERATOR_PIN = (process.env.OPERATOR_PIN || "4321").trim();
const WALLET_DESTINO = (process.env.WALLET_DESTINO || "").trim();

// (opcionales para futura fase on-chain)
const WORLDCHAIN_RPC = process.env.WORLDCHAIN_RPC || "";
const KEYSTORE_PATH = process.env.KEYSTORE_PATH || "";
const KEYSTORE_PASSWORD = process.env.KEYSTORE_PASSWORD || "";
const WLD_TOKEN_ADDRESS = (process.env.WLD_TOKEN_ADDRESS || "").trim();

const app = express();
const agent = new https.Agent({ rejectUnauthorized: false });

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ========= CORS (Vercel + local) =========
// Asegúrate de poner aquí SOLO tus dominios reales de producción.
const allowedOrigins = [
  "http://localhost:5173",             // desarrollo local
  "https://changewld1.vercel.app",     // producción (Vercel)
  "https://changewld-backend-1.onrender.com" // Render backend (para pruebas internas)
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("🚫 Bloqueado por CORS:", origin);
        callback(new Error("No permitido por CORS"));
      }
    },
    methods: ["GET", "POST", "PUT"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use((req, res, next) => {
  // Manejo manual de preflight para mayor compatibilidad
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(
  cors({
    origin: (origin, cb) =>
      !origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error("CORS bloqueado")),
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ========= LOG ARRANQUE =========
console.log("🟢 ChangeWLD iniciando...");
console.log("🔐 PIN operador:", OPERATOR_PIN);
console.log("🌍 Orígenes permitidos:", allowedOrigins.join(", "));
console.log("💰 SPREAD:", SPREAD);

// ========= STORAGE =========
const ORDERS_FILE = path.join(__dirname, "orders.json");

function ensureOrdersFile() {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(
      ORDERS_FILE,
      JSON.stringify({ orders: [], lastId: 0 }, null, 2)
    );
    console.log("🆕 Archivo orders.json creado.");
  }
}

function readStore() {
  ensureOrdersFile();
  try {
    const data = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.orders)) {
      return { orders: [], lastId: 0 };
    }
    return data;
  } catch (e) {
    console.error("⚠️ Error leyendo orders.json:", e.message);
    return { orders: [], lastId: 0 };
  }
}

function writeStore(data) {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("❌ Error escribiendo orders.json:", e.message);
  }
}

// ========= ENDPOINTS BÁSICOS =========
app.get("/", (_, res) => res.send("🚀 ChangeWLD backend v1.0 OK"));

app.get("/api/health", (_, res) =>
  res.json({ ok: true, test_mode: TEST_MODE, now: new Date().toISOString() })
);

app.get("/api/config", (_, res) =>
  res.json({
    walletDestino: WALLET_DESTINO,
    spreadPercent: SPREAD * 100,
    testMode: TEST_MODE,
    rpcUrl: WORLDCHAIN_RPC || null,
    wldToken: WLD_TOKEN_ADDRESS || null,
  })
);

// ========= /api/rate (Cache + Binance + ExchangeRate + Fallback) =========
let cachedRate = null;
let lastFetchTime = 0;

app.get("/api/rate", async (_, res) => {
  try {
    const now = Date.now();
    const CACHE_TTL = 60_000; // 1 minuto

    if (cachedRate && now - lastFetchTime < CACHE_TTL) {
      console.log("🟢 /api/rate desde caché");
      return res.json({ ...cachedRate, cached: true });
    }

    console.log("📡 Consultando Binance + ExchangeRate.host...");

    let wldUsd = null;
    let usdCop = null;

    // Binance: WLD/USDT
    try {
      const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT", {
        agent,
        timeout: 6000,
      });
      if (r.ok) {
        const j = await r.json();
        wldUsd = parseFloat(j?.price);
        console.log("✅ WLD/USDT:", wldUsd);
      } else {
        console.warn("⚠️ Binance status:", r.status);
      }
    } catch (e) {
      console.warn("⚠️ Binance error:", e.message);
    }

    // ExchangeRate.host: USD->COP
    try {
      const r = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=COP", {
        agent,
        timeout: 6000,
      });
      if (r.ok) {
        const j = await r.json();
        usdCop = Number(j?.rates?.COP);
        console.log("✅ USD→COP:", usdCop);
      } else {
        console.warn("⚠️ FX status:", r.status);
      }
    } catch (e) {
      console.warn("⚠️ FX error:", e.message);
    }

    // Fallbacks
    if (!Number.isFinite(wldUsd)) {
      // si falla, usa aproximado de mercado
      wldUsd = 0.76;
      console.log("🔁 fallback WLD/USD =", wldUsd);
    }
    if (!Number.isFinite(usdCop)) {
      usdCop = 3700;
      console.log("🔁 fallback USD/COP =", usdCop);
    }

    const wldCopBruto = wldUsd * usdCop;
    const wldCopUsuario = wldCopBruto * (1 - SPREAD);

    const ratePayload = {
      ok: true,
      wld_usd: Number(wldUsd.toFixed(6)),
      usd_cop: Number(usdCop.toFixed(2)),
      wld_cop_bruto: Number(wldCopBruto.toFixed(2)),
      wld_cop_usuario: Number(wldCopUsuario.toFixed(2)),
      spread_percent: SPREAD * 100,
      fuente: "Binance + ExchangeRate.host (cache y fallback)",
      fecha: new Date().toISOString(),
    };

    cachedRate = ratePayload;
    lastFetchTime = now;

    console.log("✅ /api/rate actualizado:", ratePayload);
    res.json(ratePayload);
  } catch (err) {
    console.error("💥 /api/rate error:", err.message);
    res.status(500).json({ ok: false, error: "Error obteniendo tasa", detalle: err.message });
  }
});

// ========= ÓRDENES =========
app.post("/api/orders", (req, res) => {
  try {
    const { nombre, correo, banco, titular, numero, montoWLD, montoCOP } = req.body;
    if (!nombre || !correo || !banco || !titular || !numero || !montoWLD || !montoCOP) {
      return res.status(400).json({ ok: false, error: "Campos incompletos" });
    }

    const store = readStore();
    const nueva = {
      id: ++store.lastId,
      nombre: String(nombre).trim(),
      correo: String(correo).trim(),
      banco: String(banco).trim(),
      titular: String(titular).trim(),
      numero: String(numero).trim(),
      montoWLD: Number(montoWLD),
      montoCOP: Number(montoCOP),
      walletDestino: WALLET_DESTINO,
      estado: "pendiente",
      tx_hash: null,
      creada_en: new Date().toISOString(),
      actualizada_en: new Date().toISOString(),
      status_history: [{ at: new Date().toISOString(), to: "pendiente" }],
    };

    store.orders.unshift(nueva);
    writeStore(store);

    if (TEST_MODE) {
      // Simular avance de estado
      const refreshed = readStore();
      const idx = refreshed.orders.findIndex((o) => o.id === nueva.id);
      if (idx !== -1) {
        refreshed.orders[idx].estado = "enviada";
        refreshed.orders[idx].tx_hash = `SIMULATED_TX_${Date.now()}`;
        refreshed.orders[idx].status_history.push({
          at: new Date().toISOString(),
          to: "enviada",
        });
        refreshed.orders[idx].actualizada_en = new Date().toISOString();
        writeStore(refreshed);
      }
    }

    const finalStore = readStore();
    const finalOrder = finalStore.orders.find((o) => o.id === nueva.id);
    res.json({ ok: true, orden: finalOrder });
  } catch (e) {
    console.error("❌ create order:", e.message);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

app.get("/api/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const store = readStore();
  const orden = store.orders.find((o) => o.id === id);
  if (!orden) return res.status(404).json({ error: "Orden no encontrada" });
  res.json(orden);
});

app.get("/api/orders-admin", (req, res) => {
  const pin = (req.query.pin || "").trim();
  if (pin !== OPERATOR_PIN) return res.status(403).json({ error: "PIN inválido" });

  const store = readStore();
  res.json(store.orders);
});

app.put("/api/orders/:id/estado", (req, res) => {
  const pin = (req.body?.pin || "").trim();
  if (pin !== OPERATOR_PIN) return res.status(403).json({ error: "PIN inválido" });

  const id = Number(req.params.id);
  const estado = (req.body?.estado || "").trim();

  const validos = ["pendiente", "enviada", "recibida_wld", "pagada", "rechazada"];
  if (!validos.includes(estado)) return res.status(400).json({ error: "Estado inválido" });

  const store = readStore();
  const idx = store.orders.findIndex((o) => o.id === id);
  if (idx === -1) return res.status(404).json({ error: "Orden no encontrada" });

  const orden = store.orders[idx];
  if (!Array.isArray(orden.status_history)) orden.status_history = [];

  orden.estado = estado;
  orden.status_history.push({ at: new Date().toISOString(), to: estado });
  orden.actualizada_en = new Date().toISOString();

  if (estado === "pagada" && !orden.tx_hash) {
    orden.tx_hash = `TX_CONFIRMED_${Date.now()}`;
  }

  store.orders[idx] = orden;
  writeStore(store);

  console.log(`✅ Orden #${id} -> ${estado}`);
  res.json({ ok: true, orden });
});

// ========= 404 =========
app.use((_, res) => res.status(404).json({ error: "Ruta no encontrada" }));

// ========= START =========
app.listen(PORT, () => {
  console.log(`🚀 Backend listo en puerto ${PORT} (TEST_MODE=${TEST_MODE})`);
});
