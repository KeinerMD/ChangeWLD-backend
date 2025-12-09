// backend/services/rateService.js
import fetch from "node-fetch";

/**
 * Service de tasas con caché en memoria usando
 * GET https://app-backend.worldcoin.dev/public/v1/miniapps/prices
 *
 * - Pide precio de WLD en USD y COP
 * - Convierte usando amount + decimals
 * - Aplica SPREAD
 * - Mantiene cache con TTL configurable
 */

const DEFAULT_TTL_MS = Number(process.env.RATE_TTL_SEC || "60") * 1000;
// Usa el mismo SPREAD que en tu server.js (o sobreescríbelo en el .env)
const SPREAD = Number(process.env.SPREAD ?? "0.25");

// Puedes sobreescribir la URL en el .env si algún día cambia
const WORLD_APP_PRICES_URL =
  process.env.WORLD_APP_PRICES_URL ||
  "https://app-backend.worldcoin.dev/public/v1/miniapps/prices";

let _cache = {
  data: null,
  updatedAt: 0,
  ttlMs: DEFAULT_TTL_MS,
};

// Decodifica { amount: "1510763", decimals: 6 } → 1.510763
function decodePrice(obj) {
  if (!obj) return null;
  const amount = Number(obj.amount);
  const decimals = Number(obj.decimals);
  if (!Number.isFinite(amount) || !Number.isFinite(decimals)) return null;
  return amount * 10 ** -decimals;
}

// Llama al endpoint oficial de World App
async function fetchWorldAppPrices() {
  const url =
    `${WORLD_APP_PRICES_URL}` +
    `?cryptoCurrencies=WLD,USDC&fiatCurrencies=USD,COP`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`World App prices HTTP ${res.status}`);
  }

  const json = await res.json();
  const prices = json?.result?.prices;
  if (!prices || !prices.WLD) {
    throw new Error("World App prices sin información de WLD");
  }

  const wldUsdObj = prices.WLD.USD;
  const wldCopObj = prices.WLD.COP;

  const wldUsd = decodePrice(wldUsdObj);
  const wldCop = decodePrice(wldCopObj);

  if (!Number.isFinite(wldCop)) {
    throw new Error("World App devolvió WLD/COP inválido");
  }

  return {
    wldUsd: Number.isFinite(wldUsd) ? wldUsd : null,
    wldCop,
  };
}

async function computeRateNow() {
  const { wldUsd, wldCop } = await fetchWorldAppPrices();

  const wldCopBruto = wldCop;
  const wldCopUsuario = wldCopBruto * (1 - SPREAD);

  let usdCop = null;
  if (wldUsd && wldUsd > 0) {
    usdCop = wldCopBruto / wldUsd;
  }

  const payload = {
    wld_usd: wldUsd,                       // puede ser null si no viene
    usd_cop: usdCop,                       // derivado de WLD/COP y WLD/USD
    wld_cop_bruto: Number(wldCopBruto.toFixed(2)),
    wld_cop_usuario: Number(wldCopUsuario.toFixed(2)),
    spread_percent: SPREAD * 100,
    fuente: "worldapp_get_prices",
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

  try {
    const fresh = await computeRateNow();
    _cache.data = fresh;
    _cache.updatedAt = now;
    return { ...fresh, cache: false };
  } catch (err) {
    console.error("rateService: error actualizando tasa:", err.message);
    if (_cache.data) {
      // Si falla, devolvemos el último valor en cache marcado como stale
      return { ..._cache.data, cache: true, stale: true };
    }
    throw err;
  }
}

export function startRateRefresher() {
  // Primer intento al arrancar el servidor
  getCachedRate({ force: true }).catch((err) => {
    console.error("rateService: primer fetch falló:", err.message);
  });

  // Refresco periódico
  setInterval(() => {
    getCachedRate({ force: true }).catch((err) => {
      console.error("rateService: refresco falló:", err.message);
    });
  }, _cache.ttlMs);
}
