import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, formatEther, formatGwei, http, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { readConfig, readPrivateKey } from "../src/config.js";
import { createEdmtApi, unwrapData } from "../src/edmt-api.js";
import { createRpcClients, broadcastSignedTransaction } from "../src/multi-rpc.js";
import { scanCandidates } from "../src/workflow.js";

const options = parseArgs(process.argv.slice(2));
const cfg = readConfig();
const account = privateKeyToAccount(readPrivateKey());
const api = createEdmtApi({ baseUrl: cfg.apiBase });
const urls = cfg.rpcUrls?.length ? cfg.rpcUrls : [cfg.rpcUrl];
const publicClients = urls.map((url) => ({
  url,
  client: createPublicClient({ chain: mainnet, transport: http(url, { timeout: 10_000, retryCount: 1 }) })
}));
const rpcClients = createRpcClients(urls, account);

const target = Number(readOption("target") ?? 165);
const batchSize = Number(readOption("batchSize") ?? 15);
const minBatchSuccessRate = Number(readOption("minBatchSuccessRate") ?? 0.6);
const maxLowSuccessBatches = Number(readOption("maxLowSuccessBatches") ?? 3);
const rankWidth = Number(readOption("rankWidth") ?? 8000);
const rankStep = Number(readOption("rankStep") ?? 5000);
const maxRankStart = Number(readOption("maxRankStart") ?? 60_000);
const minBurnEth = Number(readOption("minBurnEth") ?? 0.6);
const maxUsd = Number(readOption("maxUsd") ?? 0.105);
const ethUsd = Number(readOption("ethUsd") ?? 2400);
const minGwei = Number(readOption("minGwei") ?? 1.35);
const startGwei = Number(readOption("startGwei") ?? 1.45);
const maxGwei = Number(readOption("maxGwei") ?? 1.7);
const gasLimitMultiplier = Number(readOption("gasLimitMultiplier") ?? 1.12);
const postReceiptWaitMs = Number(readOption("postReceiptWaitMs") ?? 30_000);
const unknownRecheckWaitMs = Number(readOption("unknownRecheckWaitMs") ?? 45_000);
const refreshEveryBatches = Number(readOption("refreshEveryBatches") ?? 5);
const cursorBurnGwei = readOption("cursorBurnGwei");
const cursorBlock = readOption("cursorBlock") ?? "99999999";
const cursorBurnStepGwei = Number(readOption("cursorBurnStepGwei") ?? 10_000_000);
let activeCursorBurnGwei = cursorBurnGwei ? Number(cursorBurnGwei) : null;
let startCursor = activeCursorBurnGwei ? `${activeCursorBurnGwei}:${cursorBlock}` : undefined;
let rankStart = Number(readOption("rankStart") ?? 10_000);
let gasGwei = startGwei;
let lowSuccessStreak = 0;
let cachedCandidates = [];
let cachedRankStart = null;

const logPath = resolve(readOption("log") ?? `logs/burst-${Date.now()}.jsonl`);
const summaryPath = resolve(readOption("summary") ?? logPath.replace(/\.jsonl$/i, ".summary.json"));
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(dirname(summaryPath), { recursive: true });

const usedBlocks = new Set();
const allRows = [];
let totalAccepted = 0;
let nonce = await rpcCall("getTransactionCount", (rpc) => rpc.getTransactionCount({ address: account.address, blockTag: "pending" }));
const startedAt = Date.now();

log({
  event: "start",
  address: account.address,
  nonceStart: nonce,
  rpcCount: urls.length,
  target,
  batchSize,
  rankStart,
  rankWidth,
  startCursor,
  maxUsd,
  minBatchSuccessRate
});

