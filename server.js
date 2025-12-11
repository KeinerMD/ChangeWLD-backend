// ==============================
// 🚀 ChangeWLD Backend — versión estable 2025 (MiniKit) + MongoDB + JWT admin
// ==============================

import dotenv from "dotenv";
import path from "path";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ethers } from "ethers"; // ← NECESARIO para verificar firmas
import { getCachedRate, startRateRefresher } from "./services/rateService.js";

// desde minikit-js
import { verifyCloudProof, verifySiweMessage } from "@worldcoin/minikit-js";

// si usas worldchain.js:
import { getWldBalance } from "./worldchain.js";

// ABI del token WLD (ERC20)
import { WLD_ABI } from "./wldAbi.js";

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

// 🔹 World Chain (para autoCheckWldReceipts)
const WORLDCHAIN_RPC_URL =
  process.env.WORLDCHAIN_RPC_URL || process.env.WORLDCHAIN_RPC || "";
const WLD_TOKEN_ADDRESS =
  process.env.WLD_TOKEN_ADDRESS ||
  process.env.VITE_WLD_TOKEN_ADDRESS ||
  "";

if (!WORLDCHAIN_RPC_URL) {
  console.warn("⚠️ WORLDCHAIN_RPC_URL no configurado en backend.");
}
if (!WLD_TOKEN_ADDRESS) {
  console.warn("⚠️ WLD_TOKEN_ADDRESS no configurado en backend.");
}
if (!WALLET_DESTINO) {
  console.warn("⚠️ WALLET_DESTINO no configurado en backend.");
}

const worldchainProvider = WORLDCHAIN_RPC_URL
  ? new ethers.JsonRpcProvider(WORLDCHAIN_RPC_URL)
  : null;

const wldInterface =
  WLD_TOKEN_ADDRESS && WLD_ABI && WLD_ABI.length
    ? new ethers.Interface(WLD_ABI)
    : null;

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

function hashNonce(nonce) {
  return crypto
    .createHmac("sha256", ADMIN_JWT_SECRET)
    .update(String(nonce))
    .digest("hex");
}

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
  // 🔹 Fecha “contable” para inventario diario (YYYY-MM-DD)
  inventario_fecha: String,
  // 🔹 Ganancia de la casa en COP para esta orden
  ganancia_cop: Number,
});

// 👤 Usuario con World ID + wallet linkeada
const userSchema = new mongoose.Schema({
  nullifier: { type: String, unique: true },
  walletAddress: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

userSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Counter = mongoose.model("Counter", counterSchema);
const Order = mongoose.model("Order", orderSchema);
const User = mongoose.model("User", userSchema);

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
// 🕒 Horario Colombia + regla de inventario
// ==============================

// 🇨🇴 Colombia está en UTC-5 sin cambios de horario
const COLOMBIA_UTC_OFFSET_MIN = -5 * 60;

function getColombiaNow() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + COLOMBIA_UTC_OFFSET_MIN * 60000);
}

// Calcula la fecha de inventario (YYYY-MM-DD) según horario laboral
// Lun–Jue: después de 5 pm → día siguiente
// Viernes: después de 5 pm → sábado
// Sábado: después de 3 pm → lunes
// Domingo: siempre lunes
function calcularInventarioFecha(nowColombia) {
  const d = new Date(nowColombia); // copia
  const day = d.getDay(); // 0=Dom,1=Lun,...,6=Sab
  const hour = d.getHours();
  const minute = d.getMinutes();

  const toISODate = (date) => date.toISOString().slice(0, 10); // YYYY-MM-DD

  // Domingo → siempre se pasa al lunes
  if (day === 0) {
    const monday = new Date(d);
    monday.setDate(monday.getDate() + 1);
    return toISODate(monday);
  }

  // Lunes a jueves (1–4)
  if (day >= 1 && day <= 4) {
    // Después de las 5:00 pm → siguiente día
    if (hour > 17 || (hour === 17 && minute >= 0)) {
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      return toISODate(next);
    }
    // Dentro del horario → mismo día
    return toISODate(d);
  }

  // Viernes (5)
  if (day === 5) {
    // Después de las 5:00 pm → se cuenta para el sábado
    if (hour > 17 || (hour === 17 && minute >= 0)) {
      const saturday = new Date(d);
      saturday.setDate(saturday.getDate() + 1); // viernes +1 = sábado
      return toISODate(saturday);
    }
    return toISODate(d);
  }

  // Sábado (6)
  if (day === 6) {
    // Después de las 3:00 pm → se cuenta para el lunes
    if (hour > 15 || (hour === 15 && minute >= 0)) {
      const monday = new Date(d);
      monday.setDate(monday.getDate() + 2); // sábado +2 = lunes
      return toISODate(monday);
    }
    // Antes / hasta las 3 pm → se cuenta para el sábado
    return toISODate(d);
  }

  // Fallback
  return toISODate(d);
}

