// ==============================
// 🚀 ChangeWLD Backend v2.0 (Optimizado + World ID + Render)
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

// ========= CARGAR .ENV =========
dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = process.env.PORT || 4000;
const SPREAD = Number(process.env.SPREAD ?? "0.25");
const OPERATOR_PIN = process.env.OPERATOR_PIN || "4321";
const WALLET_DESTINO = process.env.WALLET_DESTINO || "";
const WORLD_APP_API_KEY = process.env.WORLD_APP_API_KEY;
console.log("API KEY CARGADA:", WORLD_APP_API_KEY ? "OK" : "NO DETECTADA");

// ==============================
// APP BASE
// ==============================
const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ==============================
// CORS
// ==============================
const allowedOrigins = [
  "http://localhost:5173",
  "https://changewld1.vercel.app",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ==============================
// STORAGE (orders.json)
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
app.get("/", (_, res) => res.send("🚀 ChangeWLD backend OK"));

// ==============================
// 🌐 API — World ID Real
// ==============================
app.post("/api/verify-world-id", async (req, res) => {
  try {
    const {
      proof,
      merkle_root,
      nullifier_hash,
      verification_level,
      credential_type,
      action,
      signal,
    } = req.body;

    if (!WORLD_APP_API_KEY) {
      console.error("WORLD_APP_API_KEY no está definido en el backend");
      return res
        .status(500)
        .json({ ok: false, error: "Missing WORLD_APP_API_KEY" });
    }

    if (!proof || !merkle_root || !nullifier_hash) {
      console.error("Payload incompleto recibido desde el frontend:", req.body);
      return res
        .status(400)
        .json({ ok: false, error: "Datos de prueba incompletos" });
    }

    const verifyURL = "https://developer.worldcoin.org/api/v1/verify";

    const payload = {
      proof,
      merkle_root,
      nullifier_hash,
      verification_level,
      credential_type: credential_type || "orb",
      action: action || "verify-changewld",
      signal: signal || "changewld",
    };

    console.log("Enviando payload a Worldcoin /verify:", payload);

    const resp = await fetch(verifyURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WORLD_APP_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    console.log(
      "Respuesta de Worldcoin:",
      resp.status,
      JSON.stringify(data, null, 2)
    );

    if (resp.status === 200 && data.success) {
      return res.json({ ok: true, verified: true });
    } else {
      return res.status(400).json({
        ok: false,
        error: data.code || "Invalid proof",
        detail: data.detail || null,
      });
    }
  } catch (err) {
    console.error("World ID Error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Internal server error" });
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

    let wldUsd, usdCop;

    // Precio WLD/USDT en Binance
    try {
      const r = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT"
      );
      const j = await r.json();
      wldUsd = parseFloat(j.price);
    } catch (e) {
      console.error("Error obteniendo WLDUSDT de Binance:", e.message);
      wldUsd = 0.76;
    }

    // USD -> COP
    try {
      const r = await fetch(
        "https://api.exchangerate.host/latest?base=USD&symbols=COP"
      );
      const j = await r.json();
      usdCop = Number(j.rates.COP);
    } catch (e) {
      console.error("Error obteniendo USD->COP:", e.message);
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
    console.error("Error en /api/rate:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 📦 CREAR ORDEN
// ==============================
app.post("/api/orders", (req, res) => {
  try {
    const { nombre, correo, banco, titular, numero, montoWLD, montoCOP } =
      req.body;

    const bancosPermitidos = ["Nequi", "Llave Bre-B"];
    if (!bancosPermitidos.includes(banco)) {
      return res
        .status(400)
        .json({ ok: false, error: "Banco no permitido." });
    }

    const store = readStore();

    const ahora = new Date().toISOString();

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
      creada_en: ahora,
      actualizada_en: ahora,
      status_history: [{ at: ahora, to: "pendiente" }],
    };

    store.orders.unshift(nueva);
    writeStore(store);

    res.json({ ok: true, orden: nueva });
  } catch (err) {
    console.error("Error en POST /api/orders:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 📥 OBTENER ORDEN POR ID  (para el tracking del front)
// ==============================
app.get("/api/orders/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const store = readStore();
    const orden = store.orders.find((o) => o.id === id);
    if (!orden) {
      return res.status(404).json({ ok: false, error: "Orden no encontrada" });
    }
    res.json(orden);
  } catch (err) {
    console.error("Error en GET /api/orders/:id:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 📤 ADMIN — Obtener todas
// ==============================
app.get("/api/orders-admin", (req, res) => {
  const pin = req.query.pin;
  if (pin !== OPERATOR_PIN) {
    return res.status(403).json({ error: "PIN inválido" });
  }

  const store = readStore();
  res.json(store.orders);
});

// ==============================
// 🔄 CAMBIAR ESTADO
// ==============================
app.put("/api/orders/:id/estado", (req, res) => {
  try {
    const pin = req.body.pin;
    const estado = req.body.estado;

    if (pin !== OPERATOR_PIN) {
      return res.status(403).json({ error: "PIN inválido" });
    }

    const validos = [
      "pendiente",
      "enviada",
      "recibida_wld",
      "pagada",
      "rechazada",
    ];
    if (!validos.includes(estado)) {
      return res.status(400).json({ error: "Estado inválido" });
    }

    const store = readStore();
    const idx = store.orders.findIndex((o) => o.id === Number(req.params.id));

    if (idx === -1) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const orden = store.orders[idx];
    const ahora = new Date().toISOString();

    orden.estado = estado;
    orden.actualizada_en = ahora;
    orden.status_history.push({ at: ahora, to: estado });

    writeStore(store);

    res.json({ ok: true, orden });
  } catch (err) {
    console.error("Error en PUT /api/orders/:id/estado:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// START
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Backend listo en puerto ${PORT}`);
  console.log(`SPREAD: ${SPREAD}`);
  console.log(`Destino WLD: ${WALLET_DESTINO}`);
});