while (totalAccepted < target) {
  const batchNo = Math.floor(allRows.length / batchSize) + 1;
  const rows = await buildAndBroadcastBatch(batchNo);
  if (rows.length === 0) {
    log({ event: "stop", reason: "no_broadcast_rows", totalAccepted, rankStart });
    break;
  }

  await settleBatch(rows);
  await reconcileUnknownRows(rows);
  const accepted = rows.filter((row) => row.status === "accepted").length;
  const raced = rows.filter((row) => row.status === "rejected_raced").length;
  const unknown = rows.filter((row) => row.status === "included_pending_indexer").length;
  totalAccepted += accepted;
  allRows.push(...rows);

  const successRate = accepted / rows.length;
  const batchSummary = {
    event: "batch_summary",
    batchNo,
    broadcasted: rows.length,
    accepted,
    raced,
    unknown,
    successRate,
    totalAccepted,
    rankStart,
    nextGasGwei: gasGwei.toFixed(3),
    spentUsdApprox: rows.reduce((sum, row) => sum + Number(row.actualUsd ?? 0), 0).toFixed(4)
  };
  log(batchSummary);

  if (successRate <= minBatchSuccessRate) {
    lowSuccessStreak += 1;
    const previousRankStart = rankStart;
    if (activeCursorBurnGwei) {
      shiftCursorBurn("batch_success_rate_low", batchNo, successRate);
    } else {
      rankStart = Math.min(maxRankStart, rankStart + rankStep);
    }
    gasGwei = Math.min(maxGwei, gasGwei + 0.1);
    log({
      event: "adjust_rank",
      reason: "batch_success_rate_low",
      batchNo,
      successRate,
      lowSuccessStreak,
      previousRankStart,
      nextRankStart: rankStart,
      nextCursor: startCursor,
      nextGasGwei: gasGwei.toFixed(3)
    });
    const cursorAtFloor = activeCursorBurnGwei && activeCursorBurnGwei <= Math.ceil(minBurnEth * 1e9);
    if (lowSuccessStreak >= maxLowSuccessBatches || (!activeCursorBurnGwei && rankStart >= maxRankStart) || cursorAtFloor) {
      log({ event: "stop", reason: "batch_success_rate_too_low_after_rank_adjust", ...batchSummary, lowSuccessStreak, rankStart });
      break;
    }
    continue;
  }

  lowSuccessStreak = 0;
  if (raced > 0) {
    if (activeCursorBurnGwei) shiftCursorBurn("raced", batchNo, successRate);
    else rankStart = Math.min(maxRankStart, rankStart + rankStep);
  }
  if (accepted >= rows.length * 0.8) gasGwei = Math.max(minGwei, gasGwei - 0.05);
  else gasGwei = Math.min(maxGwei, gasGwei + 0.1);
}

async function reconcileUnknownRows(rows) {
  const unknownRows = rows.filter((row) => row.status === "included_pending_indexer");
  if (unknownRows.length === 0) return;
  await sleep(unknownRecheckWaitMs);
  for (const row of unknownRows) {
    const owner = await waitOwner(row.blk, 4);
    row.owner = owner;
    if (owner?.toLowerCase() === account.address.toLowerCase()) row.status = "accepted";
    else if (owner) row.status = "rejected_raced";
    else row.status = "included_pending_indexer";
    log({ ...row, event: "reconciled" });
  }
}

const summary = summarize();
log({ event: "summary", ...summary });
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);

