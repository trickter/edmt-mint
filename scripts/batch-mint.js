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
const client = createPublicClient({ chain: mainnet, transport: http(urls[0]) });
const rpcClients = createRpcClients(urls, account);

const targetSuccesses = Number(readOption(options, "target") ?? 50);
const maxAttempts = Number(readOption(options, "maxAttempts") ?? Math.ceil(targetSuccesses * 1.5));
const maxSeconds = Number(readOption(options, "maxSeconds") ?? targetSuccesses * 60);
const ethUsd = Number(readOption(options, "ethUsd") ?? 2400);
const maxUsd = Number(readOption(options, "maxUsd") ?? 0.3);
const gasLimitMultiplier = Number(readOption(options, "gasLimitMultiplier") ?? 1.12);
const minGwei = Number(readOption(options, "minGwei") ?? 1.8);
const maxGweiHard = Number(readOption(options, "maxGwei") ?? 5);
const stopWindow = Number(readOption(options, "stopWindow") ?? 30);
const stopMinSuccessRate = Number(readOption(options, "stopMinSuccessRate") ?? 0.5);
const stopRaceStreak = Number(readOption(options, "stopRaceStreak") ?? 8);
const rankStart = readOption(options, "rankStart") === undefined ? null : Number(readOption(options, "rankStart"));
const rankWidth = Number(readOption(options, "rankWidth") ?? 650);
const scanLimit = Number(readOption(options, "scanLimit") ?? 1200);
const adaptiveRankStep = Number(readOption(options, "adaptiveRankStep") ?? 0);
const maxRankStart = Number(readOption(options, "maxRankStart") ?? 50_000);
const minBurnEth = Number(readOption(options, "minBurnEth") ?? 0);
const refreshEvery = Number(readOption(options, "refreshEvery") ?? 1);
let gasGwei = Number(readOption(options, "startGwei") ?? 2.4);
let activeRankStart = rankStart;
let cachedRows = [];
let needsRefresh = true;
const logPath = resolve(options.log ?? `logs/batch-${Date.now()}.jsonl`);
const summaryPath = options.summary ? resolve(options.summary) : logPath.replace(/\.jsonl$/i, ".summary.json");

mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(dirname(summaryPath), { recursive: true });

let success = 0;
let attempts = 0;
let raceStreak = 0;
let consecutiveSuccess = 0;
let nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
const start = Date.now();
const usedBlocks = new Set();
const results = [];

log({
  event: "start",
  mode: "batch-mint",
  address: account.address,
  rpcCount: urls.length,
  nonceStart: nonce,
  targetSuccesses,
  maxAttempts,
  maxUsdPerTx: maxUsd,
  ethUsdForCap: ethUsd,
  stopWindow,
  stopMinSuccessRate,
  stopRaceStreak,
  rankStart,
  rankWidth,
  scanLimit,
  adaptiveRankStep,
  maxRankStart,
  minBurnEth,
  refreshEvery
});