// ==============================
// 🔧 Helper para comparar montos en WLD con 18 decimales
// ==============================
function toTokenUnitsBigInt(amountStr, decimals = 18) {
  const [intPartRaw, decPartRaw] = String(amountStr).split(".");
  const intPart = intPartRaw || "0";
  const decPart = (decPartRaw || "").padEnd(decimals, "0").slice(0, decimals);

  const base = 10n ** BigInt(decimals);
  return BigInt(intPart) * base + BigInt(decPart || "0");
}

// ==============================
// 🔁 autoCheckWldReceipts: marcar órdenes como 'recibida_wld'
// cuando se detecta en World Chain la transferencia correcta
// ==============================
async function checkPendingWldReceipts() {
  if (!worldchainProvider || !WLD_TOKEN_ADDRESS || !WALLET_DESTINO || !wldInterface) {
    return;
  }

  // Órdenes que todavía no se han marcado como recibidas
  const pendientes = await Order.find({
    estado: { $in: ["pendiente", "enviada"] },
    wld_tx_id: { $ne: null },
  })
    .sort({ id: 1 })
    .lean();

  if (!pendientes.length) return;

  console.log(`🔍 Revisando ${pendientes.length} órdenes pendientes para WLD recibidos...`);

  const expectedToken = WLD_TOKEN_ADDRESS.toLowerCase();
  const expectedDestino = WALLET_DESTINO.toLowerCase();

  for (const ord of pendientes) {
    try {
      const txHash = ord.wld_tx_id;
      if (!txHash) continue;

      const receipt = await worldchainProvider.getTransactionReceipt(txHash);

      // Si aún no hay receipt o falló, continuamos esperando
      if (!receipt || receipt.status !== 1) {
        continue;
      }

      const logs = receipt.logs || [];
      const expectedFrom = (ord.nullifier || "").toLowerCase();
      const expectedValue = toTokenUnitsBigInt(String(ord.montoWLD || 0), 18);

      let match = false;

      for (const log of logs) {
        if (!log.address || log.address.toLowerCase() !== expectedToken) {
          continue;
        }

        let parsed;
        try {
          parsed = wldInterface.parseLog(log);
        } catch {
          continue;
        }

        if (parsed.name !== "Transfer") continue;

        const from =
          (parsed.args.from || parsed.args[0] || "").toLowerCase();
        const to = (parsed.args.to || parsed.args[1] || "").toLowerCase();
        const valueBig = BigInt(
          parsed.args.value?.toString() || parsed.args[2]?.toString() || "0"
        );

        // Debe ser un transfer hacia WALLET_DESTINO, desde el usuario (opcional) y por el monto exacto
        if (to === expectedDestino && valueBig === expectedValue) {
          if (!expectedFrom || from === expectedFrom) {
            match = true;
            break;
          }
        }
      }

      if (!match) {
        continue;
      }

      const nowIso = new Date().toISOString();

      await Order.updateOne(
        { id: ord.id },
        {
          $set: {
            estado: "recibida_wld",
            actualizada_en: nowIso,
          },
          $push: {
            status_history: { at: nowIso, to: "recibida_wld" },
          },
        }
      );

      console.log(
        `🟣 Orden #${ord.id} marcada automáticamente como 'recibida_wld' (tx ${txHash})`
      );
    } catch (err) {
      console.error(`❌ Error autoCheck en orden #${ord.id}:`, err.message);
    }
  }
}

function startAutoCheckWldReceipts() {
  if (!worldchainProvider || !WLD_TOKEN_ADDRESS || !WALLET_DESTINO || !wldInterface) {
    console.warn(
      "⚠️ autoCheckWldReceipts desactivado: falta RPC, token, destino o ABI."
    );
    return;
  }

  console.log(
    "🟣 autoCheckWldReceipts activo: revisando WLD recibidos cada 30 segundos."
  );

  // Primera pasada inmediata
  checkPendingWldReceipts().catch((err) =>
    console.error("❌ Error inicial en autoCheckWldReceipts:", err)
  );

  // Luego cada 30s
  setInterval(() => {
    checkPendingWldReceipts().catch((err) =>
      console.error("❌ Error en autoCheckWldReceipts:", err)
    );
  }, 30_000);
}

// ==============================
// ROOT
// ==============================
app.get("/", (_, res) => res.send("🚀 ChangeWLD backend OK"));

// ==============================
// 🔐 SIWE: obtener nonce
// ==============================
app.get("/api/wallet-auth/nonce", (req, res) => {
  try {
    const nonce = crypto.randomBytes(16).toString("hex"); // 32 chars
    const signedNonce = hashNonce(nonce);

    return res.json({
      ok: true,
      nonce,
      signedNonce,
    });
  } catch (err) {
    console.error("❌ Error generando nonce SIWE:", err);
    return res
      .status(500)
      .json({ ok: false, error: "No se pudo generar nonce" });
  }
});