async function buildAndBroadcastBatch(batchNo) {
  const candidates = await getCandidates(batchNo);
  let pool = candidates
    .slice(rankStart, rankStart + rankWidth)
    .filter((row) => row.burnEth >= minBurnEth && !usedBlocks.has(row.blk));
  if (pool.length < batchSize) {
    cachedCandidates = [];
    const refreshed = await getCandidates(batchNo);
    pool = refreshed
      .slice(rankStart, rankStart + rankWidth)
      .filter((row) => row.burnEth >= minBurnEth && !usedBlocks.has(row.blk));
  }
  shuffle(pool);

  const rows = [];
  for (const candidate of pool) {
    if (rows.length >= batchSize || totalAccepted + rows.length >= target) break;
    usedBlocks.add(candidate.blk);

    const row = {
      event: "attempt",
      batchNo,
      blk: candidate.blk,
      burn: candidate.burn,
      burnEth: candidate.burnEth,
      rankStart,
      status: "preparing"
    };

    try {
      const before = unwrapData(await api.block(candidate.blk));
      if (before?.minted_by) {
        row.status = "skip_already_minted_before_send";
        row.owner = before.minted_by;
        log(row);
        continue;
      }

      const tx = await api.buildMint({ tick: "enat", blk: candidate.blk });
      const to = tx.to ?? account.address;
      const data = tx.calldata;
      const value = BigInt(tx.value ?? "0");
      const gas = multiplyBigint(await rpcCall("estimateGas", (rpc) => rpc.estimateGas({ account: account.address, to, value, data })), gasLimitMultiplier);
      const block = await rpcCall("getBlock", (rpc) => rpc.getBlock({ blockTag: "latest" }));
      const baseGwei = block.baseFeePerGas ? Number(formatGwei(block.baseFeePerGas)) : 0;
      const allowedGwei = Math.min(maxGwei, maxUsd / ((Number(gas) * ethUsd) / 1e9));
      const targetGwei = Math.min(Math.max(gasGwei, baseGwei + 0.75, minGwei), allowedGwei);
      if (targetGwei <= baseGwei) throw new Error(`base fee ${baseGwei.toFixed(3)}gwei over cap ${allowedGwei.toFixed(3)}gwei`);

      const maxFeePerGas = parseGwei(targetGwei.toFixed(9));
      const maxPriorityFeePerGas = parseGwei(Math.max(0.03, targetGwei - baseGwei).toFixed(9));
      const signed = await account.signTransaction({
        to,
        value,
        data,
        nonce,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        chainId: 1,
        type: "eip1559"
      });
      const broadcast = await broadcastSignedTransaction(rpcClients, signed);
      row.status = "broadcast";
      row.txHash = broadcast.hash;
      row.nonce = nonce;
      row.gasLimit = gas.toString();
      row.maxFeeGwei = targetGwei.toFixed(3);
      row.maxUsd = (Number(formatEther(gas * maxFeePerGas)) * ethUsd).toFixed(4);
      row.rpcSuccesses = broadcast.successes.length;
      nonce += 1;
      rows.push(row);
      log(row);
    } catch (error) {
      row.status = "error";
      row.error = conciseError(error);
      log(row);
      if (/nonce/i.test(row.error)) nonce = await rpcCall("getTransactionCount", (rpc) => rpc.getTransactionCount({ address: account.address, blockTag: "pending" }));
    }
  }
  return rows;
}

async function getCandidates(batchNo) {
  const shouldRefresh = cachedCandidates.length === 0 || cachedRankStart !== rankStart || ((batchNo - 1) % refreshEveryBatches === 0);
  if (shouldRefresh) {
    const scanLimit = Math.max(rankStart + rankWidth + 200, Number(readOption("scanLimit") ?? 0));
    cachedCandidates = await scanCandidatesWithRetry(scanLimit, startCursor);
    cachedRankStart = rankStart;
    log({ event: "scan", batchNo, rankStart, rankWidth, scanLimit, candidates: cachedCandidates.length });
  }
  return cachedCandidates;
}

async function scanCandidatesWithRetry(scanLimit, cursor) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await scanCandidates(api, { limit: scanLimit, minBurnGwei: 0, cursor });
    } catch (error) {
      lastError = error;
      log({ event: "scan_error", attempt, error: conciseError(error) });
      await sleep(Math.min(60_000, 5_000 * attempt));
    }
  }
  throw lastError;
}

