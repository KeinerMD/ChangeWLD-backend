// ==============================
// 🚀 ChangeWLD Backend — versión estable 2025 (MiniKit)
// ==============================

import dotenv from "dotenv";
import path from "path";
import express from "express";
import helmet from "helmet";
import fs from "fs";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

// 🔹 IMPORTANTE: añadimos verifyCloudProof desde minikit-js
import { verifyCloudProof } from "@worldcoin/minikit-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = process.env.PORT || 4000;
const SPREAD = Number(process.env.SPREAD ?? "0.25");
const OPERATOR_PIN = process.env.OPERATOR_PIN || "4321";
const WALLET_DESTINO = process.env.WALLET_DESTINO || "";

// 🔹 NUEVO: APP_ID de tu app de Worldcoin Developer Portal
const APP_ID = process.env.APP_ID; // ej: app_fc346e88f08ed686748d6414d965f99

console.log("APP_ID:", APP_ID || "NO DEFINIDO");
console.log("SPREAD:", SPREAD);
console.log("Destino WLD:", WALLET_DESTINO);

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ==============================
// CORS (abierto para pruebas)
// ==============================
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ==============================
// STORAGE (ordenes) – (igual que ya lo tienes)
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
// 🌐 WORLD ID API (MiniKit verifyCloudProof)
// ==============================
app.post("/api/verify-world-id", async (req, res) => {
  try {
    if (!APP_ID) {
      return res
        .status(500)
        .json({ success: false, error: "APP_ID no configurado en el backend" });
    }

    const { payload, action, signal } = req.body;

    console.log("🔹 Body recibido en /api/verify-world-id:");
    console.log(JSON.stringify(req.body, null, 2));

    if (!payload || payload.status !== "success") {
      return res
        .status(400)
        .json({ success: false, error: "Payload inválido o incompleto" });
    }

    // Llamamos a verifyCloudProof tal como indica la docs
    const verifyRes = await verifyCloudProof(payload, APP_ID, action, signal);

    console.log("🔹 Resultado verifyCloudProof:", verifyRes);

    if (verifyRes.success) {
      // Aquí podrías marcar al usuario como verificado en BD, etc.
      return res.json({
        success: true,
        verifyRes,
      });
    } else {
      return res.status(400).json({
        success: false,
        verifyRes,
      });
    }
  } catch (err) {
    console.error("❌ Error interno en /api/verify-world-id:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Error interno",
    });
  }
});

// ==============================
// 💱 API RATE (Coingecko + fallback)
// ==============================
let cachedRate = null;
let lastFetchTime = 0;

app.get("/api/rate", async (_, res) => {
  try {
    const now = Date.now();
    // Cache por 60s
    if (cachedRate && now - lastFetchTime < 60_000) {
      return res.json({ ...cachedRate, cached: true });
    }

    // Valores por defecto (fallback)
    let wldUsd = 0.699;
    let usdCop = 3719;
    let wldCopBruto = wldUsd * usdCop;

    let wldFromFallback = true;
    let usdCopFromFallback = true;

    // -------- INTENTAR COINGECKO ----------
    try {
      const r = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=worldcoin-wld&vs_currencies=usd,cop"
      );
      const j = await r.json();

      // Esperamos algo como:
      // { "worldcoin-wld": { "usd": 2.13, "cop": 8000 } }
      const data = j["worldcoin-wld"];
      if (data && typeof data.usd === "number" && typeof data.cop === "number") {
        wldUsd = data.usd;
        wldCopBruto = data.cop;
        usdCop = wldCopBruto / wldUsd;

        wldFromFallback = false;
        usdCopFromFallback = false;

        console.log("✅ Coingecko WLD_USD:", wldUsd, "WLD_COP:", wldCopBruto);
      } else {
        console.log("⚠️ Respuesta inesperada de Coingecko:", j);
      }
    } catch (err) {
      console.log("⚠️ Error llamando a Coingecko:", err.message);
    }

    // -------- CÁLCULO PARA EL USUARIO ----------
    const usuario = wldCopBruto * (1 - SPREAD);

    cachedRate = {
      ok: true,
      wld_usd: wldUsd,
      usd_cop: usdCop,
      wld_cop_bruto: wldCopBruto,
      wld_cop_usuario: usuario,
      spread_percent: SPREAD * 100,
      wld_from_fallback: wldFromFallback,
      usd_cop_from_fallback: usdCopFromFallback,
    };

    lastFetchTime = now;
    return res.json(cachedRate);
  } catch (err) {
    console.error("❌ Fatal en /api/rate:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Rate fatal", detail: err.message });
  }
});


// ==============================
// 📦 CREAR ORDEN
// ==============================
app.post("/api/orders", (req, res) => {
  try {
    const { banco, titular, numero, montoWLD, montoCOP, verified, nullifier } = req.body;

    const bancosPermitidos = ["Nequi", "Llave Bre-B"];
    if (!bancosPermitidos.includes(banco)) {
      return res.status(400).json({ ok: false, error: "Banco no permitido" });
    }

    // 👇 Seguridad extra: no crear órdenes sin verificación World ID
    if (!verified || !nullifier) {
      return res.status(400).json({
        ok: false,
        error: "Orden sin verificación World ID",
      });
    }

    const store = readStore();

    const ahora = new Date().toISOString();
    const nueva = {
      id: ++store.lastId,
      banco,
      titular,
      numero,
      montoWLD: Number(montoWLD),
      montoCOP: Number(montoCOP),

      // 🔒 Datos de verificación
      verified: Boolean(verified),
      nullifier: String(nullifier),

      estado: "pendiente",
      creada_en: ahora,
      actualizada_en: ahora,
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
