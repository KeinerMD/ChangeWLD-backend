import { ethers } from "ethers";
import { WLD_ABI } from "./wldAbi.js";

// 👇 acepta ambas variantes, por si acaso
const WORLDCHAIN_RPC_URL =
  process.env.WORLDCHAIN_RPC_URL || process.env.WORLDCHAIN_RPC;
const WLD_TOKEN_ADDRESS = process.env.WLD_TOKEN_ADDRESS;

if (!WORLDCHAIN_RPC_URL) {
  console.warn("⚠️ WORLDCHAIN_RPC_URL / WORLDCHAIN_RPC no configurado en .env");
}
if (!WLD_TOKEN_ADDRESS) {
  console.warn("⚠️ WLD_TOKEN_ADDRESS no configurado en .env");
}

const provider = WORLDCHAIN_RPC_URL
  ? new ethers.JsonRpcProvider(WORLDCHAIN_RPC_URL)
  : null;

export async function getWldBalance(address) {
  if (!provider || !WLD_TOKEN_ADDRESS) {
    throw new Error("World Chain no está configurado en el backend.");
  }

  const contract = new ethers.Contract(WLD_TOKEN_ADDRESS, WLD_ABI, provider);
  const raw = await contract.balanceOf(address);

  const rawBig = BigInt(raw.toString());
  const decimals = 18n;
  const divisor = 10n ** decimals;

  const whole = rawBig / divisor;
  const frac = rawBig % divisor;

  const balance =
    Number(whole) + Number(frac) / Number(divisor);

  return balance;
}

