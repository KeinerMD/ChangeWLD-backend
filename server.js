// ChangeWLD Backend v1.0 (estable)
// Seguridad, validaciones y manejo de errores limpio

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

// (opcional, para la fase on-chain real)
const WORLDCHAIN_RPC = process.env.WORLDCHAIN_RPC || "";
const KEYSTORE_PATH = process.env.KEYSTORE_PATH || "";
const KEYSTORE_PASSWORD = process.env.KEYSTORE_PASSWORD || "";
const WLD_TOKEN_ADDRESS = (process.env.WLD_TOKEN_ADDRESS || "").trim();

// ========= APP =========
const app = express();
app.use(helmet());
// ✅ CORS seguro: permite solo tu dominio de frontend
const allowedOrigins = [
  "http://localhost:5173",             // desarrollo local (Vite)
  "https://change-wld.vercel.app"      // dominio de tu app en producción
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

app.use(express.json({ limit: "1mb" }));

// ----------------- STORAGE -----------------
const ORDERS_FILE = path.join(__dirname, "orders.json");

// ✅ Crear el archivo si no existe
function ensureOrdersFile() {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(
      ORDERS_FILE,
      JSON.stringify({ orders: [], lastId: 0 }, null, 2)
    );
    console.log("🆕 Archivo orders.json creado automáticamente.");
  }
}

// ✅ Leer almacenamiento con recuperación automática
function readStore() {
  ensureOrdersFile();
  try {
    const data = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.orders)) {
      console.warn("⚠️ Estructura inválida, se reconstruye orders.json");
      return { orders: [], lastId: 0 };
    }
    return data;
  } catch (err) {
    console.error("⚠️ Error leyendo orders.json:", err.message);
    ensureOrdersFile();
    return { orders: [], lastId: 0 };
  }
}

// ✅ Escribir de forma segura
function writeStore(data) {
  try {
    if (!data || !Array.isArray(data.orders)) {
      console.error("❌ writeStore recibió datos inválidos");
      return;
    }
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Error al escribir orders.json:", err.message);
  }
}

// ----------------- CREAR ORDEN -----------------
app.post("/api/orders", async (req, res) => {
  try {
    const { nombre, correo, banco, titular, numero, montoWLD, montoCOP } = req.body;

    if (!nombre || !correo || !banco || !titular || !numero || !montoWLD || !montoCOP) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    // Leer almacenamiento seguro
    const store = readStore();

    if (!store.orders) store.orders = [];
    if (typeof store.lastId !== "number") store.lastId = 0;

    // Crear la nueva orden
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
      actualizada_en: new Date().toISOString()
    };

    // Insertar al inicio
    store.orders.unshift(nueva);

    // Guardar en disco de forma segura
    writeStore(store);

    // Simular envío instantáneo si está en modo prueba
    if (TEST_MODE) {
      const simulated = { ...nueva };
      simulated.estado = "enviada";
      simulated.tx_hash = `SIMULATED_TX_${Date.now()}`;
      simulated.actualizada_en = new Date().toISOString();

      // Actualizar también en disco
      const updatedStore = readStore();
      updatedStore.orders = [
        simulated,
        ...updatedStore.orders.filter((o) => o.id !== simulated.id)
      ];
      writeStore(updatedStore);

      return res.json({ ok: true, orden: simulated, simulated: true });
    }

    // Si no está en test mode, devolver la orden real
    res.json({ ok: true, orden: nueva });
  } catch (err) {
    console.error("❌ Error creando orden:", err.message);
    res.status(500).json({ error: "Error interno al crear la orden" });
  }
});