while (success < targetSuccesses && attempts < maxAttempts && (Date.now() - start) / 1000 < maxSeconds) {
  if (needsRefresh || cachedRows.length === 0 || (refreshEvery > 0 && attempts > 0 && attempts % refreshEvery === 0)) {
    const desiredScanLimit = Math.max(scanLimit, (activeRankStart ?? 0) + rankWidth + 200);
    cachedRows = await scanCandidates(api, { limit: desiredScanLimit, minBurnGwei: 0 });
    needsRefresh = false;
  }

  let pool = pickPool(cachedRows);
  if (!pool.length) {
    needsRefresh = true;
    const desiredScanLimit = Math.max(scanLimit, (activeRankStart ?? 0) + rankWidth + 200);
    cachedRows = await scanCandidates(api, { limit: desiredScanLimit, minBurnGwei: 0 });
    needsRefresh = false;
    pool = pickPool(cachedRows);
  }
  if (!pool.length) {
    log({ event: "stop", reason: "no_candidates_left", success, attempts });
    break;
  }

    const candidate = pool[Math.floor(Math.random() * Math.min(pool.length, 180))];
  usedBlocks.add(candidate.blk);
  attempts += 1;
  const row = { event: "attempt", attempt: attempts, blk: candidate.blk, burn: candidate.burn, rankStart: activeRankStart, status: "starting" };

  try {
    const beforeOwner = await edmtOwner(candidate.blk);
    if (beforeOwner) {
      row.status = "skip_already_minted_before_send";
      row.owner = beforeOwner;
      shiftRankAfterMiss(row);
      results.push(row);
      log(row);
      continue;
    }

    const tx = await api.buildMint({ tick: "enat", blk: candidate.blk });
    const to = tx.to ?? account.address;
    const data = tx.calldata;
    const value = BigInt(tx.value ?? "0");
    const estGas = await client.estimateGas({ account: account.address, to, value, data });
    const gas = multiplyBigint(estGas, gasLimitMultiplier);
    const allowed = Math.min(maxGweiHard, maxAllowedGwei(gas));
    const block = await client.getBlock({ blockTag: "latest" });
    const baseGwei = block.baseFeePerGas ? Number(formatGwei(block.baseFeePerGas)) : 0;

    if (baseGwei >= allowed) {
      row.status = "skip_basefee_over_cap";
      row.baseGwei = baseGwei.toFixed(3);
      row.allowedGwei = allowed.toFixed(3);
      results.push(row);
      log(row);
      await sleep(3_000);
      continue;
    }

    const targetGwei = Math.min(Math.max(gasGwei, baseGwei + 0.8, minGwei), allowed);
    const maxFeePerGas = parseGwei(targetGwei.toFixed(9));
    const maxPriorityFeePerGas = parseGwei(Math.max(0.05, targetGwei - baseGwei).toFixed(9));
    const maxCostUsd = Number(formatEther(gas * maxFeePerGas)) * ethUsd;
    if (maxCostUsd > maxUsd + 1e-9) throw new Error(`cap math failed $${maxCostUsd.toFixed(4)}`);

    const request = { to, value, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, chainId: 1, type: "eip1559" };
    const signed = await account.signTransaction(request);
    const broadcast = await broadcastSignedTransaction(rpcClients, signed);
    const hash = broadcast.hash;
    row.txHash = hash;
    row.rpcSuccesses = broadcast.successes.length;
    row.nonce = nonce;
    row.gasLimit = gas.toString();
    row.maxFeeGwei = targetGwei.toFixed(3);
    row.maxUsd = maxCostUsd.toFixed(4);
    nonce += 1;

    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    const effectiveGasPrice = receipt.effectiveGasPrice ?? maxFeePerGas;
    const actualUsd = usdCost(receipt.gasUsed, effectiveGasPrice);
    const owner = await waitOwner(candidate.blk);
    row.receiptStatus = receipt.status;
    row.blockNumber = receipt.blockNumber.toString();
    row.gasUsed = receipt.gasUsed.toString();
    row.effectiveGwei = formatGwei(effectiveGasPrice);
    row.actualUsd = actualUsd.toFixed(4);
    row.owner = owner;

    if (receipt.status === "success" && owner?.toLowerCase() === account.address.toLowerCase()) {
      row.status = "accepted";
      success += 1;
      raceStreak = 0;
      consecutiveSuccess += 1;
      gasGwei = Math.max(minGwei, gasGwei - (consecutiveSuccess >= 4 ? 0.1 : 0.05));
    } else {
      row.status = owner ? "rejected_raced" : "included_pending_indexer";
      consecutiveSuccess = 0;
      if (owner) {
        raceStreak += 1;
        gasGwei = Math.min(maxGweiHard, gasGwei + (raceStreak >= 3 ? 0.45 : 0.25));
        shiftRankAfterMiss(row);
      }
    }

    row.successCount = success;
    row.nextGasGwei = gasGwei.toFixed(3);
  } catch (error) {
    row.status = "error";
    row.error = conciseError(error);
    if (/nonce too low|already known|replacement/i.test(row.error)) {
      nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      row.nonceRefreshed = nonce;
    }
    raceStreak += 1;
    consecutiveSuccess = 0;
    gasGwei = Math.min(maxGweiHard, gasGwei + 0.3);
    shiftRankAfterMiss(row);
    row.nextGasGwei = gasGwei.toFixed(3);
  }

  results.push(row);
  log(row);
  if (shouldStopForCompetition()) {
    log({ event: "stop", reason: "competition_too_strong", success, attempts, raceStreak, recent: recentStats() });
    break;
  }
  await sleep(900);
}

const summary = summarize();
log({ event: "summary", ...summary });
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);

function summarize() {
  const accepted = results.filter((row) => row.status === "accepted");
  const raced = results.filter((row) => row.status === "rejected_raced");
  const indexer = results.filter((row) => row.status === "included_pending_indexer");
  const errors = results.filter((row) => row.status === "error");
  const spent = results.reduce((sum, row) => sum + Number(row.actualUsd ?? 0), 0);
  return {
    attempts,
    accepted: accepted.length,
    raced: raced.length,
    includedPendingIndexer: indexer.length,
    errors: errors.length,
    spentUsdApprox: spent.toFixed(4),
    finalGasGwei: gasGwei.toFixed(3),
    nonceEnd: nonce,
    acceptedBlocks: accepted.map((row) => row.blk),
    txs: accepted.map((row) => row.txHash),
    elapsedSec: Math.round((Date.now() - start) / 1000),
    stoppedForCompetition: success < targetSuccesses && shouldStopForCompetition(),
    logPath,
    summaryPath
  };
}

