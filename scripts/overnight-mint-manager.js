import "dotenv/config";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createPublicClient, formatEther, formatGwei, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { readConfig, readPrivateKey } from "../src/config.js";

const options = parseArgs(process.argv.slice(2));
const cfg = readConfig();
const account = privateKeyToAccount(readPrivateKey());
const urls = cfg.rpcUrls?.length ? cfg.rpcUrls : [cfg.rpcUrl];
const clients = urls.map((url) => ({
  url,
  client: createPublicClient({ chain: mainnet, transport: http(url, { timeout: 10_000, retryCount: 1 }) })
}));

const totalTarget = Number(readOption("totalTarget") ?? 800);
const chunkSize = Number(readOption("chunkSize") ?? 60);
const maxBaseFeeGwei = Number(readOption("maxBaseFeeGwei") ?? 1.35);
const checkSeconds = Number(readOption("checkSeconds") ?? 60);
const minConfirmingRpcs = Number(readOption("minConfirmingRpcs") ?? 2);
const mintStartGwei = String(readOption("mintStartGwei") ?? "1.45");
const mintMaxGwei = String(readOption("mintMaxGwei") ?? "1.50");
const mintMaxUsd = String(readOption("mintMaxUsd") ?? "0.08");
const mintEthUsd = String(readOption("mintEthUsd") ?? "2279.63");
const cursorBurnStepGwei = Number(readOption("cursorBurnStepGwei") ?? 10_000_000);
const minCursorBurnGwei = Number(readOption("minCursorBurnGwei") ?? 500_000_000);
const maxEmptyBursts = Number(readOption("maxEmptyBursts") ?? 3);
let activeCursorBurnGwei = Number(readOption("cursorBurnGwei") ?? 540_000_000);
const sourceRunPaths = String(readOption("sourceRun") ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => resolve(item));
const logPath = resolve(readOption("log") ?? `logs/overnight-${Date.now()}.jsonl`);
const currentPath = resolve(readOption("current") ?? "logs/overnight-current.json");
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(dirname(currentPath), { recursive: true });

const launchedRunPaths = [];
log({
  event: "start",
  address: account.address,
  totalTarget,
  chunkSize,
  maxBaseFeeGwei,
  mintStartGwei,
  mintMaxGwei,
  mintMaxUsd,
  mintEthUsd,
  activeCursorBurnGwei,
  cursorBurnStepGwei,
  minCursorBurnGwei,
  maxEmptyBursts,
  sourceRunPaths,
  rpcCount: clients.length
});

let emptyBurstStreak = 0;

while (true) {
  const accepted = await countAccepted();
  const remaining = Math.max(0, totalTarget - accepted);
  if (remaining <= 0) {
    log({ event: "done", accepted, remaining });
    break;
  }

  const state = await readChainState();
  const usableRpcs = state.rpcStates.filter((item) => !item.error);
  const cleanRpcs = usableRpcs.filter((item) => item.pendingDelta === 0);
  const noPending = cleanRpcs.length >= minConfirmingRpcs;
  const noncesAgree = cleanRpcs.length >= minConfirmingRpcs && new Set(cleanRpcs.map((item) => `${item.latest}:${item.pending}`)).size === 1;
  const gasOk = state.baseFeeGwei !== null && state.baseFeeGwei <= maxBaseFeeGwei;
  log({
    event: "tick",
    accepted,
    remaining,
    baseFeeGwei: state.baseFeeGwei,
    gasOk,
    noPending,
    noncesAgree,
    cleanRpcCount: cleanRpcs.length,
    rpcStates: state.rpcStates
  });

  if (!gasOk || !noPending || !noncesAgree) {
    await sleep(checkSeconds * 1000);
    continue;
  }

  const target = Math.min(chunkSize, remaining);
  const run = startMint(target);
  launchedRunPaths.push(resolve(run.jsonl));
  log({ event: "launched", accepted, remaining, ...run });
  const code = await waitForExit(run.child);
  const summary = readSummary(run.summary);
  log({ event: "mint_exit", pid: run.pid, code, target, jsonl: run.jsonl, summary });
  if (summary && Number(summary.attempts ?? 0) === 0) {
    emptyBurstStreak += 1;
    const previousCursor = activeCursorBurnGwei;
    activeCursorBurnGwei = Math.max(minCursorBurnGwei, activeCursorBurnGwei - cursorBurnStepGwei);
    log({
      event: "adjust_cursor",
      reason: "empty_burst",
      emptyBurstStreak,
      maxEmptyBursts,
      previousCursor,
      nextCursor: activeCursorBurnGwei
    });

    if (emptyBurstStreak >= maxEmptyBursts || previousCursor === activeCursorBurnGwei) {
      log({
        event: "done",
        reason: "empty_burst_limit",
        accepted: await countAccepted(),
        totalTarget,
        emptyBurstStreak,
        maxEmptyBursts,
        activeCursorBurnGwei,
        minCursorBurnGwei
      });
      break;
    }
  } else {
    emptyBurstStreak = 0;
  }
  await sleep(15_000);
}