// ========= HELPERS DE VALIDACIÓN =========
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeText(s) {
  if (typeof s !== "string") return "";
  return s.trim().replace(/\s+/g, " ").slice(0, 200);
}
function validateCreatePayload(body) {
  const errors = [];

  const nombre = sanitizeText(body?.nombre);
  const correo = sanitizeText(body?.correo).toLowerCase();
  const banco = sanitizeText(body?.banco);
  const titular = sanitizeText(body?.titular);
  const numero = sanitizeText(body?.numero);
  const montoWLD = Number(body?.montoWLD);
  const montoCOP = Number(body?.montoCOP);

  if (!nombre) errors.push("nombre");
  if (!correo) errors.push("correo");
  if (!banco) errors.push("banco");
  if (!titular) errors.push("titular");
  if (!numero) errors.push("numero");

  if (!Number.isFinite(montoWLD) || montoWLD <= 0) errors.push("montoWLD");
  if (!Number.isFinite(montoCOP) || montoCOP <= 0) errors.push("montoCOP");

if (TEST_MODE && errors.length > 0) {
  console.warn("⚠️ TEST_MODE ignorando errores de validación:", errors);
  errors.length = 0;
}

  return {
    ok: errors.length === 0,
    errors,
    data: { nombre, correo, banco, titular, numero, montoWLD, montoCOP },
  };
}

// ========= RUTAS UTILIDAD =========
app.get("/", (_, res) => res.send("🚀 ChangeWLD backend v1.0 OK"));
app.get("/api/health", (_, res) =>
  res.json({ ok: true, test_mode: TEST_MODE, now: new Date().toISOString() })
);
app.get("/api/ping", (_, res) => res.json({ ok: true }));

app.get("/api/config", (_, res) => {
  res.json({
    walletDestino: WALLET_DESTINO,
    spreadPercent: SPREAD * 100,
    testMode: TEST_MODE,
    rpcUrl: WORLDCHAIN_RPC || null,
    wldToken: WLD_TOKEN_ADDRESS || null,
  });
});


// ====== CACHE LOCAL (para estabilidad en Render) ======
let cachedRate = null;
let lastFetchTime = 0;

// ========= TASA WLD → COP =========
app.get("/api/rate", async (_, res) => {
  try {
    // Si hace menos de 60 segundos desde la última consulta, devolver el cache
    const now = Date.now();
    if (cachedRate && now - lastFetchTime < 60_000) {
      console.log("🟢 Usando tasa cacheada");
      return res.json({ ...cachedRate, cached: true });
    }

    console.log("📡 Solicitando precios de Binance y ER-API...");

    // -------- Intentar obtener desde Binance --------
    let wldUsd = null;
    try {
      const binanceResp = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT",
        { agent, timeout: 4000 }
      );
      if (binanceResp.ok) {
        const data = await binanceResp.json();
        wldUsd = parseFloat(data?.price);
        console.log("✅ Binance OK:", wldUsd);
      } else console.warn("⚠️ Binance error:", binanceResp.status);
    } catch (e) {
      console.warn("⚠️ Binance no accesible:", e.message);
    }

    // -------- Intentar obtener USD→COP --------
    let usdCop = null;
    try {
      const fxResp = await fetch("https://open.er-api.com/v6/latest/USD", {
        agent,
        timeout: 4000,
      });
      if (fxResp.ok) {
        const fx = await fxResp.json();
        usdCop = Number(fx?.rates?.COP);
        console.log("✅ ER-API OK:", usdCop);
      } else console.warn("⚠️ ER-API error:", fxResp.status);
    } catch (e) {
      console.warn("⚠️ ER-API no accesible:", e.message);
    }

    // -------- Fallback si algo falló --------
    if (!Number.isFinite(wldUsd)) wldUsd = 2.4;
    if (!Number.isFinite(usdCop)) usdCop = 4100;

    const wldCopBruto = wldUsd * usdCop;
    const wldCopUsuario = wldCopBruto * (1 - SPREAD);

    // -------- Respuesta --------
    cachedRate = {
      ok: true,
      wld_usd: wldUsd,
      usd_cop: usdCop,
      wld_cop_bruto: wldCopBruto,
      wld_cop_usuario: Number(wldCopUsuario.toFixed(2)),
      spread_percent: SPREAD * 100,
      fuente:
        Number.isFinite(wldUsd) && Number.isFinite(usdCop)
          ? "Binance + ER-API"
          : "Fallback local",
      fecha: new Date().toISOString(),
    };
    lastFetchTime = now;

    res.json(cachedRate);
  } catch (e) {
    console.error("💥 Error en /api/rate:", e.message);
    res.status(500).json({
      ok: false,
      error: "Error interno al obtener tasa de cambio",
      detalle: e.message,
    });
  }
});