function shouldStopForCompetition() {
  if (raceStreak >= stopRaceStreak) return true;
  const stats = recentStats();
  return stats.total >= stopWindow && stats.successRate < stopMinSuccessRate;
}

function recentStats() {
  const recent = results
    .filter((row) => row.event === "attempt")
    .slice(-stopWindow);
  const accepted = recent.filter((row) => row.status === "accepted").length;
  const total = recent.filter((row) => ["accepted", "rejected_raced", "error"].includes(row.status)).length;
  return {
    total,
    accepted,
    missed: total - accepted,
    successRate: total === 0 ? 1 : accepted / total
  };
}

function pickPool(rows) {
  const startRank = activeRankStart ?? (raceStreak >= 5 ? 650 : raceStreak >= 3 ? 420 : 180);
  const width = Math.max(1, rankWidth);
  const endRank = Math.min(rows.length, startRank + width);
  const pool = rows
    .slice(startRank, endRank)
    .filter((row) => !usedBlocks.has(row.blk) && row.burnEth >= minBurnEth);
  if (pool.length) return pool;
  return rows.filter((row) => !usedBlocks.has(row.blk) && row.burnEth >= minBurnEth);
}

function shiftRankAfterMiss(row) {
  if (adaptiveRankStep <= 0 || activeRankStart === null) return;
  activeRankStart = Math.min(maxRankStart, activeRankStart + adaptiveRankStep);
  needsRefresh = true;
  row.nextRankStart = activeRankStart;
}

async function edmtOwner(blk) {
  try {
    const block = unwrapData(await api.block(blk));
    return block?.minted_by ?? null;
  } catch {
    return null;
  }
}

async function waitOwner(blk, tries = 12) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const owner = await edmtOwner(blk);
    if (owner) return owner;
    await sleep(3_000);
  }
  return null;
}

function multiplyBigint(value, multiplier) {
  const basisPoints = BigInt(Math.ceil(multiplier * 10_000));
  return (value * basisPoints + 9_999n) / 10_000n;
}

function maxAllowedGwei(gasLimit) {
  return maxUsd / ((Number(gasLimit) * ethUsd) / 1e9);
}

function usdCost(gasUsed, effectiveGasPrice) {
  return Number(formatEther(gasUsed * effectiveGasPrice)) * ethUsd;
}

function conciseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/nonce too low/i.test(message)) return "nonce too low";
  if (/already known/i.test(message)) return "already known";
  if (/replacement transaction underpriced/i.test(message)) return "replacement underpriced";
  if (/rate limited|429/i.test(message)) return "rpc rate limited";
  if (/insufficient funds/i.test(message)) return "insufficient funds";
  return message.split("\n")[0].slice(0, 180);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function log(row) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  appendFileSync(logPath, `${line}\n`);

  if (row.event === "attempt") {
    if (row.status === "accepted") {
      console.log(`OK ${row.attempt} success=${row.successCount}/${targetSuccesses} blk=${row.blk} gas=${Number(row.effectiveGwei).toFixed(3)}gwei usd=$${row.actualUsd} next=${row.nextGasGwei} tx=${row.txHash}`);
    } else if (row.status === "rejected_raced" || row.status === "included_pending_indexer") {
      console.log(`MISS ${row.attempt} status=${row.status} success=${success}/${targetSuccesses} blk=${row.blk} gas=${Number(row.effectiveGwei ?? 0).toFixed(3)}gwei usd=$${row.actualUsd ?? "?"} next=${row.nextGasGwei} tx=${row.txHash ?? ""}`);
    } else if (row.status === "error") {
      console.log(`ERR ${row.attempt} success=${success}/${targetSuccesses} blk=${row.blk} error=${row.error} next=${row.nextGasGwei} nonce=${nonce}`);
    } else if (row.status.startsWith("skip_")) {
      console.log(`SKIP ${row.attempt} ${row.status} blk=${row.blk} success=${success}/${targetSuccesses}`);
    }
  } else {
    console.log(line);
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const next = args[i + 1];
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      parsed[rawKey] = next;
      i += 1;
    } else {
      parsed[rawKey] = true;
    }
  }
  return parsed;
}

function readOption(options, camelName) {
  const kebabName = camelName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return options[camelName] ?? options[kebabName];
}
