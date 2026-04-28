#!/usr/bin/env node
import "dotenv/config";
import { createEdmtApi } from "./edmt-api.js";
import { readConfig, readPrivateKey } from "./config.js";
import { toCsv, writeReports } from "./reports.js";
import { dryRunCandidates, mintBuildableRows, scanCandidates } from "./workflow.js";

const command = process.argv[2] ?? "help";
const args = parseArgs(process.argv.slice(3));

try {
  if (command === "help" || args.help) {
    printHelp();
    process.exit(0);
  }

  const config = readConfig();
  const api = createEdmtApi({ baseUrl: config.apiBase });
  const options = {
    limit: readNumberArg(args.limit, config.scanLimit),
    maxTx: readNumberArg(args.maxTx, config.maxTx),
    minBurnGwei: readNumberArg(args.minBurnGwei, config.minBurnGwei),
    gasMultiplier: readNumberArg(args.gasMultiplier, config.gasMultiplier),
    maxGasUsd: readNumberArg(args.maxGasUsd, null),
    ethUsd: readNumberArg(args.ethUsd, null),
    json: Boolean(args.json),
    csv: Boolean(args.csv),
    noLog: Boolean(args.noLog),
    waitReceipt: Boolean(args.waitReceipt)
  };

  if (command === "scan") {
    const candidates = await scanCandidates(api, { limit: options.limit, minBurnGwei: options.minBurnGwei });
    output(candidates, options);
    await maybeWriteReports(candidates, { command, noLog: options.noLog });
  } else if (command === "dry-run") {
    const rows = await buildDryRun(api, options);
    output(rows, options);
    await maybeWriteReports(rows, { command, noLog: options.noLog });
  } else if (command === "mint") {
    const rows = await buildDryRun(api, options);
    if (!args.send) {
      console.log("Dry-run only. Add --send to broadcast real Ethereum mainnet transactions.");
      output(rows, options);
      await maybeWriteReports(rows, { command: "mint-dry-run", noLog: options.noLog });
      process.exit(0);
    }

    const privateKey = readPrivateKey();
    const mintedRows = await mintBuildableRows(api, rows, {
      rpcUrl: config.rpcUrl,
      rpcUrls: config.rpcUrls,
      privateKey,
      gasMultiplier: options.gasMultiplier,
      fixedGasPriceGwei: args.gasGwei ? String(args.gasGwei) : null,
      maxGasUsd: options.maxGasUsd,
      ethUsd: options.ethUsd,
      waitReceipt: options.waitReceipt,
      logger: (row) => console.error(`[${row.status}] blk=${row.blk}${row.txHash ? ` tx=${row.txHash}` : ""}${row.error ? ` ${row.error}` : ""}`)
    });
    output(mintedRows, options);
    await maybeWriteReports(mintedRows, { command: "mint", noLog: options.noLog });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function buildDryRun(api, options) {
  const candidates = await scanCandidates(api, { limit: options.limit, minBurnGwei: options.minBurnGwei });
  return dryRunCandidates(api, candidates, {
    maxTx: options.maxTx,
    logger: (row) => console.error(`[${row.status}] blk=${row.blk} burn=${row.burn}${row.error ? ` ${row.error}` : ""}`)
  });
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) continue;
    const key = toCamel(arg.slice(2));
    const next = rawArgs[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function readNumberArg(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function output(rows, options) {
  if (options.csv) {
    process.stdout.write(toCsv(rows));
    return;
  }
  if (options.json || rows.length > 10) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.table(rows.map((row) => compactRow(row)));
}

function compactRow(row) {
  return {
    blk: row.blk,
    burn: row.burn,
    status: row.status,
    txHash: row.txHash ?? "",
    error: row.error ?? "",
    calldata_text: row.calldata_text ?? ""
  };
}

async function maybeWriteReports(rows, { command, noLog }) {
  if (noLog) return;
  const report = await writeReports(rows, { command });
  console.error(`Wrote ${report.jsonPath} and ${report.csvPath}`);
}

function printHelp() {
  console.log(`eDMT mint CLI

Commands:
  scan                 List pending mint candidates.
  dry-run              Verify candidates and build mint calldata without sending.
  mint                 Dry-run by default; add --send to broadcast transactions.

Options:
  --limit <n>          Number of candidates to scan. Default: SCAN_LIMIT or 100.
  --max-tx <n>         Number of buildable mints to prepare/send. Default: MAX_TX or 1.
  --min-burn-gwei <n>  Minimum block burn in gwei. Default: MIN_BURN_GWEI or 0.
  --gas-multiplier <n> Gas and fee multiplier for --send. Default: GAS_MULTIPLIER or 1.15.
  --gas-gwei <n>       Use a fixed EIP-1559 max fee and priority fee in gwei.
  --max-gas-usd <n>    Skip sending if estimated max gas cost exceeds this USD cap.
  --eth-usd <n>        ETH/USD price to use with --max-gas-usd.
  --send               Broadcast real mainnet transactions for mint command.
  --wait-receipt       Wait for receipts after broadcasting.
  --json               Print JSON.
  --csv                Print CSV.
  --no-log             Do not write logs/*.json and logs/*.csv.
`);
}
