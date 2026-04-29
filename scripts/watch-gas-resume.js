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

const sourceRunPaths = String(readOption("sourceRun") ?? "logs/burst-500-next-current-run.json")
  .split(",")
  .map((item) => resolve(item.trim()))
  .filter(Boolean);
const totalTarget = Number(readOption("totalTarget") ?? 500);
const maxBaseFeeGwei = Number(readOption("maxBaseFeeGwei") ?? 1.55);
const checkSeconds = Number(readOption("checkSeconds") ?? 60);
const minConfirmingRpcs = Number(readOption("minConfirmingRpcs") ?? 2);
const mintStartGwei = String(readOption("mintStartGwei") ?? "2.0");
const mintMaxGwei = String(readOption("mintMaxGwei") ?? "2.0");
const mintMaxUsd = String(readOption("mintMaxUsd") ?? "0.105");
const mintEthUsd = String(readOption("mintEthUsd") ?? "2279.63");
const logPath = resolve(readOption("log") ?? `logs/gas-watch-${Date.now()}.jsonl`);
mkdirSync(dirname(logPath), { recursive: true });

log({ event: "start", address: account.address, sourceRunPaths, totalTarget, maxBaseFeeGwei, checkSeconds, mintStartGwei, mintMaxGwei, mintMaxUsd, mintEthUsd, rpcCount: clients.length });

while (true) {
  try {
    const state = await readChainState();
    const accepted = await countAcceptedFromSourceRun();
    const remaining = Math.max(0, totalTarget - accepted);
    const usableRpcs = state.rpcStates.filter((item) => !item.error);
    const cleanRpcs = usableRpcs.filter((item) => item.pendingDelta === 0);
    const noPending = cleanRpcs.length >= minConfirmingRpcs;
    const noncesAgree = cleanRpcs.length >= minConfirmingRpcs && new Set(cleanRpcs.map((item) => `${item.latest}:${item.pending}`)).size === 1;
    const gasOk = state.baseFeeGwei !== null && state.baseFeeGwei <= maxBaseFeeGwei;

    log({
      event: "tick",
      baseFeeGwei: state.baseFeeGwei,
      gasOk,
      noPending,
      noncesAgree,
      accepted,
      remaining,
      rpcStates: state.rpcStates,
      cleanRpcCount: cleanRpcs.length
    });

    if (remaining <= 0) {
      log({ event: "done", reason: "target_already_met", accepted, remaining });
      break;
    }

    if (gasOk && noPending && noncesAgree) {
      const run = startMint(remaining);
      log({ event: "launched", accepted, remaining, ...run });
      break;
    }
  } catch (error) {
    log({ event: "error", error: conciseError(error) });
  }

  await sleep(checkSeconds * 1000);
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
      rpcStates.push({
        url,
        latest,
        pending,
        pendingDelta: pending - latest,
        balanceEth: formatEther(balance),
        baseFeeGwei: rpcBaseFee
      });
    } catch (error) {
      rpcStates.push({ url, error: conciseError(error) });
    }
  }

  return { baseFeeGwei, rpcStates };
}

async function countAcceptedFromSourceRun() {
  const accepted = new Set();
  for (const sourceRunPath of sourceRunPaths) {
    if (!existsSync(sourceRunPath)) continue;
    const sourceJsonl = sourceRunPath.endsWith(".jsonl")
      ? sourceRunPath
      : JSON.parse(readFileSync(sourceRunPath, "utf8")).jsonl;
    if (!sourceJsonl || !existsSync(sourceJsonl)) continue;
    const rows = readFileSync(sourceJsonl, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

    const finalRows = new Map();
    for (const row of rows) {
      if ((row.event === "settled" || row.event === "reconciled") && row.txHash) {
        finalRows.set(row.txHash, row);
      }
    }

    for (const row of [...finalRows.values()]) {
      if (row.status === "accepted") accepted.add(row.txHash);
    }

    const broadcastRows = rows.filter((row) => row.event === "attempt" && row.status === "broadcast" && row.txHash && !finalRows.has(row.txHash));
    for (const row of broadcastRows) {
      const owner = await fetchOwner(row.blk);
      if (owner?.toLowerCase() === account.address.toLowerCase()) accepted.add(row.txHash);
    }
  }

  return accepted.size;
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
      // eDMT's block endpoint intermittently returns 404/500 while indexing; just retry later.
    }
  }
  return null;
}

function startMint(target) {
  const ts = timestamp();
  const out = `logs\\burst-500-auto-${ts}.out.log`;
  const err = `logs\\burst-500-auto-${ts}.err.log`;
  const jsonl = `logs\\burst-500-auto-${ts}.jsonl`;
  const summary = `logs\\burst-500-auto-${ts}.summary.json`;
  const args = [
    "scripts/burst-mint.js",
    "--target", String(target),
    "--batch-size", "15",
    "--cursor-burn-gwei", "540000000",
    "--cursor-burn-step-gwei", "10000000",
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

  const outFd = openSync(resolve(out), "a");
  const errFd = openSync(resolve(err), "a");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true
  });
  child.unref();

  const info = { pid: child.pid, out, err, jsonl, summary, target, started: new Date().toISOString() };
  writeFileSync(resolve("logs/burst-500-auto-current-run.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
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
