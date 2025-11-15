// ==============================
// 🚀 ChangeWLD Backend — versión estable 2025 (DEVICE)
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
// CORS (ABIERTO PARA PRUEBAS)
// ==============================
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Para este proyecto, dejamos CORS abierto para cualquier origen.
  // Así funciona tanto desde Vercel como desde el webview de World App.
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
  } else {
    // Peticiones sin cabecera Origin (algunos entornos) → permitir todas
    res.header("Access-Control-Allow-Origin", "*");
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


// ==============================
// STORAGE (ordenes)
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

    console.log("🔹 Body recibido en /api/verify-world-id:", req.body);

    if (!WORLD_APP_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing WORLD_APP_API_KEY" });
    }

    if (!proof || !merkle_root || !nullifier_hash || !action) {
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

    console.log("🔹 Enviando a Worldcoin verify v2:", payload);

    const resp = await fetch(verifyURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WORLD_APP_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    console.log("🔹 Respuesta de Worldcoin verify:", resp.status, data);

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
    console.error("❌ World ID Error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal server error" });
  }
});

// ==============================
// 💱 API RATE (versión mejorada con flags)
// ==============================
let cachedRate = null;
let lastFetchTime = 0;

app.get("/api/rate", async (_, res) => {
  try {
    const now = Date.now();
    // Cache 60 s
    if (cachedRate && now - lastFetchTime < 60_000) {
      return res.json({ ...cachedRate, cached: true });
    }

    let wldUsd = 0.76;
    let usdCop = 4000;
    let wldFromFallback = true;
    let usdCopFromFallback = true;

    // --- Precio WLD/USDT ---
    try {
      const r = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT"
      );
      const j = await r.json();
      if (j && j.price) {
        wldUsd = parseFloat(j.price);
        wldFromFallback = false;
      } else {
        console.log("Respuesta inesperada de Binance WLDUSDT:", j);
      }
    } catch (err) {
      console.log("Error WLDUSDT, usando fallback:", err.message);
    }

    // --- USD -> COP ---
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      const j = await r.json();
      if (j && j.rates && j.rates.COP) {
        usdCop = Number(j.rates.COP);
        usdCopFromFallback = false;
      } else {
        console.log("ER-API devolvió formato inesperado:", j);
      }
    } catch (err) {
      console.log("Error USD->COP, usando fallback:", err.message);
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
      wld_from_fallback: wldFromFallback,
      usd_cop_from_fallback: usdCopFromFallback,
    };

    lastFetchTime = now;
    res.json(cachedRate);
  } catch (err) {
    console.error("Fatal en /api/rate:", err);
    res
      .status(500)
      .json({ ok: false, error: "Rate fatal", detail: err.message });
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
// 📦 OBTENER ORDEN POR ID (para refrescar estado en el front)
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 🛠 ADMIN — Listar todas las órdenes (usado por /admin del front)
// ==============================
// El front llama a /api/orders-admin?pin=XXXX
app.get("/api/orders-admin", (req, res) => {
  try {
    const pin = req.query.pin;
    if (pin !== OPERATOR_PIN) {
      return res.status(403).json({ ok: false, error: "PIN inválido" });
    }

    const store = readStore();
    res.json(store.orders);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ==============================
// 🛠 ADMIN — Cambiar estado de una orden
// ==============================
app.put("/api/orders/:id/estado", (req, res) => {
  try {
    const pin = req.body.pin;
    const estado = req.body.estado;

    if (pin !== OPERATOR_PIN) {
      return res.status(403).json({ ok: false, error: "PIN inválido" });
    }

    const validos = ["pendiente", "enviada", "recibida_wld", "pagada", "rechazada"];
    if (!validos.includes(estado)) {
      return res.status(400).json({ ok: false, error: "Estado inválido" });
    }

    const store = readStore();
    const idx = store.orders.findIndex((o) => o.id === Number(req.params.id));

    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Orden no encontrada" });
    }

    const orden = store.orders[idx];
    orden.estado = estado;
    orden.actualizada_en = new Date().toISOString();
    if (!Array.isArray(orden.status_history)) {
      orden.status_history = [];
    }
    orden.status_history.push({ at: new Date().toISOString(), to: estado });

    writeStore(store);
    res.json({ ok: true, orden });
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
