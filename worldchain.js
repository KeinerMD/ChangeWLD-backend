// worldchain.js
import { ethers } from "ethers";
import { WLD_ABI } from "./wldAbi.js";

// 🔗 Config desde .env
export const WORLDCHAIN_RPC_URL =
  process.env.WORLDCHAIN_RPC_URL || process.env.WORLDCHAIN_RPC || "";

export const WLD_TOKEN_ADDRESS =
  process.env.WLD_TOKEN_ADDRESS ||
  process.env.VITE_WLD_TOKEN_ADDRESS ||
  "";

export const WLD_DECIMALS = 18;

if (!WORLDCHAIN_RPC_URL) {
  console.warn("⚠️ WORLDCHAIN_RPC_URL no configurado en .env");
}
if (!WLD_TOKEN_ADDRESS) {
  console.warn("⚠️ WLD_TOKEN_ADDRESS no configurado en .env");
}

const provider = WORLDCHAIN_RPC_URL
  ? new ethers.JsonRpcProvider(WORLDCHAIN_RPC_URL)
  : null;

// =======================
// Helpers de conversión
// =======================

// Convierte BigInt a número en WLD (para saldos razonables está bien)
function formatWld(rawBigInt, decimals = 18n) {
  const divisor = 10n ** decimals;
  const whole = rawBigInt / divisor;
  const frac = rawBigInt % divisor;

  // 4 decimales como máximo
  const frac4 = (frac * 10_000n) / divisor;
  const num = Number(whole) + Number(frac4) / 10_000;

  return num;
}

// =======================
// Balance de WLD
// =======================
export async function getWldBalance(address) {
  if (!provider || !WLD_TOKEN_ADDRESS) {
    throw new Error("World Chain no está configurado en el backend.");
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Dirección de wallet inválida");
  }

  const contract = new ethers.Contract(WLD_TOKEN_ADDRESS, WLD_ABI, provider);
  const raw = await contract.balanceOf(address); // BigInt en v6

  const rawBig = BigInt(raw.toString());
  const balance = formatWld(rawBig, 18n);

  return balance; // número en WLD (ej: 12.3456)
}

// =======================
// Info de transferencia WLD por txHash
// =======================

// Usaremos el ABI de WLD para parsear el evento Transfer
const wldInterface = new ethers.Interface(WLD_ABI);

/**
 * Lee una transacción en World Chain y, si contiene un Transfer de WLD,
 * devuelve info básica:
 *
 *  - status: "pending" | "failed" | "no-transfer" | "confirmed"
 *  - from, to, valueWei (solo cuando está "confirmed")
 *
 * Si aún no hay receipt -> null (sigue pendiente en la red).
 */
export async function getWldTransferInfo(txHash) {
  if (!provider || !WLD_TOKEN_ADDRESS) {
    throw new Error("World Chain no está configurado en el backend.");
  }

  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("txHash inválido");
  }

  const receipt = await provider.getTransactionReceipt(txHash);

  // Aún no minada
  if (!receipt) {
    return null;
  }

  // En ethers v6 status suele ser BigInt (1n = éxito)
  if (receipt.status !== 1 && receipt.status !== 1n) {
    return { status: "failed" };
  }

  const transferEvent = wldInterface.getEvent("Transfer");
  const transferTopic = transferEvent.topicHash;

  const logs = (receipt.logs || []).filter(
    (log) =>
      log.address &&
      log.address.toLowerCase() === WLD_TOKEN_ADDRESS.toLowerCase() &&
      log.topics &&
      log.topics[0] &&
      log.topics[0].toLowerCase() === transferTopic.toLowerCase()
  );

  if (!logs.length) {
    // No hubo Transfer de WLD en esta tx
    return { status: "no-transfer" };
  }

  // Si hay varios, usamos el primero (para tu flujo basta)
  const log = logs[0];

  const parsed = wldInterface.parseLog({
    topics: log.topics,
    data: log.data,
  });

  const from = parsed.args[0];
  const to = parsed.args[1];
  const value = parsed.args[2]; // BigInt en v6

  return {
    status: "confirmed",
    from,
    to,
    valueWei: BigInt(value.toString()),
  };
}