async function settleBatch(rows) {
  for (const row of rows) {
    try {
      const receipt = await rpcCall("waitForTransactionReceipt", (rpc) => rpc.waitForTransactionReceipt({ hash: row.txHash, timeout: 180_000 }));
      row.receiptStatus = receipt.status;
      row.blockNumber = receipt.blockNumber.toString();
      row.gasUsed = receipt.gasUsed.toString();
      row.effectiveGwei = formatGwei(receipt.effectiveGasPrice);
      row.actualUsd = (Number(formatEther(receipt.gasUsed * receipt.effectiveGasPrice)) * ethUsd).toFixed(4);
    } catch (error) {
      row.status = "receipt_error";
      row.error = conciseError(error);
    }
  }

  await sleep(postReceiptWaitMs);
  for (const row of rows) {
    if (!row.blk || row.status === "receipt_error") continue;
    const owner = await waitOwner(row.blk);
    row.owner = owner;
    if (owner?.toLowerCase() === account.address.toLowerCase()) row.status = "accepted";
    else if (owner) row.status = "rejected_raced";
    else row.status = "included_pending_indexer";
    log({ ...row, event: "settled" });
  }
}

async function waitOwner(blk, tries = 8) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const block = unwrapData(await fetchBlockForOwner(blk, attempt >= Math.floor(tries / 2)));
      const owner = block?.minted_by ?? null;
      if (owner) return owner;
    } catch (error) {
      log({ event: "owner_check_error", blk, attempt: attempt + 1, error: conciseError(error) });
    }
    await sleep(3_000);
  }
  return null;
}

async function fetchBlockForOwner(blk, refresh) {
  if (!refresh) return api.block(blk);
  return api.fetchJson(`/api/v1/blocks/${blk}`, { query: { refresh: "true" }, timeoutMs: 45_000 });
}

function summarize() {
  const accepted = allRows.filter((row) => row.status === "accepted");
  const raced = allRows.filter((row) => row.status === "rejected_raced");
  const unknown = allRows.filter((row) => row.status === "included_pending_indexer");
  const spent = allRows.reduce((sum, row) => sum + Number(row.actualUsd ?? 0), 0);
  return {
    attempts: allRows.length,
    accepted: accepted.length,
    raced: raced.length,
    unknown: unknown.length,
    spentUsdApprox: spent.toFixed(4),
    nonceEnd: nonce,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    acceptedBlocks: accepted.map((row) => row.blk),
    txs: accepted.map((row) => row.txHash),
    logPath,
    summaryPath
  };
}

function shiftCursorBurn(reason, batchNo, successRate) {
  if (!activeCursorBurnGwei) return;
  const previousCursor = startCursor;
  const minCursorBurn = Math.ceil(minBurnEth * 1e9);
  activeCursorBurnGwei = Math.max(minCursorBurn, activeCursorBurnGwei - cursorBurnStepGwei);
  startCursor = `${activeCursorBurnGwei}:${cursorBlock}`;
  rankStart = 0;
  cachedCandidates = [];
  cachedRankStart = null;
  log({ event: "adjust_cursor", reason, batchNo, successRate, previousCursor, nextCursor: startCursor });
}

function multiplyBigint(value, multiplier) {
  const basisPoints = BigInt(Math.ceil(multiplier * 10_000));
  return (value * basisPoints + 9_999n) / 10_000n;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcCall(label, call) {
  const errors = [];
  for (const { url, client: rpc } of publicClients) {
    try {
      return await call(rpc);
    } catch (error) {
      errors.push(`${url}: ${conciseError(error)}`);
    }
  }
  throw new Error(`${label} failed on all RPCs: ${errors.join("; ")}`);
}

function conciseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/nonce too low/i.test(message)) return "nonce too low";
  if (/already known/i.test(message)) return "already known";
  if (/rate limited|429/i.test(message)) return "rpc rate limited";
  if (/insufficient funds/i.test(message)) return "insufficient funds";
  return message.split("\n")[0].slice(0, 180);
}

function log(row) {
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) parsed[key] = inlineValue;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) parsed[key] = args[++i];
    else parsed[key] = true;
  }
  return parsed;
}

function readOption(camelName) {
  const kebabName = camelName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return options[camelName] ?? options[kebabName];
}
