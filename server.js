// ==============================
// 🚀 ChangeWLD Backend v1.0
// Totalmente estable — compatible con Render + Vercel
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

const agent = new https.Agent({ rejectUnauthorized: false });

// ========= CARGA .ENV =========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

// ========= CONFIG BÁSICA =========
const PORT = Number(process.env.PORT || 4000);
const TEST_MODE = (process.env.TEST_MODE || "true").toLowerCase() === "true";
const SPREAD = Number(process.env.SPREAD || "0.15");
const OPERATOR_PIN = (process.env.OPERATOR_PIN || "4321").trim();
const WALLET_DESTINO = (process.env.WALLET_DESTINO || "").trim();

// ========= OPCIONAL =========
const WORLDCHAIN_RPC = process.env.WORLDCHAIN_RPC || "";
const KEYSTORE_PATH = process.env.KEYSTORE_PATH || "";
const KEYSTORE_PASSWORD = process.env.KEYSTORE_PASSWORD || "";
const WLD_TOKEN_ADDRESS = (process.env.WLD_TOKEN_ADDRESS || "").trim();

// ========= APP =========
const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ========= CONFIG CORS (✅ 100% compatible con Vercel + Render) =========
// ✅ CORS seguro y compatible con Vercel + local
const allowedOrigins = [
  "http://localhost:5173",              // desarrollo local
  "https://vercel.com/kaleths-projects-b5a556a1/change-wld-frontend-112k/24v1XqipQJ63uPc3Q1sGokKmwFUe",       // tu dominio en producción
  "https://changewld1.vercel.app",      // tu dominio alternativo o nuevo
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


// ========= LOG DE ARRANQUE =========
console.log("🟢 Iniciando servidor ChangeWLD...");
console.log("🔐 PIN del operador:", OPERATOR_PIN);
console.log("🌍 Orígenes permitidos:", allowedOrigins.join(", "));

// ----------------- STORAGE -----------------
const ORDERS_FILE = path.join(__dirname, "orders.json");

// ✅ Crear el archivo si no existe
function ensureOrdersFile() {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(JSON.stringify({ orders: [], lastId: 0 }, null, 2));
    console.log("🆕 Archivo orders.json creado automáticamente.");
  }
}

// ✅ Leer almacenamiento
function readStore() {
  ensureOrdersFile();
  try {
    const data = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
    return data && Array.isArray(data.orders) ? data : { orders: [], lastId: 0 };
  } catch (err) {
    console.error("⚠️ Error leyendo orders.json:", err.message);
    return { orders: [], lastId: 0 };
  }
}

// ✅ Guardar almacenamiento
function writeStore(data) {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Error escribiendo orders.json:", err.message);
  }
}

// ========= ENDPOINTS =========

// 🩺 Health Check
app.get("/api/health", (_, res) =>
  res.json({ ok: true, test_mode: TEST_MODE, now: new Date().toISOString() })
);

// 🧾 Config general
app.get("/api/config", (_, res) =>
  res.json({
    walletDestino: WALLET_DESTINO,
    spreadPercent: SPREAD * 100,
    testMode: TEST_MODE,
    rpcUrl: WORLDCHAIN_RPC || null,
    wldToken: WLD_TOKEN_ADDRESS || null,
  })
);

// ========= CACHE LOCAL DE TASA =========
let cachedRate = null;
let lastFetchTime = 0;

