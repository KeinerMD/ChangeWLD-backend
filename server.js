// ==============================
// 🚀 ChangeWLD Backend — versión estable 2025 (MiniKit) + MongoDB + JWT admin
// ==============================

import dotenv from "dotenv";
import path from "path";
import express from "express";
import helmet from "helmet";
import fetch from "node-fetch";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
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
const MAX_ORDERS_PER_NULLIFIER_PER_DAY = Number(
  process.env.MAX_ORDERS_PER_NULLIFIER_PER_DAY || "3"
);

// 🔹 APP_ID de tu app de Worldcoin Developer Portal
const APP_ID = process.env.APP_ID;

// 🔹 MongoDB
const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || undefined;

// 🔹 JWT admin
const ADMIN_JWT_SECRET =
  process.env.ADMIN_JWT_SECRET || "DEV_SECRET_CAMBIA_ESTO_EN_PRODUCCION";

console.log("APP_ID:", APP_ID || "NO DEFINIDO");
console.log("SPREAD:", SPREAD);
console.log("Destino WLD:", WALLET_DESTINO);
console.log("MONGO_URI configurado:", !!MONGO_URI);
console.log(
  "ADMIN_JWT_SECRET configurado:",
  ADMIN_JWT_SECRET === "DEV_SECRET_CAMBIA_ESTO_EN_PRODUCCION" ? "DEFAULT" : "OK"
);

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ==============================
// CORS (abierto para pruebas + header de admin)
// ==============================
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://changewld1.vercel.app",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-admin-pin"
  );
  res.header("Access-Control-Max-Age", "600"); // cache del preflight

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ==============================
// MongoDB: conexión y modelos
// ==============================

if (!MONGO_URI) {
  console.warn(
    "⚠️ No se definió MONGO_URI en el .env. El backend NO podrá guardar órdenes en la base de datos."
  );
}

mongoose
  .connect(MONGO_URI, { dbName: MONGO_DB_NAME })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) =>
    console.error("❌ Error conectando a MongoDB:", err.message)
  );

const counterSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: Number, default: 0 },
});

const orderSchema = new mongoose.Schema({
  id: { type: Number, unique: true }, // id numérico que usa el frontend
  banco: String,
  titular: String,
  numero: String,
  montoWLD: Number,
  montoCOP: Number,
  verified: Boolean,
  nullifier: String,
  estado: { type: String, default: "pendiente" },
  creada_en: String,
  actualizada_en: String,
  status_history: [
    {
      at: String,
      to: String,
    },
  ],
  wld_tx_id: String,
});

const Counter = mongoose.model("Counter", counterSchema);
const Order = mongoose.model("Order", orderSchema);

