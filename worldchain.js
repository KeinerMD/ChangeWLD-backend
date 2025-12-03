// worldchain.js
import { ethers } from "ethers";
import { WLD_ABI } from "./wldAbi.js";

const WORLDCHAIN_RPC_URL =
  process.env.WORLDCHAIN_RPC_URL || process.env.WORLDCHAIN_RPC || "";

const WLD_TOKEN_ADDRESS =
  process.env.WLD_TOKEN_ADDRESS ||
  process.env.VITE_WLD_TOKEN_ADDRESS ||
  "";

if (!WORLDCHAIN_RPC_URL) {
  console.warn("⚠️ WORLDCHAIN_RPC_URL no configurado en .env");
}
if (!WLD_TOKEN_ADDRESS) {
  console.warn("⚠️ WLD_TOKEN_ADDRESS no configurado en .env");
}

const provider = WORLDCHAIN_RPC_URL
  ? new ethers.JsonRpcProvider(WORLDCHAIN_RPC_URL)
  : null;

// Convierte BigInt a número en WLD (ojo: para saldos normales está bien)
function formatWld(rawBigInt, decimals = 18n) {
  const divisor = 10n ** decimals;
  const whole = rawBigInt / divisor;
  const frac = rawBigInt % divisor;

  // 4 decimales como máximo
  const frac4 = (frac * 10_000n) / divisor;
  const num = Number(whole) + Number(frac4) / 10_000;

  return num;
}

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
