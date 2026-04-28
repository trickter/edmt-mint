export function readConfig(env = process.env) {
  const rpcUrl = env.RPC_URL || "";
  return {
    apiBase: env.EDMT_API_BASE || "https://api.edmt.io",
    rpcUrl,
    rpcUrls: readRpcUrls(env.RPC_URLS, rpcUrl),
    scanLimit: readInt(env.SCAN_LIMIT, 100),
    maxTx: readInt(env.MAX_TX, 1),
    minBurnGwei: readInt(env.MIN_BURN_GWEI, 0),
    gasMultiplier: readFloat(env.GAS_MULTIPLIER, 1.15)
  };
}

function readRpcUrls(value, fallback) {
  const urls = (value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (urls.length > 0) return [...new Set(urls)];
  return fallback ? [fallback] : [];
}

export function readPrivateKey(env = process.env) {
  const privateKey = env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is required when using --send");
  }
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

function readInt(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFloat(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