// 💱 Endpoint de tasa WLD→COP
// ========= TASA WLD → COP (Binance + ExchangeRate.host + Spread 25%) =========
app.get("/api/rate", async (_, res) => {
  try {
    console.log("📡 Solicitando tasa WLD→COP (Binance + ExchangeRate.host)");
    const SPREAD = 0.25;
    const agent = new https.Agent({ rejectUnauthorized: false });

    // 1️⃣ Obtener precio WLD/USDT desde Binance
    let wldUsd = null;
    try {
      const binanceResp = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT",
        { agent, timeout: 5000 }
      );
      if (binanceResp.ok) {
        const binanceData = await binanceResp.json();
        wldUsd = parseFloat(binanceData.price);
      } else {
        console.warn("⚠️ Binance devolvió status", binanceResp.status);
      }
    } catch (err) {
      console.warn("⚠️ Binance no accesible:", err.message);
    }

    // 2️⃣ Obtener tasa USD→COP desde ExchangeRate.host
    let usdCop = null;
    try {
      const fxResp = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=COP", {
        agent,
        timeout: 5000,
      });
      if (fxResp.ok) {
        const fxData = await fxResp.json();
        usdCop = Number(fxData?.rates?.COP);
      } else {
        console.warn("⚠️ ExchangeRate devolvió status", fxResp.status);
      }
    } catch (err) {
      console.warn("⚠️ ExchangeRate no accesible:", err.message);
    }

    // 3️⃣ Si alguno falló, usar fallback
    if (!Number.isFinite(wldUsd)) {
      wldUsd = 0.76; // valor aproximado actual en Binance
      console.warn("🔁 Fallback WLD/USD:", wldUsd);
    }
    if (!Number.isFinite(usdCop)) {
      usdCop = 3700; // valor aproximado actual
      console.warn("🔁 Fallback USD/COP:", usdCop);
    }

    // 4️⃣ Calcular tasa final
    const wldCopBruto = wldUsd * usdCop;
    const wldCopUsuario = wldCopBruto * (1 - SPREAD);

    const result = {
      ok: true,
      wld_usd: Number(wldUsd.toFixed(4)),
      usd_cop: Number(usdCop.toFixed(2)),
      wld_cop_bruto: Number(wldCopBruto.toFixed(2)),
      wld_cop_usuario: Number(wldCopUsuario.toFixed(2)),
      spread_percent: SPREAD * 100,
      fuente: "Binance + ExchangeRate.host (con fallback automático)",
      fecha: new Date().toISOString(),
    };

    console.log("✅ Tasa generada:", result);
    res.json(result);
  } catch (err) {
    console.error("💥 Error en /api/rate:", err.message);
    res.status(500).json({
      ok: false,
      error: "Error interno al obtener tasa",
      detalle: err.message,
    });
  }
});



// 🧾 Crear orden
app.post("/api/orders", (req, res) => {
  try {
    const { nombre, correo, banco, titular, numero, montoWLD, montoCOP } = req.body;
    if (!nombre || !correo || !banco || !titular || !numero || !montoWLD || !montoCOP)
      return res.status(400).json({ ok: false, error: "Campos incompletos" });

    const store = readStore();
    const nueva = {
      id: ++store.lastId,
      nombre, correo, banco, titular, numero,
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

    // Simulación en test mode
    if (TEST_MODE) {
      nueva.estado = "enviada";
      nueva.tx_hash = `SIMULATED_TX_${Date.now()}`;
      nueva.actualizada_en = new Date().toISOString();
      store.orders[0] = nueva;
      writeStore(store);
    }

    res.json({ ok: true, orden: nueva });
  } catch (err) {
    console.error("❌ Error creando orden:", err.message);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// 🔍 Obtener orden por ID
app.get("/api/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });
  const store = readStore();
  const orden = store.orders.find((o) => o.id === id);
  if (!orden) return res.status(404).json({ error: "Orden no encontrada" });
  res.json(orden);
});

// ⚙️ Admin: listar órdenes
app.get("/api/orders-admin", (req, res) => {
  const pin = (req.query.pin || "").trim();
  if (pin !== OPERATOR_PIN) return res.status(403).json({ error: "PIN inválido" });
  const store = readStore();
  res.json(store.orders);
});

// 🧩 Admin: cambiar estado
app.put("/api/orders/:id/estado", (req, res) => {
  const pin = (req.body?.pin || "").trim();
  if (pin !== OPERATOR_PIN) return res.status(403).json({ error: "PIN inválido" });
  const id = Number(req.params.id);
  const estado = (req.body?.estado || "").trim();

  const validos = ["pendiente", "enviada", "recibida_wld", "pagada", "rechazada"];
  if (!validos.includes(estado))
    return res.status(400).json({ error: "Estado inválido" });

  const store = readStore();
  const idx = store.orders.findIndex((o) => o.id === id);
  if (idx === -1) return res.status(404).json({ error: "Orden no encontrada" });

  const orden = store.orders[idx];
  orden.estado = estado;
  orden.status_history.push({ at: new Date().toISOString(), to: estado });
  orden.actualizada_en = new Date().toISOString();
  if (estado === "pagada" && !orden.tx_hash)
    orden.tx_hash = `TX_CONFIRMED_${Date.now()}`;
  store.orders[idx] = orden;
  writeStore(store);
  res.json({ ok: true, orden });
});

// ========= MIDDLEWARE 404 =========
app.use((_, res) => res.status(404).json({ error: "Ruta no encontrada" }));

// ========= START =========
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend listo en puerto ${PORT} (TEST_MODE=${TEST_MODE})`);
});