// ==============================
// 🔐 SIWE: completar login de billetera
// ==============================
app.post("/api/wallet-auth/complete", async (req, res) => {
  try {
    const { nonce, signedNonce, finalPayloadJson } = req.body || {};

    if (!nonce || !signedNonce || !finalPayloadJson) {
      return res
        .status(400)
        .json({ ok: false, error: "Faltan campos en el body" });
    }

    const expectedSignedNonce = hashNonce(nonce);
    if (signedNonce !== expectedSignedNonce) {
      console.log("❌ signedNonce inválido");
      return res.status(401).json({ ok: false, error: "Nonce inválido" });
    }

    let finalPayload;
    try {
      finalPayload = JSON.parse(finalPayloadJson);
    } catch (err) {
      console.log("❌ finalPayloadJson no es JSON válido");
      return res.status(400).json({ ok: false, error: "Payload inválido" });
    }

    const result = await verifySiweMessage(finalPayload, nonce);

    if (!result.isValid || !result.siweMessageData?.address) {
      console.log("❌ SIWE no válido");
      return res
        .status(401)
        .json({ ok: false, error: "SIWE inválido o sin address" });
    }

    const walletAddress = result.siweMessageData.address;

    // Opcional: crear un token de sesión para esa wallet
    const walletToken = jwt.sign(
      { role: "wallet", walletAddress },
      ADMIN_JWT_SECRET,
      { expiresIn: "24h" }
    );

    return res.json({
      ok: true,
      walletAddress,
      walletToken,
    });
  } catch (err) {
    console.error("❌ Error en /api/wallet-auth/complete:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Error interno" });
  }
});

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
// 🔗 VINCULAR WALLET A NULLIFIER
// ==============================
app.post("/api/wallet/link", async (req, res) => {
  try {
    const { nullifier, address, message, signature } = req.body || {};

    if (!nullifier || !address || !message || !signature) {
      return res.status(400).json({
        ok: false,
        error: "Faltan datos (nullifier, address, message, signature).",
      });
    }

    // 1️⃣ Verificar firma: que la firma corresponda a esa address
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch (err) {
      console.error("Error verificando firma:", err.message);
      return res.status(400).json({
        ok: false,
        error: "Firma inválida.",
      });
    }

    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(400).json({
        ok: false,
        error: "La firma no corresponde a la dirección proporcionada.",
      });
    }

    // 2️⃣ Guardar / actualizar usuario en Mongo
    const nullifierStr = String(nullifier);

    const user = await User.findOneAndUpdate(
      { nullifier: nullifierStr },
      { walletAddress: address },
      { new: true, upsert: true }
    );

    // 3️⃣ (Opcional) leer saldo al vuelo
    let balanceWLD = 0;
    try {
      balanceWLD = await getWldBalance(address);
    } catch (err) {
      console.warn("No se pudo leer saldo en World Chain:", err.message);
    }

    return res.json({
      ok: true,
      wallet: address,
      balanceWLD,
      userId: user._id,
    });
  } catch (err) {
    console.error("❌ Error en /api/wallet/link:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 🔄 ACTUALIZAR BALANCE POR NULLIFIER
// ==============================
app.get("/api/user/balance", async (req, res) => {
  try {
    const { nullifier } = req.query || {};
    if (!nullifier) {
      return res.status(400).json({ ok: false, error: "nullifier requerido" });
    }

    const user = await User.findOne({ nullifier: String(nullifier) }).lean();

    if (!user || !user.walletAddress) {
      return res.json({
        ok: true,
        wallet: null,
        balanceWLD: 0,
      });
    }

    const balance = await getWldBalance(user.walletAddress);

    return res.json({
      ok: true,
      wallet: user.walletAddress,
      balanceWLD: balance,
    });
  } catch (err) {
    console.error("❌ Error en /api/user/balance:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 💰 Obtener balance WLD en World Chain (por address directa)
// ==============================
app.get("/api/wallet-balance", async (req, res) => {
  try {
    const address = String(req.query.address || "").trim();

    if (!address || !address.startsWith("0x") || address.length < 20) {
      return res.status(400).json({ ok: false, error: "Address inválida" });
    }

    const balance = await getWldBalance(address); // número en WLD

    return res.json({
      ok: true,
      balanceWLD: balance,
    });
  } catch (err) {
    console.error("❌ Error en /api/wallet-balance:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "No se pudo leer el balance",
    });
  }
});

// ==============================
// 💱 API RATE (World App Get Prices)
// ==============================
app.get("/api/rate", async (_, res) => {
  try {
    const rate = await getCachedRate();
    return res.json({ ok: true, ...rate });
  } catch (err) {
    console.error("❌ Fatal en /api/rate:", err);
    return res.status(500).json({
      ok: false,
      error: "Rate fatal",
      detail: err.message,
    });
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

    const nullifierStr = String(nullifier);

    // 🔒 LIMITES POR NULLIFIER (solo cantidad de órdenes por día natural en Colombia)
    const ahoraColombia = getColombiaNow();
    const inicioHoyCol = new Date(ahoraColombia);
    inicioHoyCol.setHours(0, 0, 0, 0);
    const inicioHoyISO = inicioHoyCol.toISOString();

    const ordersToday = await Order.find({
      nullifier: nullifierStr,
      creada_en: { $gte: inicioHoyISO },
    }).lean();

    if (ordersToday.length >= MAX_ORDERS_PER_NULLIFIER_PER_DAY) {
      return res.status(429).json({
        ok: false,
        error:
          "Has alcanzado el número máximo de órdenes permitidas por hoy. Intenta nuevamente mañana.",
      });
    }

    // ✅ Si pasa las validaciones, calculamos tiempos e inventario
    const ahoraISO = ahoraColombia.toISOString();
    const inventarioFecha = calcularInventarioFecha(ahoraColombia);

    // Ganancia = lo que cobras de spread (usando SPREAD del backend)
    const gananciaCop = (() => {
      const mCop = Number(montoCOP);
      const s = SPREAD; // ej: 0.25
      if (!Number.isFinite(mCop) || s <= 0 || s >= 1) return 0;
      return Number(((mCop * s) / (1 - s)).toFixed(2));
    })();

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
      creada_en: ahoraISO,
      actualizada_en: ahoraISO,
      wld_tx_id: wld_tx_id || null,
      inventario_fecha: inventarioFecha,
      ganancia_cop: gananciaCop,
      status_history: [
        {
          at: ahoraISO,
          to: "pendiente",
        },
      ],
    });

    res.json({ ok: true, orden: nueva });
  } catch (err) {
    console.error("❌ Error en POST /api/orders:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 📦 OBTENER ÓRDENES POR FECHA DE INVENTARIO
// ==============================
app.get("/api/orders-por-dia", async (req, res) => {
  try {
    const { fecha } = req.query || {}; // esperado "YYYY-MM-DD"
    if (!fecha) {
      return res.status(400).json({
        ok: false,
        error: "Parámetro 'fecha' es requerido (YYYY-MM-DD)",
      });
    }

    const orders = await Order.find({ inventario_fecha: fecha })
      .sort({ id: 1 })
      .lean();

    return res.json({
      ok: true,
      fecha,
      count: orders.length,
      orders,
    });
  } catch (err) {
    console.error("❌ Error en GET /api/orders-por-dia:", err);
    return res.status(500).json({ ok: false, error: err.message });
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
// 📦 OBTENER ÓRDENES POR WALLET (HISTORIAL)
// ==============================
app.get("/api/orders-by-wallet", async (req, res) => {
  try {
    const { wallet } = req.query || {};

    if (!wallet) {
      return res
        .status(400)
        .json({ ok: false, error: "wallet requerida en la query" });
    }

    // Usamos el campo "nullifier" para guardar la identidad del usuario.
    // En tu flujo actual, estás enviando la wallet como nullifier desde el frontend.
    const walletStr = String(wallet);

    const orders = await Order.find({
      nullifier: walletStr,
    })
      .sort({ id: -1 })
      .lean();

    return res.json({
      ok: true,
      wallet: walletStr,
      count: orders.length,
      orders,
    });
  } catch (err) {
    console.error("❌ Error en GET /api/orders-by-wallet:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 📦 OBTENER ÓRDENES POR NULLIFIER (historial del usuario)
// ==============================
app.get("/api/orders-by-nullifier", async (req, res) => {
  try {
    const { nullifier } = req.query || {};
    if (!nullifier) {
      return res
        .status(400)
        .json({ ok: false, error: "nullifier requerido" });
    }

    const nullifierStr = String(nullifier);

    const orders = await Order.find({ nullifier: nullifierStr })
      .sort({ id: -1 })
      .limit(50)
      .lean();

    return res.json({
      ok: true,
      orders,
    });
  } catch (err) {
    console.error("❌ Error en GET /api/orders-by-nullifier:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// 🛠 ADMIN — Listar órdenes (POST /api/orders-admin)
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

// Inicia el refresco periódico de la tasa WLD/COP desde World App
startRateRefresher();

// Inicia el auto-check de recibos WLD
startAutoCheckWldReceipts();

// ==============================
// START
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Backend listo en puerto ${PORT}`);
});