async function readChainState() {
  const rpcStates = [];
  let baseFeeGwei = null;
  for (const { url, client } of clients) {
    try {
      const [latest, pending, balance, block] = await Promise.all([
        client.getTransactionCount({ address: account.address }),
        client.getTransactionCount({ address: account.address, blockTag: "pending" }),
        client.getBalance({ address: account.address }),
        client.getBlock({ blockTag: "latest" })
      ]);
      const rpcBaseFee = block.baseFeePerGas ? Number(formatGwei(block.baseFeePerGas)) : null;
      if (baseFeeGwei === null && rpcBaseFee !== null) baseFeeGwei = rpcBaseFee;
      rpcStates.push({ url, latest, pending, pendingDelta: pending - latest, balanceEth: formatEther(balance), baseFeeGwei: rpcBaseFee });
    } catch (error) {
      rpcStates.push({ url, error: conciseError(error) });
    }
  }
  return { baseFeeGwei, rpcStates };
}

async function countAccepted() {
  const accepted = new Set();
  for (const sourcePath of [...sourceRunPaths, ...launchedRunPaths]) {
    const jsonl = resolveJsonlPath(sourcePath);
    if (!jsonl || !existsSync(jsonl)) continue;
    const rows = readRows(jsonl);
    const finalRows = new Map();
    for (const row of rows) {
      if ((row.event === "settled" || row.event === "reconciled") && row.txHash) finalRows.set(row.txHash, row);
    }
    for (const row of [...finalRows.values()]) {
      if (row.status === "accepted") accepted.add(row.txHash);
    }
    const broadcastRows = rows.filter((row) => row.event === "attempt" && row.status === "broadcast" && row.txHash && !finalRows.has(row.txHash));
    const owners = await mapLimit(broadcastRows, 12, async (row) => ({ row, owner: await fetchOwner(row.blk) }));
    for (const { row, owner } of owners) {
      if (owner?.toLowerCase() === account.address.toLowerCase()) accepted.add(row.txHash);
    }
  }
  return accepted.size;
}

function resolveJsonlPath(sourcePath) {
  if (!existsSync(sourcePath)) return null;
  if (sourcePath.endsWith(".jsonl")) return sourcePath;
  try {
    const source = JSON.parse(readFileSync(sourcePath, "utf8"));
    return source.jsonl ? resolve(source.jsonl) : null;
  } catch {
    return null;
  }
}

function readRows(jsonl) {
  const text = readFileSync(jsonl, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function fetchOwner(blk) {
  for (const refresh of [false, true]) {
    try {
      const response = await fetch(`https://api.edmt.io/api/v1/blocks/${blk}${refresh ? "?refresh=true" : ""}`, {
        signal: AbortSignal.timeout(refresh ? 45_000 : 15_000)
      });
      if (!response.ok) continue;
      const json = await response.json();
      const data = json.data ?? json;
      if (data?.minted_by) return data.minted_by;
    } catch {
      // eDMT indexing can lag; count it on the next loop.
    }
  }
  return null;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function startMint(target) {
  const ts = timestamp();
  const out = `logs\\overnight-burst-${ts}.out.log`;
  const err = `logs\\overnight-burst-${ts}.err.log`;
  const jsonl = `logs\\overnight-burst-${ts}.jsonl`;
  const summary = `logs\\overnight-burst-${ts}.summary.json`;
  const args = [
    "scripts/burst-mint.js",
    "--target", String(target),
    "--batch-size", "15",
    "--cursor-burn-gwei", String(activeCursorBurnGwei),
    "--cursor-burn-step-gwei", String(cursorBurnStepGwei),
    "--rank-start", "0",
    "--rank-width", "1000",
    "--scan-limit", "1200",
    "--rank-step", "0",
    "--max-rank-start", "0",
    "--min-burn-eth", "0.5",
    "--start-gwei", mintStartGwei,
    "--min-gwei", "1.3",
    "--max-gwei", mintMaxGwei,
    "--max-usd", mintMaxUsd,
    "--eth-usd", mintEthUsd,
    "--gas-limit-multiplier", "1.0",
    "--min-batch-success-rate", "0.6",
    "--max-low-success-batches", "3",
    "--post-receipt-wait-ms", "30000",
    "--unknown-recheck-wait-ms", "45000",
    "--refresh-every-batches", "999",
    "--log", jsonl,
    "--summary", summary
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ["ignore", openSync(resolve(out), "a"), openSync(resolve(err), "a")],
    windowsHide: true
  });
  const info = { pid: child.pid, out, err, jsonl, summary, target, started: new Date().toISOString() };
  writeFileSync(resolve("logs/overnight-burst-current-run.json"), `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(currentPath, `${JSON.stringify({ pid: process.pid, log: logPath, launchedRunPaths, currentRun: info, totalTarget }, null, 2)}\n`);
  return { ...info, child };
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function readSummary(summaryPath) {
  const path = resolve(summaryPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function conciseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 180);
}

function log(row) {
  writeFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { flag: "a" });
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