// ========= CREAR ORDEN =========
app.post("/api/orders", async (req, res) => {
  try {
    const v = validateCreatePayload(req.body);
    if (!v.ok) {
      return res.status(400).json({
        ok: false,
        error: "Campos inválidos o incompletos",
        fields: v.errors,
      });
    }
    if (!WALLET_DESTINO) {
      // permitimos en test mode, pero avisamos
      if (!TEST_MODE) {
        return res
          .status(500)
          .json({ ok: false, error: "WALLET_DESTINO no configurada" });
      }
    }

    const store = readStore();
    const id = ++store.lastId;

    const nueva = {
      id,
      ...v.data,
      walletDestino: WALLET_DESTINO,
      estado: "pendiente", // pendiente -> enviada -> recibida_wld -> pagada | rechazada
      tx_hash: null,
      status_history: [{ at: new Date().toISOString(), to: "pendiente" }],
      creada_en: new Date().toISOString(),
      actualizada_en: new Date().toISOString(),
    };

    // Guardar
    store.orders.unshift(nueva);
    writeStore(store);

    // Simulación (para pruebas locales)
    if (TEST_MODE) {
      const refreshed = readStore();
      const refIdx = refreshed.orders.findIndex((o) => o.id === id);
      if (refIdx !== -1) {
        refreshed.orders[refIdx].estado = "enviada";
        refreshed.orders[refIdx].tx_hash = `SIMULATED_TX_${Date.now()}`;
        refreshed.orders[refIdx].status_history.push({
          at: new Date().toISOString(),
          to: "enviada",
        });
        refreshed.orders[refIdx].actualizada_en = new Date().toISOString();
        writeStore(refreshed);
      }
    }

    const finalStore = readStore();
    const finalOrder = finalStore.orders.find((o) => o.id === id);
    return res.json({ ok: true, orden: finalOrder });
  } catch (err) {
    console.error("create order error:", err);
    res.status(500).json({ ok: false, error: "Error al crear la orden" });
  }
});

// ========= OBTENER UNA ORDEN =========
app.get("/api/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const store = readStore();
  const found = store.orders.find((o) => o.id === id);
  if (!found) return res.status(404).json({ error: "Orden no encontrada" });

  res.json(found);
});

// ========= ADMIN: LISTAR ÓRDENES =========
app.get("/api/orders-admin", (req, res) => {
  const pin = (req.query.pin || "").toString().trim();
  if (pin !== OPERATOR_PIN) {
    return res.status(403).json({ error: "PIN inválido" });
  }
  const store = readStore();
  res.json(store.orders);
});

// ========= ADMIN: CAMBIAR ESTADO =========
app.put("/api/orders/:id/estado", (req, res) => {
  const pin = (req.body?.pin || "").toString().trim();
  if (pin !== OPERATOR_PIN) {
    return res.status(403).json({ error: "PIN inválido" });
  }

  const id = Number(req.params.id);
  const estado = (req.body?.estado || "").trim();

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
  const idx = store.orders.findIndex((o) => o.id === id);
  if (idx === -1) return res.status(404).json({ error: "Orden no encontrada" });

  // 🧱 Asegurarse de que el historial exista
  if (!Array.isArray(store.orders[idx].status_history)) {
    store.orders[idx].status_history = [];
  }

  // ✅ Actualizar orden
  store.orders[idx].estado = estado;
  store.orders[idx].status_history.push({
    at: new Date().toISOString(),
    to: estado,
  });
  store.orders[idx].actualizada_en = new Date().toISOString();

  // Si la orden se marca como pagada y no tiene tx_hash, crear uno simulado
  if (estado === "pagada" && !store.orders[idx].tx_hash) {
    store.orders[idx].tx_hash = `TX_CONFIRMED_${Date.now()}`;
  }

  writeStore(store);

  console.log(`✅ Orden #${id} actualizada a estado: ${estado}`);
  res.json({ ok: true, orden: store.orders[idx] });
});


// ========= MIDDLEWARE 404 & ERROR =========
app.use((_, res) => res.status(404).json({ error: "Ruta no encontrada" }));

// ========= START =========
app.listen(PORT, () => {
  console.log(
    `🚀 ChangeWLD backend v1.0 en puerto ${PORT} (TEST_MODE=${TEST_MODE})`
  );
});
