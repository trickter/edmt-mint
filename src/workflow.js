import { EdmtApiError, unwrapData } from "./edmt-api.js";
import { broadcastSignedTransaction, createRpcClients } from "./multi-rpc.js";

export async function scanCandidates(api, { limit = 100, minBurnGwei = 0, cursor: startCursor = undefined } = {}) {
  const candidates = [];
  let cursor = startCursor;

  while (candidates.length < limit) {
    const pageLimit = Math.min(100, limit - candidates.length);
    const response = await retryPendingMints(api, { limit: pageLimit, cursor });
    const data = unwrapData(response);
    const items = Array.isArray(data) ? data : data?.items ?? [];

    for (const item of items) {
      if (Number(item.burn ?? 0) >= minBurnGwei) {
        candidates.push(normalizeCandidate(item));
      }
    }

    cursor = data?.next_cursor ?? null;
    if (!cursor || items.length === 0) break;
  }

  return candidates.sort((a, b) => b.burn - a.burn);
}

async function retryPendingMints(api, params) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await api.pendingMints(params);
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof EdmtApiError) || error.isRetryable || /pool timed out|ECONNRESET|fetch failed/i.test(error.message);
      if (!retryable || attempt === 8) break;
      await sleep(Math.min(60_000, 2_500 * attempt));
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function dryRunCandidates(api, candidates, { tick = "enat", maxTx = 1, logger = () => {} } = {}) {
  const rows = [];

  for (const candidate of candidates) {
    if (rows.filter((row) => row.status === "buildable").length >= maxTx) break;

    const row = {
      blk: candidate.blk,
      burn: candidate.burn,
      calldata_text: "",
      txHash: "",
      status: "checking",
      error: ""
    };

    try {
      const block = unwrapData(await api.block(candidate.blk));
      if (block?.minted_by) {
        row.status = "skipped";
        row.error = `already minted by ${block.minted_by}`;
        rows.push(row);
        logger(row);
        continue;
      }
      if (block && block.is_mintable === false) {
        row.status = "skipped";
        row.error = "not mintable";
        rows.push(row);
        logger(row);
        continue;
      }

      const fee = await api.captureFee(candidate.blk);
      const tx = await api.buildMint({ tick, blk: candidate.blk });
      row.status = "buildable";
      row.calldata_text = tx.calldata_text ?? "";
      row.data = tx.calldata ?? "";
      row.value = tx.value ?? "0";
      row.to = tx.to ?? null;
      row.feeRequired = Boolean(fee?.feeRequired);
      row.requiredFeeGwei = String(fee?.requiredFeeGwei ?? "0");
    } catch (error) {
      row.status = "error";
      row.error = describeError(error);
    }

    rows.push(row);
    logger(row);
  }

  return rows;
}

export async function mintBuildableRows(api, rows, { rpcUrl, rpcUrls, privateKey, gasMultiplier = 1.15, maxGasUsd = null, ethUsd = null, fixedGasPriceGwei = null, waitReceipt = false, logger = () => {} } = {}) {
  const urls = rpcUrls?.length ? rpcUrls : rpcUrl ? [rpcUrl] : [];
  if (urls.length === 0) throw new Error("RPC_URL or RPC_URLS is required when using --send");

  const [{ createPublicClient, http, parseGwei }, { privateKeyToAccount }, { mainnet }] = await Promise.all([
    import("viem"),
    import("viem/accounts"),
    import("viem/chains")
  ]);

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(urls[0]) });
  const clients = createRpcClients(urls, account);
  let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  const minted = [];

  for (const row of rows.filter((item) => item.status === "buildable")) {
    const result = { ...row, txHash: "", status: "sending", error: "" };

    try {
      const block = unwrapData(await api.block(row.blk));
      if (block?.minted_by) {
        result.status = "skipped";
        result.error = `already minted by ${block.minted_by}`;
        minted.push(result);
        logger(result);
        continue;
      }

      const tx = await api.buildMint({ tick: "enat", blk: row.blk });
      const to = tx.to ?? account.address;
      const data = tx.calldata;
      const value = BigInt(tx.value ?? "0");
      const gas = multiplyBigint(await publicClient.estimateGas({ account: account.address, to, value, data }), gasMultiplier);
      const fixedGasPrice = fixedGasPriceGwei === null ? null : parseGwei(String(fixedGasPriceGwei));
      const fees = fixedGasPrice === null ? await publicClient.estimateFeesPerGas() : null;
      const maxFeePerGas = fixedGasPrice ?? multiplyBigint(fees.maxFeePerGas, gasMultiplier);
      const maxPriorityFeePerGas = fixedGasPrice ?? multiplyBigint(fees.maxPriorityFeePerGas, gasMultiplier);

      if (maxGasUsd !== null && ethUsd !== null) {
        const maxGasCostUsd = Number(maxWeiToEth(gas * maxFeePerGas)) * ethUsd;
        result.maxGasCostUsd = maxGasCostUsd.toFixed(4);
        if (maxGasCostUsd > maxGasUsd) {
          result.status = "skipped";
          result.error = `estimated max gas $${maxGasCostUsd.toFixed(4)} exceeds cap $${maxGasUsd}`;
          minted.push(result);
          logger(result);
          continue;
        }
      }

      const chainId = await publicClient.getChainId();
      const request = {
        to,
        value,
        data,
        nonce,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        chainId,
        type: "eip1559"
      };
      const serialized = await account.signTransaction(request);
      const broadcast = await broadcastSignedTransaction(clients, serialized);
      const hash = broadcast.hash;

      nonce += 1;
      result.status = waitReceipt ? "broadcast_waiting_receipt" : "broadcast";
      result.txHash = hash;
      result.broadcastRpcs = broadcast.successes.length;
      result.calldata_text = tx.calldata_text ?? result.calldata_text;

      if (waitReceipt) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        result.status = receipt.status === "success" ? "confirmed" : "reverted";
      }
    } catch (error) {
      result.status = "error";
      result.error = describeError(error);
    }

    minted.push(result);
    logger(result);
  }

  return minted;
}

export function describeError(error) {
  if (error instanceof EdmtApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeCandidate(item) {
  return {
    blk: Number(item.blk),
    burn: Number(item.burn ?? 0),
    burnEth: Number(item.burn ?? 0) / 1e9,
    mintedBy: item.minted_by ?? null,
    finalized: Boolean(item.finalized)
  };
}

function multiplyBigint(value, multiplier) {
  const basisPoints = BigInt(Math.ceil(multiplier * 10_000));
  return (value * basisPoints + 9_999n) / 10_000n;
}

function maxWeiToEth(value) {
  return value.toString().padStart(19, "0").replace(/(\d+)(\d{18})$/, "$1.$2");
}