async function getNextOrderId() {
  const doc = await Counter.findOneAndUpdate(
    { key: "order" },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return doc.value;
}

// ==============================
// Helpers JWT admin
// ==============================
function createAdminToken() {
  // payload mínimo: solo rol
  return jwt.sign({ role: "admin" }, ADMIN_JWT_SECRET, { expiresIn: "24h" });
}

// ==============================
// 🛡 Helper: validación de admin (solo JWT)
// ==============================
function isAdminAuthenticated(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    // Solo aceptamos si el rol es "admin"
    return Boolean(payload && payload.role === "admin");
  } catch (err) {
    console.warn("JWT admin inválido:", err.message);
    return false;
  }
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

    const verifyRes = await verifyCloudProof(payload, APP_ID, action, signal);

    console.log("🔹 Resultado verifyCloudProof:", verifyRes);

    if (verifyRes.success) {
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
    if (cachedRate && now - lastFetchTime < 60_000) {
      return res.json({ ...cachedRate, cached: true });
    }

    let wldUsd = 0.699;
    let usdCop = 3719;
    let wldCopBruto = wldUsd * usdCop;

    let wldFromFallback = true;
    let usdCopFromFallback = true;

    try {
      const r = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=worldcoin-wld&vs_currencies=usd,cop"
      );
      const j = await r.json();

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
// 🔑 LOGIN ADMIN (JWT)
// ==============================
app.post("/api/admin/login", async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin || String(pin) !== String(OPERATOR_PIN)) {
      return res.status(401).json({ ok: false, error: "PIN inválido" });
    }

    const token = createAdminToken();

    return res.json({
      ok: true,
      token,
    });
  } catch (err) {
    console.error("❌ Error en /api/admin/login:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 📦 CREAR ORDEN
// ==============================
app.post("/api/orders", async (req, res) => {
  try {
    const {
      banco,
      titular,
      numero,
      montoWLD,
      montoCOP,
      verified,
      nullifier,
      wld_tx_id,
    } = req.body;

    const bancosPermitidos = ["Nequi", "Llave Bre-B"];
    if (!bancosPermitidos.includes(banco)) {
      return res.status(400).json({ ok: false, error: "Banco no permitido" });
    }

    if (!verified || !nullifier) {
      return res.status(400).json({
        ok: false,
        error: "Orden sin verificación World ID",
      });
    }

    // 🔹 Conversión y validación de monto mínimo
    const montoWldNumber = Number(montoWLD || 0);
    if (!Number.isFinite(montoWldNumber) || montoWldNumber < 1) {
      return res.status(400).json({
        ok: false,
        error: "El monto mínimo por orden es de 1 WLD.",
      });
    }

    // 🔒 LIMITES POR NULLIFIER (solo cantidad de órdenes por día)
    const nullifierStr = String(nullifier);

    // Inicio del día (00:00) en ISO
    const hoy = new Date();
    const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    const inicioHoyISO = inicioHoy.toISOString();

    // Todas las órdenes de este usuario (nullifier) desde hoy 00:00
    const ordersToday = await Order.find({
      nullifier: nullifierStr,
      creada_en: { $gte: inicioHoyISO },
    }).lean();

    const totalOrdersToday = ordersToday.length;

    if (totalOrdersToday >= MAX_ORDERS_PER_NULLIFIER_PER_DAY) {
      return res.status(429).json({
        ok: false,
        error:
          "Has alcanzado el número máximo de órdenes permitidas por hoy. Intenta nuevamente mañana.",
      });
    }

    // ✅ Si pasa las validaciones, creamos la orden
    const ahora = new Date().toISOString();
    const newId = await getNextOrderId();

    const nueva = await Order.create({
      id: newId,
      banco,
      titular,
      numero,
      montoWLD: montoWldNumber,
      montoCOP: Number(montoCOP),
      verified: Boolean(verified),
      nullifier: nullifierStr,
      estado: "pendiente",
      creada_en: ahora,
      actualizada_en: ahora,
      wld_tx_id: wld_tx_id || null,
    });

    res.json({ ok: true, orden: nueva });
  } catch (err) {
    console.error("❌ Error en POST /api/orders:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ==============================
// 📦 OBTENER ORDEN POR ID
// ==============================
app.get("/api/orders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const orden = await Order.findOne({ id }).lean();

    if (!orden) {
      return res.status(404).json({ ok: false, error: "Orden no encontrada" });
    }

    res.json(orden);
  } catch (err) {
    console.error("❌ Error en GET /api/orders/:id:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 🛠 ADMIN — Listar órdenes (POST /api/orders-admin)
// (Compatibilidad, pero ahora también exige autenticación)
// ==============================
app.post("/api/orders-admin", async (req, res) => {
  try {
    if (!isAdminAuthenticated(req)) {
      return res.status(403).json({ ok: false, error: "No autorizado" });
    }

    const orders = await Order.find().sort({ id: -1 }).lean();
    return res.json(orders);
  } catch (err) {
    console.error("Error en POST /api/orders-admin:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 🛠 ADMIN — Listar órdenes (GET con JWT)
// ==============================
app.get(["/rs-admin", "/api/orders-admin"], async (req, res) => {
  try {
    if (!isAdminAuthenticated(req)) {
      return res
        .status(403)
        .json({ ok: false, error: "No autorizado (admin)" });
    }

    const orders = await Order.find().sort({ id: -1 }).lean();
    return res.json(orders);
  } catch (err) {
    console.error("❌ Error en GET /api/orders-admin:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 🛠 ADMIN — Cambiar estado de una orden
// ==============================
app.put("/api/orders/:id/estado", async (req, res) => {
  try {
    const estado = req.body.estado;

    if (!isAdminAuthenticated(req)) {
      return res
        .status(403)
        .json({ ok: false, error: "No autorizado (admin)" });
    }

    const validos = [
      "pendiente",
      "enviada",
      "recibida_wld",
      "pagada",
      "rechazada",
    ];
    if (!validos.includes(estado)) {
      return res.status(400).json({ ok: false, error: "Estado inválido" });
    }

    const id = Number(req.params.id);
    const orden = await Order.findOne({ id });

    if (!orden) {
      return res.status(404).json({ ok: false, error: "Orden no encontrada" });
    }

    orden.estado = estado;
    orden.actualizada_en = new Date().toISOString();

    if (!Array.isArray(orden.status_history)) {
      orden.status_history = [];
    }
    orden.status_history.push({ at: new Date().toISOString(), to: estado });

    await orden.save();

    res.json({ ok: true, orden });
  } catch (err) {
    console.error("❌ Error en PUT /api/orders/:id/estado:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// START
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Backend listo en puerto ${PORT}`);
});
