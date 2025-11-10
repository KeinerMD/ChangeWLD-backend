// backend/services/rateService.js
import fetch from "node-fetch";

/**
 * Service de tasas con caché en memoria.
 * - Consulta WLD/USDT en Binance.
 * - Consulta USD->COP en open.er-api.
 * - Calcula WLD->COP bruto y con spread.
 * - Mantiene cache por TTL configurable.
 */

const DEFAULT_TTL_MS = Number(process.env.RATE_TTL_SEC || 60) * 1000;
const SPREAD = Number(process.env.SPREAD || "0.15"); // 15% por defecto

let _cache = {
  data: null,        // { wld_usd, usd_cop, wld_cop_bruto, wld_cop_usuario, spread_percent, fecha }
  updatedAt: 0,      // timestamp ms del último fetch correcto
  ttlMs: DEFAULT_TTL_MS,
};

async function fetchBinanceWLDUSD() {
  const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=WLDUSDT");
  if (!r.ok) throw new Error(`Binance WLDUSDT HTTP ${r.status}`);
  const j = await r.json();
  const price = parseFloat(j.price);
  if (!Number.isFinite(price)) throw new Error("Binance devolvió un precio inválido");
  return price;
}

async function fetchUsdCop() {
  const r = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!r.ok) throw new Error(`ER-API USD HTTP ${r.status}`);
  const j = await r.json();
  const cop = j?.rates?.COP;
  if (!Number.isFinite(cop)) throw new Error("ER-API devolvió COP inválido");
  return cop;
}

async function computeRateNow() {
  const [wldUsd, usdCop] = await Promise.all([fetchBinanceWLDUSD(), fetchUsdCop()]);
  const wldCopBruto = wldUsd * usdCop;
  const wldCopUsuario = wldCopBruto * (1 - SPREAD);
  const payload = {
    wld_usd: wldUsd,
    usd_cop: usdCop,
    wld_cop_bruto: Number(wldCopBruto.toFixed(2)),
    wld_cop_usuario: Number(wldCopUsuario.toFixed(2)),
    spread_percent: SPREAD * 100,
    fecha: new Date().toISOString(),
  };
  return payload;
}

export async function getCachedRate({ force = false } = {}) {
  const now = Date.now();
  const isStale = now - _cache.updatedAt > _cache.ttlMs;

  if (!force && _cache.data && !isStale) {
    return { ..._cache.data, cache: true };
  }

  // Intentar actualizar; si falla y hay cache viejo, devolver cache
  try {
    const fresh = await computeRateNow();
    _cache.data = fresh;
    _cache.updatedAt = now;
    return { ...fresh, cache: false };
  } catch (err) {
    console.error("rateService: error actualizando tasa:", err.message);
    if (_cache.data) {
      // devolver cache viejo, marcando que es stale
      return { ..._cache.data, cache: true, stale: true };
    }
    // sin datos previos → propagar error
    throw err;
  }
}

export function startRateRefresher() {
  // Primer intento inmediato para tener datos desde el arranque
  getCachedRate({ force: true }).catch(() => { /* silenciar primer fallo */ });

  const intervalMs = _cache.ttlMs;
  setInterval(() => {
    getCachedRate({ force: true }).catch((err) => {
      console.error("rateService: refresco falló:", err.message);
    });
  }, intervalMs);
}
