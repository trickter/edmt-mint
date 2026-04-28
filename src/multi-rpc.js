import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";

export function createRpcClients(rpcUrls, account) {
  if (!rpcUrls?.length) throw new Error("At least one RPC URL is required");
  return rpcUrls.map((url) => ({
    url,
    publicClient: createPublicClient({ chain: mainnet, transport: http(url, { timeout: 10_000, retryCount: 1 }) }),
    walletClient: createWalletClient({ account, chain: mainnet, transport: http(url, { timeout: 10_000, retryCount: 1 }) })
  }));
}

export async function broadcastSignedTransaction(clients, serializedTransaction) {
  const attempts = await Promise.allSettled(
    clients.map(async ({ url, publicClient }) => {
      const hash = await publicClient.sendRawTransaction({ serializedTransaction });
      return { url, hash };
    })
  );

  const successes = attempts
    .filter((attempt) => attempt.status === "fulfilled")
    .map((attempt) => attempt.value);
  if (successes.length > 0) {
    return { hash: successes[0].hash, successes, attempts: summarizeAttempts(attempts, clients) };
  }

  const errors = summarizeAttempts(attempts, clients);
  throw new Error(`All RPC broadcasts failed: ${errors.map((item) => `${item.url}: ${item.error}`).join("; ")}`);
}

export function summarizeAttempts(attempts, clients) {
  return attempts.map((attempt, index) => {
    const url = clients[index]?.url ?? `rpc#${index}`;
    if (attempt.status === "fulfilled") return { url, ok: true, hash: attempt.value.hash };
    return {
      url,
      ok: false,
      error: attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason)
    };
  });
}
